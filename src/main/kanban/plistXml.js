'use strict'
/**
 * Lossless XML property-list parser/serializer.
 *
 * ⚠️ Lossless is the point. The Kanban preferences file holds more than the
 * board (window frames, other app state), and the radar must hand every one
 * of those values back exactly as it found them. So this does NOT convert
 * to plain JS values: it keeps a typed tree —
 *
 *   { t: 'dict', entries: [[key, node], …] }   (order preserved, dup-safe)
 *   { t: 'array', items: [node, …] }
 *   { t: 'string' | 'integer' | 'real' | 'date' | 'data', v: '<raw text>' }
 *   { t: 'true' } | { t: 'false' }
 *
 * — where numbers and dates stay as their original text, so nothing is
 * re-rounded. Only the one node the radar changes is ever replaced.
 *
 * Binary plists are converted to/from XML with macOS's own `plutil` (see
 * plistFile.js); this module only ever sees XML.
 */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ENT[e]
  })
}

function encodeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Tokenise into tags and text; comments, PIs and DOCTYPE are skipped. */
function tokenize(xml) {
  const tokens = []
  let i = 0
  while (i < xml.length) {
    if (xml[i] === '<') {
      if (xml.startsWith('<!--', i)) { i = xml.indexOf('-->', i) + 3; if (i < 3) throw new Error('Unterminated comment'); continue }
      if (xml.startsWith('<?', i)) { i = xml.indexOf('?>', i) + 2; if (i < 2) throw new Error('Unterminated PI'); continue }
      if (xml.startsWith('<![CDATA[', i)) {
        const end = xml.indexOf(']]>', i)
        tokens.push({ text: xml.slice(i + 9, end), raw: true }); i = end + 3; continue
      }
      if (xml.startsWith('<!', i)) { i = xml.indexOf('>', i) + 1; if (i < 1) throw new Error('Unterminated DOCTYPE'); continue }
      const end = xml.indexOf('>', i)
      if (end < 0) throw new Error('Unterminated tag')
      const body = xml.slice(i + 1, end).trim()
      if (body.startsWith('/')) tokens.push({ close: body.slice(1).trim() })
      else if (body.endsWith('/')) tokens.push({ open: body.slice(0, -1).trim().split(/\s/)[0], self: true })
      else tokens.push({ open: body.split(/\s/)[0] })
      i = end + 1
    } else {
      const end = xml.indexOf('<', i)
      const text = xml.slice(i, end < 0 ? xml.length : end)
      tokens.push({ text })
      i = end < 0 ? xml.length : end
    }
  }
  return tokens
}

const SCALARS = new Set(['string', 'integer', 'real', 'date', 'data', 'key'])

function parse(xml) {
  const toks = tokenize(xml).filter(t => !(t.text != null && !t.raw && t.text.trim() === ''))
  let p = 0
  const expectClose = (name) => {
    const t = toks[p++]
    if (!t || t.close !== name) throw new Error(`Malformed plist: expected </${name}>`)
  }
  function readText(name) {
    let s = ''
    while (toks[p] && toks[p].text != null) { const t = toks[p++]; s += t.raw ? t.text : decodeEntities(t.text) }
    expectClose(name)
    return s
  }
  function node() {
    const t = toks[p++]
    if (!t || !t.open) throw new Error('Malformed plist: expected a value')
    const name = t.open
    if (name === 'true' || name === 'false') { if (!t.self) expectClose(name); return { t: name } }
    if (SCALARS.has(name) && name !== 'key') {
      if (t.self) return { t: name, v: '' }
      return { t: name, v: readText(name) }
    }
    if (name === 'array') {
      const items = []
      if (t.self) return { t: 'array', items }
      while (toks[p] && toks[p].close !== 'array') items.push(node())
      expectClose('array')
      return { t: 'array', items }
    }
    if (name === 'dict') {
      const entries = []
      if (t.self) return { t: 'dict', entries }
      while (toks[p] && toks[p].close !== 'dict') {
        const k = toks[p++]
        if (!k || k.open !== 'key') throw new Error('Malformed plist: expected <key>')
        const key = k.self ? '' : readText('key')
        entries.push([key, node()])
      }
      expectClose('dict')
      return { t: 'dict', entries }
    }
    throw new Error(`Unsupported plist element <${name}>`)
  }
  // Skip to <plist>
  while (p < toks.length && toks[p].open !== 'plist') p++
  if (p >= toks.length) throw new Error('Not an XML property list')
  p++
  const root = node()
  expectClose('plist')
  return root
}

function serialize(root) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">']
  const emit = (n, ind) => {
    const pad = '\t'.repeat(ind)
    switch (n.t) {
      case 'dict':
        if (!n.entries.length) { lines.push(`${pad}<dict/>`); break }
        lines.push(`${pad}<dict>`)
        for (const [k, v] of n.entries) { lines.push(`${pad}\t<key>${encodeText(k)}</key>`); emit(v, ind + 1) }
        lines.push(`${pad}</dict>`)
        break
      case 'array':
        if (!n.items.length) { lines.push(`${pad}<array/>`); break }
        lines.push(`${pad}<array>`)
        for (const v of n.items) emit(v, ind + 1)
        lines.push(`${pad}</array>`)
        break
      case 'true': case 'false': lines.push(`${pad}<${n.t}/>`); break
      case 'data': lines.push(`${pad}<data>${String(n.v).replace(/\s+/g, '')}</data>`); break
      default: lines.push(`${pad}<${n.t}>${encodeText(n.v)}</${n.t}>`)
    }
  }
  emit(root, 0)
  lines.push('</plist>')
  return lines.join('\n') + '\n'
}

function dictGet(dict, key) {
  if (!dict || dict.t !== 'dict') return undefined
  const e = dict.entries.find(([k]) => k === key)
  return e ? e[1] : undefined
}

/** Returns a NEW dict node with `key` replaced (all other entries shared). */
function dictSet(dict, key, value) {
  const entries = dict.entries.map(([k, v]) => [k, k === key ? value : v])
  if (!dict.entries.some(([k]) => k === key)) entries.push([key, value])
  return { t: 'dict', entries }
}

/** Structural equality of two typed trees. */
function equal(a, b) {
  if (a.t !== b.t) return false
  if (a.t === 'dict') {
    if (a.entries.length !== b.entries.length) return false
    return a.entries.every(([k, v], i) => b.entries[i][0] === k && equal(v, b.entries[i][1]))
  }
  if (a.t === 'array') return a.items.length === b.items.length && a.items.every((v, i) => equal(v, b.items[i]))
  if (a.t === 'data') return String(a.v).replace(/\s+/g, '') === String(b.v).replace(/\s+/g, '')
  return a.v === b.v
}

module.exports = { parse, serialize, dictGet, dictSet, equal }
