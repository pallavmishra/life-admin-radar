'use strict'
/**
 * Lenient input parsing for what people actually type into a cost or URL
 * field: "$69.99", "69.99", "1,299.00", "$ 18.99/mo"; "membership.ouraring.com".
 */

/** "$1,299.99" → 129999 (cents). '' / null → null. Throws a readable error otherwise. */
function parseCents(input) {
  if (input == null) return null
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error('Cost should be an amount like 69.99')
    return Math.round(input * 100)
  }
  const s = String(input).trim()
  if (!s) return null
  const cleaned = s.replace(/\s*\/\s*(mo|month|yr|year|qtr|quarter)\.?$/i, '').replace(/[$,\s]|usd/gi, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error(`Cost should be an amount like 69.99 (got "${s}")`)
  return Math.round(parseFloat(cleaned) * 100)
}

/** "membership.ouraring.com" → "https://membership.ouraring.com". Only https is stored. */
function normalizeUrl(input) {
  let s = String(input || '').trim()
  if (!s) return ''
  if (/^http:\/\//i.test(s)) s = 'https://' + s.slice(7)
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '')
  let u
  try { u = new URL(s) } catch (_) { throw new Error(`"${input}" doesn't look like a web address`) }
  if (u.protocol !== 'https:' || !u.hostname.includes('.')) throw new Error(`"${input}" doesn't look like a web address`)
  return u.toString()
}

module.exports = { parseCents, normalizeUrl }
