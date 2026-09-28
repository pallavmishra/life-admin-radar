// Display-only date helpers (ESM). The authoritative date math lives in
// src/shared/dates.js in the main process; these only format what it sends.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const utc = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) }

export const isDayKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
export const diffDays = (a, b) => Math.round((utc(b) - utc(a)) / 86400000)

export function formatDay(key, { year = true } = {}) {
  if (!isDayKey(key)) return ''
  const t = new Date(utc(key))
  const s = `${DOW[t.getUTCDay()]}, ${MON[t.getUTCMonth()]} ${t.getUTCDate()}`
  return year ? `${s}, ${t.getUTCFullYear()}` : s
}

export function relative(key, today) {
  if (!isDayKey(key)) return 'no date'
  const n = diffDays(today, key)
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n === -1) return 'yesterday'
  if (n < 0) return `${-n} days overdue`
  if (n < 60) return `in ${n} days`
  const months = Math.round(n / 30.4)
  return `in ~${months} months`
}

export function longToday(key) {
  if (!isDayKey(key)) return ''
  const t = new Date(utc(key))
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${days[t.getUTCDay()]}, ${months[t.getUTCMonth()]} ${t.getUTCDate()}`
}

export const money = (cents, approx = false) => (cents == null ? '—' : `${approx ? '~' : ''}$${(cents / 100).toFixed(2)}`)

export function readiness(checklist = []) {
  if (!checklist.length) return null
  const done = checklist.filter(c => c.is_done).length
  return { done, total: checklist.length, all: done === checklist.length }
}

export function describeReminder(n) {
  n = Number(n)
  if (n === 0) return 'on the day'
  if (n > 0) return `${n}d before`
  return `${-n}d after`
}

export const CATEGORY_COLORS = {
  immigration: 'var(--c-immigration)', vehicle_license: 'var(--c-vehicle)', insurance: 'var(--c-insurance)',
  health: 'var(--c-health)', finance: 'var(--c-finance)', subscriptions: 'var(--c-subs)',
  household: 'var(--c-household)', claims: 'var(--c-claims)', other: 'var(--c-other)',
}
