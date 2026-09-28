'use strict'
/**
 * Dedupe rule: before creating any card, fuzzy-match the radar item's title
 * against the existing cards. PURE.
 *
 * Normalisation: lowercase, strip punctuation, drop filler words that
 * describe the ACTION rather than the THING ("book", "appointment",
 * "renewal", "check status", …), and fold immigration synonyms onto one
 * token so "H-1B: I-94 expires" and the board's "Visa Renewal" are the same
 * thing. What is left is the subject: {colonoscopy}, {prostate}, {visa}.
 *
 *   "Book colonoscopy appointment"  → {colonoscopy}  ≙ "Colonoscopy Appointment"
 *   "Book prostate appointment"     → {prostate}     ≙ "Prostate Appointment"
 *   "H-1B: I-94 expires"            → {visa}         ≙ "Visa Renewal"
 *
 * A match is: identical token sets, one set contained in the other, or
 * Jaccard similarity ≥ 0.6. The dry-run shows every match decision, and the
 * UI lets the user overrule it, so a false positive is caught before the
 * first write.
 */

const STOP = new Set([
  'book', 'booking', 'booked', 'appointment', 'appointments', 'appt', 'schedule', 'scheduled',
  'renewal', 'renew', 'renewing', 'expires', 'expiry', 'expiration', 'expire', 'due',
  'check', 'status', 'follow', 'followup', 'up', 'todo', 'task', 'reminder',
  'the', 'a', 'an', 'my', 'for', 'to', 'of', 'and', 'with', 'on', 'at', 'in',
])

// Canonical subject tokens. Only unambiguous identifiers — "visa" alone is
// kept too because on this board it means the immigration kind.
const SYNONYMS = {
  h1b: 'visa', i94: 'visa', i797: 'visa', i129: 'visa', stamping: 'visa', visa: 'visa',
  dmv: 'license', licence: 'license',
  drivers: 'driver', driving: 'driver',
}

function tokens(title) {
  const s = String(title || '').toLowerCase()
    .replace(/['’]s\b/g, 's')               // driver's → drivers
    .replace(/\b([a-z])-(\d)/g, '$1$2')      // h-1b → h1b, i-94 → i94
    .replace(/[^a-z0-9]+/g, ' ')
  const out = new Set()
  for (const w of s.split(' ')) {
    if (!w || STOP.has(w)) continue
    if (/^\d+$/.test(w)) continue           // claim numbers, years
    out.add(SYNONYMS[w] || w)
  }
  return out
}

function score(aTitle, bTitle) {
  const a = tokens(aTitle), b = tokens(bTitle)
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  if (inter === 0) return 0
  if (inter === a.size && inter === b.size) return 1
  if (inter === Math.min(a.size, b.size)) return 0.9 // containment
  return inter / (a.size + b.size - inter)
}

const THRESHOLD = 0.6

/**
 * @param {string} title  radar item title
 * @param {Array<{id, title}>} cards  candidate cards
 * @returns {{ card, score, alternatives: Array<{card, score}> } | null}
 */
function bestMatch(title, cards) {
  const scored = cards
    .map(card => ({ card, score: score(title, card.title) }))
    .filter(x => x.score >= THRESHOLD)
    .sort((x, y) => y.score - x.score || String(x.card.title).localeCompare(String(y.card.title)))
  if (!scored.length) return null
  return { card: scored[0].card, score: scored[0].score, alternatives: scored.slice(1) }
}

module.exports = { tokens, score, bestMatch, THRESHOLD }
