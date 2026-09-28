'use strict'
/**
 * Status + dashboard bucketing. PURE.
 *
 *   done      — marked complete by the user
 *   overdue   — due date before today
 *   due       — due within the next 7 days (today included)
 *   upcoming  — everything else, including dateless items
 */
const { diffDays, isDayKey, compareKeys } = require('../shared/dates')
const { WINDOWS } = require('../shared/constants')

function deriveStatus(item, today) {
  if (item.status === 'done' || item.completed_on) return 'done'
  if (!isDayKey(item.due_date)) return 'upcoming'
  const n = diffDays(today, item.due_date)
  if (n < 0) return 'overdue'
  if (n <= WINDOWS.soon) return 'due'
  return 'upcoming'
}

/**
 * Dashboard sections. Only the first four are shown by default; `later`,
 * `undated` and `done` sit behind the filter. Nag items get their own small
 * "to book" section because they are actionable without a date.
 */
function bucketItems(items, today) {
  const b = { overdue: [], week: [], month: [], quarter: [], toBook: [], later: [], undated: [], done: [] }
  for (const it of items) {
    const status = deriveStatus(it, today)
    if (status === 'done') { b.done.push(it); continue }
    if (it.kind === 'nag') { b.toBook.push(it); continue }
    if (!isDayKey(it.due_date)) { b.undated.push(it); continue }
    const n = diffDays(today, it.due_date)
    if (n < 0) b.overdue.push(it)
    else if (n <= WINDOWS.soon) b.week.push(it)
    else if (n <= WINDOWS.month) b.month.push(it)
    else if (n <= WINDOWS.quarter) b.quarter.push(it)
    else b.later.push(it)
  }
  const byDue = (a, c) => compareKeys(a.due_date || '9999', c.due_date || '9999') || a.id - c.id
  for (const k of Object.keys(b)) b[k].sort(byDue)
  b.done.sort((a, c) => compareKeys(c.completed_on || '', a.completed_on || '') || c.id - a.id)
  return b
}

/** Suggested Kanban priority from how close the date is. */
function priorityFor(item, today) {
  if (!isDayKey(item.due_date)) return 'medium'
  const n = diffDays(today, item.due_date)
  if (n <= WINDOWS.soon) return 'high'
  if (n <= WINDOWS.month) return 'medium'
  return 'low'
}

module.exports = { deriveStatus, bucketItems, priorityFor }
