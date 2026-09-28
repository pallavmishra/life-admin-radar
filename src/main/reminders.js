'use strict'
/**
 * Reminder-scheduling math. PURE: no DB, no clock, no Electron — every input
 * is passed in, so the same (items, reminders, today) always yields the same
 * answer. The engine (engine.js) is the only caller that turns the answer
 * into side effects, and it does so inside one transaction.
 *
 * The rules, in one place:
 *
 *  1. A reminder's fire day is `due_date - days_before`. Negative
 *     days_before means "after the due date" (a follow-up nudge).
 *  2. A reminder is ELIGIBLE on or after its fire day, while `fired_at` is
 *     null, the item is not done, and the item has a due date. Dateless
 *     items (subscriptions whose renewal date is not known yet) have no
 *     eligible reminders — that is the graceful path, not an error.
 *  3. NO BURST. If several of one item's reminders are eligible at once (the
 *     app was closed for a month; an item was created 10 days before its
 *     due date with a 60/30/7 schedule), only the most recent one — the
 *     smallest days_before, i.e. the latest fire day — actually notifies.
 *     The others are marked fired as `superseded`: telling the user "60 days
 *     left" and "30 days left" in the same second is noise.
 *  4. NO DOUBLE FIRING. Once fired_at is set it never fires again — until the
 *     due date moves; see rearmForNewDueDate().
 *  5. A reminder never fires for a day more than STALE_AFTER_DAYS past the
 *     due date; those are superseded silently (the dashboard's Overdue
 *     section is already telling the story).
 */

const { addDays, compareKeys, diffDays, isDayKey } = require('../shared/dates')

const STALE_AFTER_DAYS = 30

function fireDay(dueDate, daysBefore) {
  return addDays(dueDate, -Number(daysBefore))
}

/**
 * @param {Array<{id, due_date, status, kind}>} items
 * @param {Array<{id, item_id, days_before, channel, fired_at}>} reminders
 * @param {string} today  local YYYY-MM-DD
 * @returns {{ fire: Array<{reminder, item, fireDay}>, supersede: Array<{reminder, item, fireDay}> }}
 */
function computeDueReminders(items, reminders, today) {
  const byId = new Map(items.map(i => [i.id, i]))
  const eligibleByItem = new Map()

  for (const r of reminders) {
    if (r.fired_at) continue
    const item = byId.get(r.item_id)
    if (!item || item.status === 'done' || !isDayKey(item.due_date)) continue
    if (item.kind === 'nag') continue // nags are paced by computeDueNags
    const fd = fireDay(item.due_date, r.days_before)
    if (compareKeys(today, fd) < 0) continue
    if (!eligibleByItem.has(item.id)) eligibleByItem.set(item.id, [])
    eligibleByItem.get(item.id).push({ reminder: r, item, fireDay: fd })
  }

  const fire = []
  const supersede = []
  for (const list of eligibleByItem.values()) {
    // Latest fire day first; tie-break on id for determinism.
    list.sort((a, b) => compareKeys(b.fireDay, a.fireDay) || (a.reminder.id - b.reminder.id))
    const [latest, ...older] = list
    supersede.push(...older)
    const stale = diffDays(latest.item.due_date, today) > STALE_AFTER_DAYS
    if (stale) supersede.push(latest)
    else fire.push(latest)
  }
  const order = (a, b) => compareKeys(a.item.due_date, b.item.due_date) || (a.reminder.id - b.reminder.id)
  return { fire: fire.sort(order), supersede: supersede.sort(order) }
}

/**
 * Nag items ("book the colonoscopy") have no due date. They nudge every
 * `nag_every_days` days, counted from the last nag — or from creation, so a
 * freshly created nag is quiet for its first interval rather than pinging
 * the moment it is saved.
 */
function computeDueNags(items, today) {
  const out = []
  for (const item of items) {
    if (item.kind !== 'nag' || item.status === 'done') continue
    const every = Number(item.nag_every_days) || 14
    const anchor = item.last_nag_on || item.created_on
    if (!isDayKey(anchor)) continue
    if (diffDays(anchor, today) >= every) out.push(item)
  }
  return out.sort((a, b) => a.id - b.id)
}

/**
 * When an item's due date changes, reminders whose NEW fire day is still in
 * the future are re-armed (fired_at cleared) so the user is told again about
 * the new date. Reminders whose new fire day has already passed keep their
 * state; if unfired they follow the normal no-burst rule.
 *
 * @returns {number[]} reminder ids to re-arm
 */
function rearmForNewDueDate(reminders, newDueDate, today) {
  if (!isDayKey(newDueDate)) return []
  return reminders
    .filter(r => r.fired_at && compareKeys(fireDay(newDueDate, r.days_before), today) > 0)
    .map(r => r.id)
    .sort((a, b) => a - b)
}

/** Next upcoming (unfired, future) fire day for an item, for display. */
function nextReminderDay(item, reminders, today) {
  if (!isDayKey(item.due_date) || item.status === 'done') return null
  let best = null
  for (const r of reminders) {
    if (r.item_id !== item.id || r.fired_at) continue
    const fd = fireDay(item.due_date, r.days_before)
    if (compareKeys(fd, today) < 0) continue
    if (!best || compareKeys(fd, best) < 0) best = fd
  }
  return best
}

/** True once today has reached the item's EARLIEST reminder day — i.e. the
 *  item has entered its first reminder window. Drives the Kanban push. */
function inFirstReminderWindow(item, reminders, today) {
  if (item.status === 'done') return false
  if (item.kind === 'nag') return true // actionable from day one
  if (!isDayKey(item.due_date)) return false
  const own = reminders.filter(r => r.item_id === item.id)
  const maxBefore = own.length ? Math.max(...own.map(r => Number(r.days_before))) : 0
  return compareKeys(today, fireDay(item.due_date, maxBefore)) >= 0
}

function describeReminder(daysBefore) {
  const n = Number(daysBefore)
  if (n === 0) return 'on the day'
  if (n > 0) return `${n} day${n === 1 ? '' : 's'} before`
  return `${-n} day${n === -1 ? '' : 's'} after`
}

module.exports = {
  fireDay, computeDueReminders, computeDueNags, rearmForNewDueDate,
  nextReminderDay, inFirstReminderWindow, describeReminder, STALE_AFTER_DAYS,
}
