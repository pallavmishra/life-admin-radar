'use strict'
/**
 * One-way radar → Kanban sync.
 *
 *   enqueueDue()  — every tick: items that entered their first reminder
 *                   window (or changed date/checklist since the last push)
 *                   get an `upsert`; completed linked items get a `complete`.
 *   preview()     — the dry run: reads the plist, plans the push, returns the
 *                   exact card JSON that would be written. Writes nothing.
 *   execute()     — the live write of a plan the user has seen. Refuses if
 *                   Kanban Board is running (queues + notifies instead), if
 *                   the plan has guesses the user has not confirmed, or if
 *                   the file changed since the preview.
 *
 * Never reads task state back out of Kanban: the board is read only to
 * find where to put things. Links (item ↔ card id) live in the radar's DB.
 */
const crypto = require('crypto')
const { readKanbanFile, buildNewPlist, writeAtomic, DEFAULT_PATH } = require('./plistFile')
const { planPush } = require('./plan')
const { priorityFor } = require('../status')

const hashChecklist = (list) => crypto.createHash('sha1')
  .update(JSON.stringify(list.map(c => [c.label, !!c.is_done, c.location_hint || '']))).digest('hex')

function createKanbanSync({ store, engine, notifier = null, isRunning, converter, backupDir, log = () => {} }) {
  const db = store.raw
  const plans = new Map() // planId → { info, plan, queueIds, createdAt }

  const settings = () => store.getSettings()
  const plistPath = () => settings().kanbanPlistPath || DEFAULT_PATH
  const overrides = () => { try { return JSON.parse(settings().kanbanFieldOverrides || '{}') } catch (_) { return {} } }
  const checklistFor = (id) => db.prepare('SELECT * FROM checklist_items WHERE item_id = ? ORDER BY position, id').all(id)
  const linkFor = (id) => db.prepare('SELECT * FROM kanban_links WHERE item_id = ?').get(id) || null

  function enqueue(itemId, op, nowIso) {
    const exists = db.prepare(`SELECT 1 FROM kanban_queue WHERE item_id = ? AND op = ? AND status = 'pending'`).get(itemId, op)
    if (exists) return 0
    db.prepare(`INSERT INTO kanban_queue (item_id, op, created_at) VALUES (?, ?, ?)`).run(itemId, op, nowIso)
    return 1
  }

  /** @returns {number} entries newly queued */
  function enqueueDue(clock, { auto = true } = {}) {
    const { today, nowIso } = clock
    const s = settings()
    let n = 0
    store.tx(() => {
      const cands = engine.kanbanCandidates(today, { includeSubscriptions: s.kanbanIncludeSubscriptions === '1' })
      for (const item of cands) {
        const link = linkFor(item.id)
        if (link && link.orphaned) continue
        const h = hashChecklist(checklistFor(item.id))
        if (!link || link.last_due_pushed !== item.due_date || link.last_notes_hash !== h) n += enqueue(item.id, 'upsert', nowIso)
      }
      const done = db.prepare(`SELECT i.id FROM life_items i JOIN kanban_links l ON l.item_id = i.id
        WHERE i.status = 'done' AND l.done_pushed = 0 AND l.orphaned = 0`).all()
      for (const { id } of done) {
        db.prepare(`UPDATE kanban_queue SET status = 'cancelled' WHERE item_id = ? AND op = 'upsert' AND status = 'pending'`).run(id)
        n += enqueue(id, 'complete', nowIso)
      }
      // Done before it was ever pushed → nothing to do on the board.
      db.prepare(`UPDATE kanban_queue SET status = 'cancelled' WHERE status = 'pending' AND op = 'upsert'
        AND item_id IN (SELECT id FROM life_items WHERE status = 'done')`).run()
    })()
    if (auto && s.kanbanAutoPush === '1' && Number(s.kanbanLiveWrites) > 0 && pending().length) autoPush(clock)
    return n
  }

  function pending() {
    return db.prepare(`SELECT q.*, i.title FROM kanban_queue q JOIN life_items i ON i.id = q.item_id
      WHERE q.status = 'pending' ORDER BY q.id`).all()
  }

  function history(limit = 30) {
    return db.prepare(`SELECT q.*, i.title FROM kanban_queue q LEFT JOIN life_items i ON i.id = q.item_id
      WHERE q.status != 'pending' ORDER BY q.id DESC LIMIT ?`).all(limit)
  }

  function buildRequests(rows, choices = {}, today) {
    const byItem = new Map()
    for (const r of rows) {
      const prev = byItem.get(r.item_id)
      // complete wins over upsert for the same item
      if (!prev || r.op === 'complete') byItem.set(r.item_id, r)
    }
    const reqs = []
    for (const [itemId, row] of byItem) {
      const item = db.prepare('SELECT * FROM life_items WHERE id = ?').get(itemId)
      if (!item) continue
      const c = choices[itemId] || {}
      reqs.push({
        item, op: row.op, checklist: checklistFor(itemId), link: linkFor(itemId),
        priority: priorityFor(item, today), manualCardId: c.cardId || null, forceCreate: !!c.forceCreate,
      })
    }
    return reqs
  }

  /**
   * DRY RUN. `opts.itemIds` restricts to some items; `opts.choices` lets the
   * user overrule a match: { [itemId]: { cardId } | { forceCreate: true } }.
   * `opts.all` previews every in-window item, not just the queue (the
   * "push now" button).
   */
  function preview(clock, opts = {}) {
    const file = opts.path || plistPath()
    const out = { file: { path: file }, running: safeRunning(), results: [], issues: [], planId: null }
    let info
    try { info = readKanbanFile(file, { converter }) } catch (e) {
      out.issues.push({ level: 'blocking', code: 'read-failed', message: e.message })
      return out
    }
    out.file = { path: file, format: info.format, encoding: info.encoding, hash: info.hash, bytes: info.bytes.length }

    if (opts.all) enqueueDue(clock, { auto: false })
    let rows = pending()
    if (opts.itemIds) rows = rows.filter(r => opts.itemIds.includes(r.item_id))
    const requests = buildRequests(rows, opts.choices, clock.today)
    const linked = new Set(db.prepare('SELECT card_id FROM kanban_links').all().map(r => String(r.card_id)))
    const plan = planPush(info.root, {
      requests, linkedCardIds: linked, boardName: settings().kanbanBoardName, overrides: overrides(), now: clock.now || new Date(),
    })
    out.results = plan.results
    out.issues = plan.issues
    out.shape = plan.shape
    out.invariants = plan.invariants
    out.ok = plan.ok
    if (plan.ok && requests.length) {
      const planId = crypto.randomUUID()
      plans.set(planId, { info, plan, queueIds: rows.map(r => r.id), requests, createdAt: Date.now() })
      for (const [id, p] of plans) if (Date.now() - p.createdAt > 30 * 60 * 1000) plans.delete(id)
      out.planId = planId
      store.saveSettings({ kanbanLastDryRunHash: info.hash })
    }
    return out
  }

  function safeRunning() { try { return !!isRunning() } catch (_) { return true } }

  function notifyQuit(titles) {
    if (!notifier || !titles.length) return
    const body = titles.length === 1
      ? `Quit Kanban Board so Radar can add your '${titles[0]}' card`
      : `Quit Kanban Board so Radar can add your ${titles.length} cards ('${titles.slice(0, 2).join("', '")}'${titles.length > 2 ? ', …' : ''})`
    notifier.show({ title: 'Life-Admin Radar', body, itemId: null, kind: 'kanban' })
  }

  /** Notify once per queue entry that is waiting on Kanban Board to quit. */
  function queueForQuit(clock, rows) {
    const fresh = rows.filter(r => !r.notified_at)
    if (!fresh.length) return
    const mark = db.prepare('UPDATE kanban_queue SET notified_at = ? WHERE id = ?')
    store.tx(() => { for (const r of fresh) mark.run(clock.nowIso, r.id) })()
    notifyQuit(fresh.map(r => r.title))
  }

  /**
   * LIVE WRITE of a previewed plan.
   * @returns {{ ok, queued?, error?, backup?, results? }}
   */
  function execute(clock, planId, { confirmGuesses = false } = {}) {
    const p = plans.get(planId)
    if (!p) return { ok: false, error: 'That preview has expired — preview again.' }
    const guesses = p.plan.issues.filter(i => i.level === 'confirm')
    if (guesses.length && !confirmGuesses) {
      return { ok: false, error: 'This push relies on guesses about the board format. Tick "I checked the dry run" to confirm them.' }
    }
    if (safeRunning()) {
      queueForQuit(clock, pending().filter(r => p.queueIds.includes(r.id)))
      return { ok: false, queued: true, error: 'Kanban Board is running. The cards stay queued — quit Kanban Board and push again.' }
    }
    let written
    try {
      const { xml } = buildNewPlist(p.info, p.plan.newRoot)
      written = writeAtomic(p.info, xml, { converter, isKanbanRunning: safeRunning, backupDir })
    } catch (e) {
      log('kanban write failed', e)
      return { ok: false, error: e.message }
    }
    plans.delete(planId)
    recordResults(clock, p)
    const s = settings()
    store.saveSettings({
      kanbanLiveWrites: String(Number(s.kanbanLiveWrites || 0) + 1),
      kanbanAckCodes: guesses.map(g => g.code).sort().join(','),
    })
    return { ok: true, backup: written.backup, verifiedVia: written.verifiedVia, results: p.plan.results }
  }

  function recordResults(clock, p) {
    const { today, nowIso } = clock
    store.tx(() => {
      const byItem = new Map(p.requests.map(r => [r.item.id, r]))
      for (const r of p.plan.results) {
        const req = byItem.get(r.itemId)
        const item = db.prepare('SELECT * FROM life_items WHERE id = ?').get(r.itemId)
        if (!item || !req) continue
        const h = hashChecklist(req.checklist)
        if (r.action === 'create' || r.action === 'link') {
          const how = r.action === 'create' ? 'created' : (r.match && r.match.manual ? 'manual' : 'matched')
          db.prepare(`INSERT OR REPLACE INTO kanban_links (item_id, card_id, linked_how, last_due_pushed, last_notes_hash, done_pushed, orphaned, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, 0, ?)`).run(item.id, String(r.cardId), how, req.item.due_date, h, nowIso)
        } else if (r.op === 'upsert' && (r.action === 'update' || r.action === 'unchanged')) {
          db.prepare('UPDATE kanban_links SET last_due_pushed = ?, last_notes_hash = ?, updated_at = ? WHERE item_id = ?')
            .run(req.item.due_date, h, nowIso, item.id)
        } else if (r.op === 'complete' && (r.action === 'move-to-done' || r.action === 'unchanged')) {
          db.prepare('UPDATE kanban_links SET done_pushed = 1, updated_at = ? WHERE item_id = ?').run(nowIso, item.id)
        } else if (r.action === 'orphaned') {
          db.prepare('UPDATE kanban_links SET orphaned = 1, updated_at = ? WHERE item_id = ?').run(nowIso, item.id)
        }
      }
      const failed = new Map(p.plan.results.filter(r => r.action === 'skip').map(r => [r.itemId, r.reason]))
      const upd = db.prepare(`UPDATE kanban_queue SET status = ?, applied_at = ?, error = ? WHERE id = ? AND status = 'pending'`)
      for (const qid of p.queueIds) {
        const q = db.prepare('SELECT * FROM kanban_queue WHERE id = ?').get(qid)
        if (!q) continue
        const reason = failed.get(q.item_id)
        upd.run(reason ? 'failed' : 'applied', nowIso, reason || null, qid)
      }
      void today
    })()
  }

  /**
   * Hands-off push, only after the user has done at least one reviewed live
   * push AND turned auto-push on. Anything that needs a human decision — a
   * fuzzy match, a guess the user has not already confirmed — is left for
   * the review screen instead.
   */
  function autoPush(clock) {
    const rows = pending()
    if (safeRunning()) { queueForQuit(clock, rows); return { ok: false, queued: true } }
    const pv = preview(clock)
    if (!pv.planId) return { ok: false }
    const ack = new Set((settings().kanbanAckCodes || '').split(',').filter(Boolean))
    const unconfirmed = pv.issues.filter(i => i.level === 'confirm' && !ack.has(i.code))
    const needsReview = pv.results.some(r => r.action === 'link')
    if (unconfirmed.length || needsReview) { plans.delete(pv.planId); return { ok: false, needsReview: true } }
    const res = execute(clock, pv.planId, { confirmGuesses: true })
    if (res.ok && notifier) {
      const made = res.results.filter(r => ['create', 'update', 'move-to-done'].includes(r.action))
      if (made.length) notifier.show({ title: 'Kanban Board updated', body: made.map(r => `• ${r.cardTitle}`).join('\n'), itemId: null, kind: 'kanban' })
    }
    return res
  }

  function unlink(itemId) {
    db.prepare('DELETE FROM kanban_links WHERE item_id = ?').run(itemId)
  }

  function cancelQueued(queueId) {
    db.prepare(`UPDATE kanban_queue SET status = 'cancelled' WHERE id = ? AND status = 'pending'`).run(queueId)
  }

  return { enqueueDue, pending, history, preview, execute, autoPush, unlink, cancelQueued, plistPath, isRunning: safeRunning }
}

module.exports = { createKanbanSync, hashChecklist }
