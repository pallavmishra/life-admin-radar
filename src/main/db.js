'use strict'
/**
 * SQLite persistence (better-sqlite3). A factory rather than a module
 * singleton so tests and the headless runner can open as many throwaway
 * databases as they like; main.js opens exactly one.
 *
 * Every write that takes free text goes through privacy.checkText — the
 * privacy boundary is enforced here, at storage, not only in the UI.
 *
 * Nothing in this file reads the clock. Callers pass `today` (a local
 * YYYY-MM-DD key) and `nowIso`, which is what makes the headless
 * "advance the clock" test possible.
 */
const Database = require('better-sqlite3')
const { checkText } = require('../shared/privacy')
const { normalizeUrl, parseCents } = require('../shared/money')
const { CATEGORY_IDS, KINDS, CHANNELS, BILLING_CYCLES } = require('../shared/constants')
const { isDayKey, addMonths, compareKeys } = require('../shared/dates')
const { deriveStatus } = require('./status')
const { rearmForNewDueDate } = require('./reminders')
const { getTemplate } = require('../shared/templates')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS life_items (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','due','overdue','done')),
  notes TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'dated' CHECK (kind IN ('dated','nag','subscription')),
  nag_every_days INTEGER,
  last_nag_on TEXT,
  template_id TEXT,
  created_on TEXT NOT NULL,
  completed_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES life_items(id) ON DELETE CASCADE,
  days_before INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'notification' CHECK (channel IN ('notification','digest')),
  fired_at TEXT,
  fire_note TEXT,
  UNIQUE (item_id, days_before)
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES life_items(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  is_done INTEGER NOT NULL DEFAULT 0,
  location_hint TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscriptions (
  item_id INTEGER PRIMARY KEY REFERENCES life_items(id) ON DELETE CASCADE,
  cost_cents INTEGER,
  billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  cancel_url TEXT NOT NULL DEFAULT '',
  via TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS subscription_decisions (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES life_items(id) ON DELETE CASCADE,
  decided_on TEXT NOT NULL,
  renewal_date TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('keep','cancel','auto-renewed')),
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS consumables (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  have INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id INTEGER,
  item_id INTEGER,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kanban_links (
  item_id INTEGER PRIMARY KEY REFERENCES life_items(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  linked_how TEXT NOT NULL CHECK (linked_how IN ('created','matched','manual')),
  last_due_pushed TEXT,
  last_notes_hash TEXT,
  done_pushed INTEGER NOT NULL DEFAULT 0,
  orphaned INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kanban_queue (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES life_items(id) ON DELETE CASCADE,
  op TEXT NOT NULL CHECK (op IN ('upsert','complete')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','failed','cancelled')),
  created_at TEXT NOT NULL,
  applied_at TEXT,
  notified_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_reminders_item ON reminders(item_id);
CREATE INDEX IF NOT EXISTS idx_checklist_item ON checklist_items(item_id);
CREATE INDEX IF NOT EXISTS idx_queue_status ON kanban_queue(status);
`

const DEFAULT_SETTINGS = {
  digestEnabled: '0',
  digestHour: '8',
  lastDigestDay: '',
  seeded: '0',
  kanbanPlistPath: '',            // '' → ~/Library/Preferences/app.pallavmishra.KanbanBoard.plist
  kanbanBoardName: 'My First Board',
  kanbanEnabled: '1',
  kanbanAutoPush: '0',            // off until the user turns it on after a verified push
  kanbanLiveWrites: '0',          // count of successful live writes
  kanbanLastDryRunHash: '',
  kanbanIncludeSubscriptions: '0',
  kanbanFieldOverrides: '',       // JSON, see kanban/board.js
}

function openDatabase(file) {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return createStore(db)
}

function createStore(db) {
  const tx = (fn) => db.transaction(fn)

  // ── settings ────────────────────────────────────────────────────────────
  function getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all()
    return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map(r => [r.key, r.value])) }
  }
  function saveSettings(obj) {
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    tx(() => { for (const [k, v] of Object.entries(obj)) upsert.run(k, v == null ? '' : String(v)) })()
  }

  // ── validation ──────────────────────────────────────────────────────────
  function cleanTitle(t) {
    const s = String(t || '').trim()
    if (!s) throw new Error('Title is required')
    if (s.length > 200) throw new Error('Title is too long (200 characters max)')
    return checkText('title', s)
  }
  function cleanDue(d) {
    if (d == null || d === '') return null
    if (!isDayKey(d)) throw new Error(`Due date must be YYYY-MM-DD (got ${JSON.stringify(d)})`)
    return d
  }
  function cleanReminders(list) {
    const seen = new Set()
    const out = []
    for (const r of list || []) {
      const days = Number(typeof r === 'object' ? r.days_before : r)
      if (!Number.isInteger(days) || days < -365 || days > 3650) throw new Error(`Invalid reminder: ${JSON.stringify(r)}`)
      if (seen.has(days)) continue
      seen.add(days)
      const channel = (typeof r === 'object' && r.channel) || 'notification'
      if (!CHANNELS.includes(channel)) throw new Error(`Invalid reminder channel: ${channel}`)
      out.push({ days_before: days, channel })
    }
    return out.sort((a, b) => b.days_before - a.days_before)
  }

  // ── items ───────────────────────────────────────────────────────────────
  const hydrate = (row) => {
    if (!row) return null
    row.reminders = db.prepare('SELECT * FROM reminders WHERE item_id = ? ORDER BY days_before DESC').all(row.id)
    row.checklist = db.prepare('SELECT * FROM checklist_items WHERE item_id = ? ORDER BY position, id').all(row.id)
    row.subscription = db.prepare('SELECT * FROM subscriptions WHERE item_id = ?').get(row.id) || null
    row.decisions = row.subscription
      ? db.prepare('SELECT * FROM subscription_decisions WHERE item_id = ? ORDER BY decided_on DESC, id DESC').all(row.id)
      : []
    row.kanban = db.prepare('SELECT * FROM kanban_links WHERE item_id = ?').get(row.id) || null
    return row
  }

  function getItem(id) {
    return hydrate(db.prepare('SELECT * FROM life_items WHERE id = ?').get(id))
  }

  function listItems() {
    return db.prepare('SELECT * FROM life_items ORDER BY id').all().map(hydrate)
  }

  /** Lightweight rows for the engine (no joins). */
  function rawItems() { return db.prepare('SELECT * FROM life_items ORDER BY id').all() }
  function rawReminders() { return db.prepare('SELECT * FROM reminders ORDER BY id').all() }

  function insertReminders(itemId, reminders) {
    const ins = db.prepare('INSERT INTO reminders (item_id, days_before, channel) VALUES (?, ?, ?)')
    for (const r of cleanReminders(reminders)) ins.run(itemId, r.days_before, r.channel)
  }

  function insertChecklist(itemId, list) {
    const ins = db.prepare('INSERT INTO checklist_items (item_id, label, is_done, location_hint, position) VALUES (?, ?, ?, ?, ?)')
    ;(list || []).forEach((c, i) => {
      const label = String(c.label || '').trim()
      if (!label) return
      ins.run(itemId, checkText('checklist label', label), c.is_done ? 1 : 0,
        checkText('location hint', String(c.location_hint || '').trim()), i)
    })
  }

  function writeSubscription(itemId, s) {
    if (!s) return
    const cycle = s.billing_cycle || 'monthly'
    if (!BILLING_CYCLES.some(c => c.id === cycle)) throw new Error(`Unknown billing cycle: ${cycle}`)
    // cost_cents arrives already in cents (templates/UI parse "$69.99" with
    // shared/money.js); anything else is a programming error, said plainly.
    const cost = 'cost' in s ? parseCents(s.cost)
      : s.cost_cents == null || s.cost_cents === '' ? null : Math.round(Number(s.cost_cents))
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) throw new Error('Cost should be an amount like 69.99')
    const url = normalizeUrl(s.cancel_url)
    db.prepare(`INSERT INTO subscriptions (item_id, cost_cents, billing_cycle, cancel_url, via) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET cost_cents=excluded.cost_cents, billing_cycle=excluded.billing_cycle,
      cancel_url=excluded.cancel_url, via=excluded.via`)
      .run(itemId, cost, cycle, checkText('cancel URL', url), checkText('via', String(s.via || '').trim()))
  }

  function createItem(draft, { today, nowIso }) {
    const kind = draft.kind || 'dated'
    if (!KINDS.includes(kind)) throw new Error(`Unknown kind: ${kind}`)
    const category = draft.category || 'other'
    if (!CATEGORY_IDS.includes(category)) throw new Error(`Unknown category: ${category}`)
    const row = {
      title: cleanTitle(draft.title),
      category,
      due_date: kind === 'nag' ? null : cleanDue(draft.due_date),
      notes: checkText('notes', String(draft.notes || '')),
      kind,
      nag_every_days: kind === 'nag' ? (Number(draft.nag_every_days) || 14) : null,
      template_id: draft.template_id || null,
    }
    row.status = deriveStatus(row, today)
    return tx(() => {
      const info = db.prepare(`INSERT INTO life_items
        (title, category, due_date, status, notes, kind, nag_every_days, template_id, created_on, created_at, updated_at)
        VALUES (@title, @category, @due_date, @status, @notes, @kind, @nag_every_days, @template_id, @today, @now, @now)`)
        .run({ ...row, today, now: nowIso })
      const id = Number(info.lastInsertRowid)
      insertReminders(id, draft.reminders)
      insertChecklist(id, draft.checklist)
      if (kind === 'subscription') writeSubscription(id, draft.subscription || {})
      return getItem(id)
    })()
  }

  /**
   * Patch an item. `patch.reminders`, when present, replaces the schedule;
   * reminders whose days_before survives keep their fired state, so editing
   * the notes of an item never re-fires anything.
   */
  function updateItem(id, patch, { today, nowIso }) {
    return tx(() => {
      const cur = db.prepare('SELECT * FROM life_items WHERE id = ?').get(id)
      if (!cur) throw new Error(`No item ${id}`)
      const next = { ...cur }
      if ('title' in patch) next.title = cleanTitle(patch.title)
      if ('category' in patch) {
        if (!CATEGORY_IDS.includes(patch.category)) throw new Error(`Unknown category: ${patch.category}`)
        next.category = patch.category
      }
      if ('notes' in patch) next.notes = checkText('notes', String(patch.notes || ''))
      if ('due_date' in patch && cur.kind !== 'nag') next.due_date = cleanDue(patch.due_date)
      if ('nag_every_days' in patch && cur.kind === 'nag') next.nag_every_days = Math.max(1, Number(patch.nag_every_days) || 14)
      next.status = deriveStatus(next, today)
      db.prepare(`UPDATE life_items SET title=@title, category=@category, notes=@notes, due_date=@due_date,
        nag_every_days=@nag_every_days, status=@status, updated_at=@now WHERE id=@id`).run({ ...next, now: nowIso })

      if (Array.isArray(patch.reminders)) {
        const wanted = cleanReminders(patch.reminders)
        const existing = db.prepare('SELECT * FROM reminders WHERE item_id = ?').all(id)
        const keep = new Set(wanted.map(w => w.days_before))
        for (const r of existing) if (!keep.has(r.days_before)) db.prepare('DELETE FROM reminders WHERE id = ?').run(r.id)
        const have = new Map(existing.map(r => [r.days_before, r]))
        for (const w of wanted) {
          const ex = have.get(w.days_before)
          if (ex) db.prepare('UPDATE reminders SET channel = ? WHERE id = ?').run(w.channel, ex.id)
          else db.prepare('INSERT INTO reminders (item_id, days_before, channel) VALUES (?, ?, ?)').run(id, w.days_before, w.channel)
        }
      }
      if (next.due_date !== cur.due_date) {
        const rs = db.prepare('SELECT * FROM reminders WHERE item_id = ?').all(id)
        for (const rid of rearmForNewDueDate(rs, next.due_date, today)) {
          db.prepare('UPDATE reminders SET fired_at = NULL, fire_note = NULL WHERE id = ?').run(rid)
        }
      }
      if (patch.subscription && cur.kind === 'subscription') {
        const s = db.prepare('SELECT * FROM subscriptions WHERE item_id = ?').get(id) || {}
        writeSubscription(id, { ...s, ...patch.subscription })
      }
      return getItem(id)
    })()
  }

  function deleteItem(id) {
    db.prepare('DELETE FROM life_items WHERE id = ?').run(id)
  }

  function completeItem(id, { today, nowIso }) {
    db.prepare(`UPDATE life_items SET status='done', completed_on=?, updated_at=? WHERE id=?`).run(today, nowIso, id)
    return getItem(id)
  }

  function reopenItem(id, { today, nowIso }) {
    const cur = db.prepare('SELECT * FROM life_items WHERE id = ?').get(id)
    if (!cur) throw new Error(`No item ${id}`)
    const status = deriveStatus({ ...cur, status: 'upcoming', completed_on: null }, today)
    db.prepare('UPDATE life_items SET status=?, completed_on=NULL, updated_at=? WHERE id=?').run(status, nowIso, id)
    db.prepare('UPDATE kanban_links SET done_pushed = 0 WHERE item_id = ?').run(id)
    return getItem(id)
  }

  /**
   * A "to book" nag gets its appointment date: it becomes an ordinary dated
   * item ("Book colonoscopy appointment" → "Colonoscopy appointment") with
   * the booked-appointment reminder schedule.
   */
  function bookNag(id, date, { today, nowIso }) {
    return tx(() => {
      const cur = db.prepare('SELECT * FROM life_items WHERE id = ?').get(id)
      if (!cur || cur.kind !== 'nag') throw new Error('Only a "to book" item can be booked')
      const due = cleanDue(date)
      if (!due) throw new Error('Pick the appointment date')
      let title = cur.title.replace(/^\s*book\s+(an?\s+)?/i, '').trim()
      title = title.charAt(0).toUpperCase() + title.slice(1)
      const next = { ...cur, title, kind: 'dated', due_date: due, nag_every_days: null }
      next.status = deriveStatus(next, today)
      db.prepare(`UPDATE life_items SET title=@title, kind='dated', due_date=@due_date, nag_every_days=NULL,
        status=@status, updated_at=@now WHERE id=@id`).run({ ...next, now: nowIso })
      db.prepare('DELETE FROM reminders WHERE item_id = ?').run(id)
      insertReminders(id, getTemplate('health_booking').bookedReminders)
      return getItem(id)
    })()
  }

  // ── checklist ───────────────────────────────────────────────────────────
  function addChecklistItem(itemId, { label, location_hint = '' }) {
    const l = String(label || '').trim()
    if (!l) throw new Error('Checklist label is required')
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM checklist_items WHERE item_id = ?').get(itemId).p
    const info = db.prepare('INSERT INTO checklist_items (item_id, label, location_hint, position) VALUES (?, ?, ?, ?)')
      .run(itemId, checkText('checklist label', l), checkText('location hint', String(location_hint).trim()), pos)
    return db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(info.lastInsertRowid)
  }
  function updateChecklistItem(id, patch) {
    const cur = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id)
    if (!cur) throw new Error(`No checklist item ${id}`)
    const next = {
      label: 'label' in patch ? checkText('checklist label', String(patch.label).trim()) : cur.label,
      is_done: 'is_done' in patch ? (patch.is_done ? 1 : 0) : cur.is_done,
      location_hint: 'location_hint' in patch ? checkText('location hint', String(patch.location_hint).trim()) : cur.location_hint,
    }
    if (!next.label) throw new Error('Checklist label is required')
    db.prepare('UPDATE checklist_items SET label=?, is_done=?, location_hint=? WHERE id=?')
      .run(next.label, next.is_done, next.location_hint, id)
    return db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id)
  }
  function deleteChecklistItem(id) { db.prepare('DELETE FROM checklist_items WHERE id = ?').run(id) }

  // ── subscriptions ───────────────────────────────────────────────────────
  function cycleMonths(cycle) { return (BILLING_CYCLES.find(c => c.id === cycle) || BILLING_CYCLES[0]).months }

  /**
   * keep   → logged; next renewal advances one billing cycle; the 7-day
   *          reminder re-arms for the new date.
   * cancel → logged; the item is completed. Opening the cancel URL is a
   *          separate, previewed step in the UI.
   */
  function decideSubscription(itemId, decision, { today, nowIso, note = '' }) {
    if (!['keep', 'cancel'].includes(decision)) throw new Error(`Unknown decision: ${decision}`)
    return tx(() => {
      const item = db.prepare('SELECT * FROM life_items WHERE id = ?').get(itemId)
      const sub = db.prepare('SELECT * FROM subscriptions WHERE item_id = ?').get(itemId)
      if (!item || !sub) throw new Error('Not a subscription')
      db.prepare('INSERT INTO subscription_decisions (item_id, decided_on, renewal_date, decision, note) VALUES (?, ?, ?, ?, ?)')
        .run(itemId, today, item.due_date, decision, checkText('note', String(note)))
      if (decision === 'cancel') {
        db.prepare(`UPDATE life_items SET status='done', completed_on=?, updated_at=? WHERE id=?`).run(today, nowIso, itemId)
      } else if (isDayKey(item.due_date)) {
        updateItem(itemId, { due_date: addMonths(item.due_date, cycleMonths(sub.billing_cycle)) }, { today, nowIso })
      }
      return getItem(itemId)
    })()
  }

  /**
   * A subscription whose renewal day has passed renewed on its own. Roll it
   * forward (logging "auto-renewed" — the leak detector: renewals nobody
   * decided on) so it never sits in Overdue.
   */
  function rollSubscriptions({ today, nowIso }) {
    const rolled = []
    tx(() => {
      const rows = db.prepare(`SELECT i.*, s.billing_cycle FROM life_items i JOIN subscriptions s ON s.item_id = i.id
        WHERE i.kind = 'subscription' AND i.status != 'done' AND i.due_date IS NOT NULL`).all()
      for (const r of rows) {
        if (compareKeys(r.due_date, today) >= 0) continue
        let due = r.due_date
        const months = cycleMonths(r.billing_cycle)
        let guard = 0
        while (compareKeys(due, today) < 0 && guard++ < 1000) {
          const decided = db.prepare(`SELECT 1 FROM subscription_decisions WHERE item_id = ? AND renewal_date = ?`).get(r.id, due)
          if (!decided) {
            db.prepare(`INSERT INTO subscription_decisions (item_id, decided_on, renewal_date, decision, note)
              VALUES (?, ?, ?, 'auto-renewed', 'Renewed with no keep/cancel decision')`).run(r.id, today, due)
          }
          due = addMonths(due, months)
        }
        updateItem(r.id, { due_date: due }, { today, nowIso })
        rolled.push({ id: r.id, from: r.due_date, to: due })
      }
    })()
    return rolled
  }

  // ── consumables (binary presence only — no quantities, ever) ───────────
  function listConsumables() {
    return db.prepare('SELECT * FROM consumables ORDER BY have ASC, name COLLATE NOCASE').all()
  }
  function addConsumable(name, { nowIso, have = true } = {}) {
    const n = String(name || '').trim()
    if (!n) throw new Error('Name is required')
    checkText('name', n)
    db.prepare(`INSERT INTO consumables (name, have, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET have = excluded.have, updated_at = excluded.updated_at`).run(n, have ? 1 : 0, nowIso)
    return db.prepare('SELECT * FROM consumables WHERE name = ?').get(n)
  }
  function setConsumableHave(id, have, { nowIso }) {
    db.prepare('UPDATE consumables SET have = ?, updated_at = ? WHERE id = ?').run(have ? 1 : 0, nowIso, id)
  }
  function deleteConsumable(id) { db.prepare('DELETE FROM consumables WHERE id = ?').run(id) }

  // ── status refresh ──────────────────────────────────────────────────────
  function refreshStatuses(today) {
    const rows = db.prepare(`SELECT * FROM life_items WHERE status != 'done'`).all()
    const upd = db.prepare('UPDATE life_items SET status = ? WHERE id = ?')
    tx(() => { for (const r of rows) { const s = deriveStatus(r, today); if (s !== r.status) upd.run(s, r.id) } })()
  }

  // ── seed ────────────────────────────────────────────────────────────────
  function seedIfNeeded(items, ctx) {
    if (getSettings().seeded === '1') return false
    tx(() => {
      for (const it of items) createItem(it, ctx)
      saveSettings({ seeded: '1' })
    })()
    return true
  }

  /** "Clear data" — previewed in the UI; this returns the counts first. */
  function countAll() {
    const c = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
    return {
      items: c('life_items'), reminders: c('reminders'), checklist: c('checklist_items'),
      consumables: c('consumables'), decisions: c('subscription_decisions'), kanbanLinks: c('kanban_links'),
    }
  }
  function clearAll() {
    tx(() => {
      for (const t of ['kanban_queue', 'kanban_links', 'notification_log', 'subscription_decisions', 'subscriptions',
        'checklist_items', 'reminders', 'life_items', 'consumables']) db.exec(`DELETE FROM ${t}`)
      // keep `seeded` so a cleared radar stays empty
    })()
  }

  return {
    raw: db, tx, close: () => db.close(),
    getSettings, saveSettings,
    getItem, listItems, rawItems, rawReminders, createItem, updateItem, deleteItem, completeItem, reopenItem, bookNag,
    addChecklistItem, updateChecklistItem, deleteChecklistItem,
    decideSubscription, rollSubscriptions,
    listConsumables, addConsumable, setConsumableHave, deleteConsumable,
    refreshStatuses, seedIfNeeded, countAll, clearAll,
  }
}

module.exports = { openDatabase, DEFAULT_SETTINGS }
