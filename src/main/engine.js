'use strict'
/**
 * The radar's heartbeat. tick() runs at launch, every minute, and on wake
 * from sleep. It is the ONLY place reminder state changes, and it changes it
 * with claim-then-send semantics:
 *
 *   one transaction:  compute what is due → set fired_at → write the
 *                     notification_log row
 *   after commit:     hand the notifications to the notifier
 *
 * So a crash between commit and delivery loses at most one notification; it
 * can never deliver one twice. Re-running tick() for the same day (or a
 * later one) finds fired_at set and does nothing — the "no duplicates on
 * re-run" guarantee the headless test asserts.
 *
 * Quiet by default: if nothing is due, tick() returns no notifications and
 * the notifier is never called.
 */
const { computeDueReminders, computeDueNags, inFirstReminderWindow } = require('./reminders')
const { diffDays, relativeLabel, formatDayKey, addDays, compareKeys, isDayKey } = require('../shared/dates')

const MAX_INDIVIDUAL = 3 // more than this in one tick → one summary banner

function readiness(checklist) {
  if (!checklist.length) return ''
  const done = checklist.filter(c => c.is_done).length
  return `${done}/${checklist.length} ready`
}

function reminderMessage(item, checklist, today) {
  if (item.kind === 'subscription') {
    return {
      title: `${item.title} renews ${relativeLabel(item.due_date, today)}`,
      body: `Keep or cancel? Renews ${formatDayKey(item.due_date)}.`,
    }
  }
  const n = diffDays(today, item.due_date)
  const when = n === 0 ? 'due today' : n > 0 ? `due ${relativeLabel(item.due_date, today)}` : `was due ${relativeLabel(item.due_date, today)}`
  const r = readiness(checklist)
  return {
    title: `${item.title} — ${when}`,
    body: [formatDayKey(item.due_date), r].filter(Boolean).join(' · '),
  }
}

function createEngine({ store, notifier = null, kanban = null, log = () => {} }) {
  const checklistFor = (itemId) =>
    store.raw.prepare('SELECT * FROM checklist_items WHERE item_id = ? ORDER BY position, id').all(itemId)

  const insertLog = store.raw.prepare(`INSERT INTO notification_log (kind, ref_id, item_id, title, body, day, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)

  /**
   * @param {{ today: string, nowIso: string, hour: number }} clock
   * @returns {{ notifications: Array<{kind,title,body,itemId}>, superseded: number, kanbanQueued: number }}
   */
  function tick(clock) {
    const { today, nowIso } = clock
    store.rollSubscriptions(clock)
    store.refreshStatuses(today)

    const settings = store.getSettings()
    const digestOn = settings.digestEnabled === '1'
    const out = []
    let superseded = 0

    store.tx(() => {
      const items = store.rawItems()
      const reminders = store.rawReminders()
      const { fire, supersede } = computeDueReminders(items, reminders, today)

      const mark = store.raw.prepare('UPDATE reminders SET fired_at = ?, fire_note = ? WHERE id = ? AND fired_at IS NULL')
      for (const s of supersede) {
        if (mark.run(nowIso, 'superseded', s.reminder.id).changes) superseded++
      }
      for (const f of fire) {
        // Digest-channel reminders ride along in the next morning digest —
        // unless today's digest already went out (or digests are off), in
        // which case they notify directly rather than vanish.
        const toDigest = f.reminder.channel === 'digest' && digestOn && settings.lastDigestDay !== today
        // `AND fired_at IS NULL` + checking `changes` makes the claim atomic
        // even if two ticks ever overlapped.
        if (!mark.run(nowIso, toDigest ? 'digest' : 'sent', f.reminder.id).changes) continue
        if (toDigest) continue
        const msg = reminderMessage(f.item, checklistFor(f.item.id), today)
        insertLog.run('reminder', f.reminder.id, f.item.id, msg.title, msg.body, today, nowIso)
        out.push({ kind: 'reminder', itemId: f.item.id, reminderId: f.reminder.id, ...msg })
      }

      const setNag = store.raw.prepare('UPDATE life_items SET last_nag_on = ? WHERE id = ? AND (last_nag_on IS NULL OR last_nag_on != ?)')
      for (const item of computeDueNags(items, today)) {
        if (!setNag.run(today, item.id, today).changes) continue
        const r = readiness(checklistFor(item.id))
        const msg = { title: `Still to book: ${item.title.replace(/^book\s+/i, '')}`, body: r ? `Checklist ${r}` : 'Pick a date when you can.' }
        insertLog.run('nag', item.id, item.id, msg.title, msg.body, today, nowIso)
        out.push({ kind: 'nag', itemId: item.id, ...msg })
      }

      const digest = maybeDigest(settings, clock, items)
      if (digest) {
        insertLog.run('digest', null, null, digest.title, digest.body, today, nowIso)
        out.push({ kind: 'digest', itemId: null, ...digest })
      }
    })()

    let kanbanQueued = 0
    if (kanban && settings.kanbanEnabled === '1') {
      try { kanbanQueued = kanban.enqueueDue(clock) } catch (e) { log('kanban enqueue failed', e) }
    }

    if (out.length && notifier) deliver(out)
    return { notifications: out, superseded, kanbanQueued }
  }

  /**
   * Morning digest: at most one per day, only at/after the configured hour,
   * only when enabled, and ONLY when something is actually due in the next
   * 7 days. A quiet week sends nothing.
   */
  function maybeDigest(settings, { today, hour }, items) {
    if (settings.digestEnabled !== '1') return null
    if (settings.lastDigestDay === today) return null
    if (Number(hour) < Number(settings.digestHour || 8)) return null
    const horizon = addDays(today, 7)
    const due = items.filter(i => i.status !== 'done' && isDayKey(i.due_date) &&
      compareKeys(i.due_date, horizon) <= 0)
      .sort((a, b) => compareKeys(a.due_date, b.due_date))
    const dueIds = new Set(due.map(i => i.id))
    const held = store.raw.prepare(`SELECT r.id, i.id AS item_id, i.title, i.due_date FROM reminders r JOIN life_items i ON i.id = r.item_id
      WHERE r.fire_note = 'digest' ORDER BY i.due_date, r.id`).all()
    store.raw.prepare(`UPDATE reminders SET fire_note = 'digest-sent' WHERE fire_note = 'digest'`).run()
    // Mark the day as handled even when nothing is due, so the check does
    // not repeat every minute — but send nothing.
    store.saveSettings({ lastDigestDay: today })
    const extra = held.filter(h => !dueIds.has(h.item_id))
    if (!due.length && !extra.length) return null
    const overdue = due.filter(i => compareKeys(i.due_date, today) < 0).length
    const lines = due.slice(0, 5).map(i => `• ${i.title} — ${relativeLabel(i.due_date, today)}`)
    if (due.length > 5) lines.push(`…and ${due.length - 5} more`)
    for (const h of extra.slice(0, 3)) lines.push(`• Heads-up: ${h.title} — ${relativeLabel(h.due_date, today)}`)
    return {
      title: due.length
        ? `Radar: ${due.length} due this week${overdue ? ` (${overdue} overdue)` : ''}`
        : 'Radar: heads-up for later',
      body: lines.join('\n'),
    }
  }

  function deliver(list) {
    if (list.length > MAX_INDIVIDUAL) {
      notifier.show({
        title: `Life-Admin Radar: ${list.length} reminders`,
        body: list.map(n => `• ${n.title}`).join('\n'),
        itemId: null,
      })
      return
    }
    for (const n of list) notifier.show(n)
  }

  /** Items that should be on the Kanban board right now (see kanban/sync.js). */
  function kanbanCandidates(today, { includeSubscriptions = false } = {}) {
    const items = store.rawItems()
    const reminders = store.rawReminders()
    // Subscriptions auto-renew; keep/cancel happens in Radar, not on the
    // board. Excluded by kind AND by category, so one added through quick
    // add (a plain dated item filed under Subscriptions) stays off too.
    const isSub = (i) => i.kind === 'subscription' || i.category === 'subscriptions'
    return items.filter(i => (includeSubscriptions || !isSub(i)) &&
      inFirstReminderWindow(i, reminders, today))
  }

  return { tick, kanbanCandidates, reminderMessage }
}

module.exports = { createEngine, reminderMessage }
