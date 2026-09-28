'use strict'
/**
 * Privacy boundary (hard rule). The radar tracks THAT a document exists and
 * WHERE it lives — never its contents. Every free-text field that reaches
 * the database (titles, notes, checklist labels, location hints, consumable
 * names, subscription fields) goes through checkText() in db.js, so this is
 * enforced at the storage layer, not just in the UI.
 *
 * What it refuses:
 *  - anything shaped like a US SSN / ITIN (###-##-####, or 9 bare digits)
 *  - a date of birth ("DOB", "date of birth", "born on" followed by a date)
 *  - credential values ("password: …", "passcode=…", "PIN 1234", API keys)
 *  - embedded images / binary blobs (data: URLs, base64 runs)
 *
 * What it allows on purpose: the WORDS "password", "SSN card", "birth
 * certificate" in a checklist label — "Social Security card: obtained ☐" is
 * exactly the kind of thing the radar should track. Only a VALUE trips it.
 */

const RULES = [
  {
    id: 'ssn',
    // 123-45-6789, 123 45 6789, or exactly nine digits standing alone.
    re: /(?<![\d#])(?:\d{3}[- ]\d{2}[- ]\d{4}|\d{9})(?!\d)/,
    message: 'looks like a Social Security / ITIN number',
  },
  {
    id: 'dob',
    re: /\b(?:d\.?o\.?b\.?|date\s+of\s+birth|birth\s*date|birthday|born(?:\s+on)?)\b\s*[:=-]?\s*(?:\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2})/i,
    message: 'looks like a date of birth',
  },
  {
    id: 'credential',
    re: /\b(?:password|passwd|pwd|passcode|pin|secret|api[\s_-]?key|token|security\s+answer)\b\s*(?:is\s*)?[:=]\s*\S+/i,
    message: 'looks like a password or credential value',
  },
  {
    id: 'credential-pin',
    re: /\bpin\s*#?\s*\d{4,8}\b/i,
    message: 'looks like a PIN',
  },
  {
    id: 'image',
    re: /data:[a-z]+\/[a-z0-9.+-]+;base64,|[A-Za-z0-9+/]{120,}={0,2}/,
    message: 'looks like an embedded file or image',
  },
]

/** @returns {null | {rule, message}} */
function findViolation(text) {
  if (text == null) return null
  const s = String(text)
  for (const r of RULES) if (r.re.test(s)) return { rule: r.id, message: r.message }
  return null
}

class PrivacyError extends Error {
  constructor(field, v) {
    super(`Not saved: ${field} ${v.message}. Life-Admin Radar never stores SSNs, dates of birth, ` +
      'passwords, credential values, or ID images — track where the document lives instead ' +
      '(e.g. "saved in ~/H1 Documents").')
    this.name = 'PrivacyError'
    this.field = field
    this.rule = v.rule
  }
}

function checkText(field, text) {
  const v = findViolation(text)
  if (v) throw new PrivacyError(field, v)
  return text
}

module.exports = { findViolation, checkText, PrivacyError }
