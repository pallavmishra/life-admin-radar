'use strict'
/**
 * Calendar-day arithmetic on LOCAL 'YYYY-MM-DD' keys.
 *
 * ⚠️ Same invariant as Vitals (eslint-rules/no-utc-day-key.js): a due date is
 * the user's own calendar day. We never truncate `toISOString()` of a local
 * Date — that is the UTC day, which is a different string for hours of every
 * day. Keys are built from local getters, and day arithmetic is done on
 * Date.UTC(...) of the key's parts, which is internally consistent and immune
 * to DST (no 23/25-hour days in UTC).
 */

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function isDayKey(s) {
  if (typeof s !== 'string') return false
  const m = KEY_RE.exec(s)
  if (!m) return false
  const [y, mo, d] = [+m[1], +m[2], +m[3]]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

function assertDayKey(s, what = 'date') {
  if (!isDayKey(s)) throw new Error(`Invalid ${what}: expected YYYY-MM-DD, got ${JSON.stringify(s)}`)
  return s
}

const pad = (n) => String(n).padStart(2, '0')

/** The LOCAL calendar day of a Date (defaults to now). */
function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function toUtcMs(key) {
  assertDayKey(key)
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function fromUtcMs(ms) {
  const t = new Date(ms)
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

const DAY_MS = 86400000

function addDays(key, n) {
  return fromUtcMs(toUtcMs(key) + Math.trunc(n) * DAY_MS)
}

/** Whole days from `a` to `b` (positive when b is later). */
function diffDays(a, b) {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS)
}

/**
 * Add calendar months, clamping to the month's last day (Jan 31 + 1 month =
 * Feb 28/29), which is how billing systems roll a renewal date.
 */
function addMonths(key, n) {
  const [y, m, d] = key.split('-').map(Number)
  assertDayKey(key)
  const idx = (y * 12 + (m - 1)) + Math.trunc(n)
  const ny = Math.floor(idx / 12)
  const nm = idx - ny * 12
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate()
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`
}

/**
 * Add months but land on `anchorDay` (clamped to the month's length), so a
 * bill due "on the 29th" is Jan 29 → Feb 28 → Mar 29, not → Mar 28 forever.
 */
function addMonthsAnchored(key, n, anchorDay) {
  if (!anchorDay) return addMonths(key, n)
  const moved = addMonths(key.slice(0, 8) + '01', n)
  const [y, m] = moved.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${moved.slice(0, 8)}${pad(Math.min(Number(anchorDay), last))}`
}

/** The first date on or after `today` that falls on `anchorDay` of its month. */
function nextOnDay(today, anchorDay) {
  const thisMonth = addMonthsAnchored(today, 0, anchorDay)
  return compareKeys(thisMonth, today) >= 0 ? thisMonth : addMonthsAnchored(today, 1, anchorDay)
}

function compareKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** "Mon, Mar 14 2027" style label — pure, from the key itself. */
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatDayKey(key, { withYear = true } = {}) {
  if (!isDayKey(key)) return ''
  const t = new Date(toUtcMs(key))
  const s = `${DOW[t.getUTCDay()]}, ${MON[t.getUTCMonth()]} ${t.getUTCDate()}`
  return withYear ? `${s} ${t.getUTCFullYear()}` : s
}

/** Human "in 3 days" / "2 days ago" / "today". */
function relativeLabel(dueKey, todayKey) {
  const n = diffDays(todayKey, dueKey)
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n === -1) return 'yesterday'
  return n > 0 ? `in ${n} days` : `${-n} days ago`
}

module.exports = {
  isDayKey, assertDayKey, localDayKey, addDays, diffDays, addMonths, addMonthsAnchored, nextOnDay,
  compareKeys, formatDayKey, relativeLabel, DAY_MS,
}
