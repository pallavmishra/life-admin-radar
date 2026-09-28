'use strict'
/**
 * Kanban board adapter. PURE — operates on the parsed `kanban_v3_data` JSON
 * and never touches disk.
 *
 * ⚠️ The Kanban app's JSON schema is not documented anywhere the radar can
 * see, and a value of the wrong TYPE in a Swift Codable model does not fail
 * one card — it fails the decode of the whole board, which to the user looks
 * like the board being wiped. So this module works by EVIDENCE:
 *
 *   • The board, its lists and its cards are found by shape (a list is an
 *     object holding an array of card objects), not by assumed key names.
 *   • A new card is a CLONE of an existing card, so every field the app
 *     requires is present with a value of a type the app already accepted.
 *   • A field is only written in a format already seen on the board (date
 *     encoding, priority vocabulary, tag element type, id style).
 *   • Anything that has to be guessed is reported as a `confirm` issue. The
 *     dry-run shows it, and the live write refuses to run until the user has
 *     confirmed that exact plan (see sync.js).
 *   • Anything that cannot be done safely is a `blocking` issue — nothing is
 *     written.
 *
 * Every guess can be overridden with the `kanbanFieldOverrides` setting,
 * e.g. {"dueKey":"deadline","dateFormat":"iso8601","tagStyle":"string"}.
 */

const crypto = require('crypto')

const NAME_KEYS = ['title', 'name', 'label']
const CARD_ARRAY_KEYS = ['cards', 'items', 'tasks', 'tickets', 'todos']
const LIST_REF_KEYS = ['columnId', 'columnID', 'listId', 'listID', 'laneId', 'column', 'list', 'status', 'stage']
const ID_KEYS = ['id', 'uuid', '_id', 'identifier']
const TITLE_KEYS = ['title', 'name', 'text', 'content', 'summary']
const NOTES_KEYS = ['notes', 'note', 'description', 'details', 'body', 'desc']
const DUE_KEYS = ['dueDate', 'due_date', 'deadline', 'due', 'dueAt', 'dueOn', 'date']
const PRIORITY_KEYS = ['priority', 'importance']
const TAG_KEYS = ['tags', 'labels']
const CREATED_KEYS = ['createdAt', 'created_at', 'created', 'dateCreated', 'creationDate']
const UPDATED_KEYS = ['updatedAt', 'updated_at', 'modifiedAt', 'lastModified', 'dateModified']
const DONE_FLAG_KEYS = ['isDone', 'done', 'completed', 'isCompleted', 'isComplete', 'complete']

const APPLE_EPOCH_S = 978307200 // 2001-01-01T00:00:00Z

const RADAR_BLOCK_START = '--- Radar checklist ---'
const RADAR_BLOCK_END = '--- end radar ---'
const RADAR_TAG = 'radar'

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => JSON.parse(JSON.stringify(v))
const nameOf = (o) => { for (const k of NAME_KEYS) if (typeof o[k] === 'string') return o[k]; return '' }
const norm = (s) => String(s || '').trim().toLowerCase()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── shape detection ─────────────────────────────────────────────────────────

function nestedLayout(board) {
  for (const [k, v] of Object.entries(board)) {
    if (!Array.isArray(v) || !v.length || !v.every(isObj)) continue
    for (const ck of CARD_ARRAY_KEYS) {
      if (v.every(l => Array.isArray(l[ck]) && l[ck].every(isObj))) return { mode: 'nested', listsKey: k, cardsKey: ck }
    }
  }
  return null
}

function flatLayout(board) {
  const arrays = Object.entries(board).filter(([, v]) => Array.isArray(v) && v.length && v.every(isObj))
  for (const [lk, lists] of arrays) {
    const idKey = ID_KEYS.find(k => lists.every(l => l[k] != null))
    if (!idKey || !lists.every(l => nameOf(l))) continue
    const ids = new Set(lists.map(l => String(l[idKey])))
    for (const [ck, cards] of arrays) {
      if (ck === lk) continue
      const refKey = LIST_REF_KEYS.find(r => cards.every(c => c[r] != null && ids.has(String(c[r]))))
      if (refKey) return { mode: 'flat', listsKey: lk, cardsKey: ck, listIdKey: idKey, refKey }
    }
  }
  return null
}

/** Depth-first search for the board named `boardName`. */
function findBoard(root, boardName) {
  const want = norm(boardName)
  const found = []
  const seen = new Set()
  const walk = (v, path) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (isObj(v) && norm(nameOf(v)) === want) {
      const layout = nestedLayout(v) || flatLayout(v)
      if (layout) found.push({ board: v, path, layout })
    }
    for (const [k, c] of Object.entries(v)) walk(c, path.concat(k))
  }
  walk(root, [])
  return found
}

/** Names of every board-shaped object, for an error message that helps. */
function boardNames(root) {
  const names = []
  const walk = (v) => {
    if (!v || typeof v !== 'object') return
    if (isObj(v) && nameOf(v) && (nestedLayout(v) || flatLayout(v))) names.push(nameOf(v))
    for (const c of Object.values(v)) walk(c)
  }
  walk(root)
  return names
}

function firstKeyPresent(objs, keys) {
  return keys.find(k => objs.some(o => Object.prototype.hasOwnProperty.call(o, k))) || null
}

function detectDateFormat(values) {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v > 1e12) return { format: 'epochMs', evidence: v }
      if (v > 1.5e9) return { format: 'epochSeconds', evidence: v }
      if (v > 1e8) return { format: 'appleReference', evidence: v }
    }
    if (typeof v === 'string') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { format: 'dayKey', evidence: v }
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
        return { format: /\.\d+/.test(v) ? 'iso8601ms' : 'iso8601', evidence: v }
      }
    }
  }
  return null
}

function detectIdStyle(ids) {
  const s = ids.filter(v => v != null)
  if (!s.length) return null
  if (s.every(v => typeof v === 'number' && Number.isInteger(v))) return 'int'
  if (s.every(v => typeof v === 'string' && UUID_RE.test(v))) {
    return s.every(v => v === v.toUpperCase()) ? 'uuid-upper' : 'uuid-lower'
  }
  if (s.every(v => typeof v === 'string' && /^\d+$/.test(v))) return 'string-int'
  return 'string'
}

/**
 * Analyse the board. Returns everything the planner needs plus the issue
 * list. `issues` entries: { level: 'blocking'|'confirm'|'info', code, message }.
 */
function analyze(root, { boardName = 'My First Board', overrides = {} } = {}) {
  const issues = []
  const add = (level, code, message) => issues.push({ level, code, message })

  const matches = findBoard(root, boardName)
  if (!matches.length) {
    const names = boardNames(root)
    add('blocking', 'board-not-found', `No board named "${boardName}" was found.` +
      (names.length ? ` Boards seen: ${names.map(n => `"${n}"`).join(', ')}.` : ' No board-shaped data was recognised at all.'))
    return { ok: false, issues }
  }
  if (matches.length > 1) {
    add('blocking', 'board-ambiguous', `${matches.length} boards are named "${boardName}" — refusing to guess which one.`)
    return { ok: false, issues }
  }
  const { board, path, layout } = matches[0]

  const listNodes = board[layout.listsKey]
  const listIdKey = layout.listIdKey || firstKeyPresent(listNodes, ID_KEYS)
  const lists = listNodes.map((node, index) => ({ node, index, title: nameOf(node), id: listIdKey ? node[listIdKey] : null }))
  const cardsOf = (list) => layout.mode === 'nested'
    ? list.node[layout.cardsKey]
    : board[layout.cardsKey].filter(c => String(c[layout.refKey]) === String(list.id))
  const allCards = layout.mode === 'nested' ? lists.flatMap(cardsOf) : board[layout.cardsKey]

  const findList = (res) => { for (const re of res) { const l = lists.find(x => re.test(x.title)); if (l) return l } return null }
  let backlog = overrides.backlogList ? lists.find(l => norm(l.title) === norm(overrides.backlogList)) : null
  backlog = backlog || findList([/^backlog$/i, /^inbox$/i, /backlog/i, /inbox/i, /^to[\s-]?do$/i, /\bto[\s-]?do\b/i])
  if (!backlog) {
    backlog = lists[0]
    add('confirm', 'backlog-guessed', `No list named Backlog or Inbox — new cards would go to the first list, "${backlog.title}".`)
  }
  let done = overrides.doneList ? lists.find(l => norm(l.title) === norm(overrides.doneList)) : null
  done = done || findList([/^done$/i, /\bdone\b/i, /complete/i, /finished/i])
  if (!done) add('info', 'done-missing', 'No Done list found — completed radar items cannot be moved.')

  // ── field keys (evidence first, then override, then guess) ──
  const sample = allCards.length ? allCards : []
  const pick = (name, candidates, fallback, { required = false } = {}) => {
    if (overrides[name]) return { key: overrides[name], source: 'override' }
    const k = firstKeyPresent(sample, candidates)
    if (k) return { key: k, source: 'board' }
    if (required) return { key: null, source: 'missing' }
    return { key: fallback, source: 'guess' }
  }
  const keys = {
    id: pick('idKey', ID_KEYS, null, { required: true }),
    title: pick('titleKey', TITLE_KEYS, null, { required: true }),
    notes: pick('notesKey', NOTES_KEYS, 'notes'),
    due: pick('dueKey', DUE_KEYS, 'dueDate'),
    priority: pick('priorityKey', PRIORITY_KEYS, 'priority'),
    tags: pick('tagsKey', TAG_KEYS, 'tags'),
    created: pick('createdKey', CREATED_KEYS, null),
    updated: pick('updatedKey', UPDATED_KEYS, null),
  }
  if (!sample.length) add('blocking', 'no-cards', `"${boardName}" has no cards, so there is no example of the card format to copy. Add any card in Kanban Board first.`)
  if (!keys.id.key) add('blocking', 'no-card-id', 'Cards have no id field — the radar could not keep track of which card is whose.')
  if (!keys.title.key) add('blocking', 'no-card-title', 'Could not tell which card field is the title.')
  for (const [f, label] of [['notes', 'notes'], ['due', 'due date'], ['priority', 'priority'], ['tags', 'tags']]) {
    if (keys[f].source === 'guess') {
      add('confirm', `${f}-key-guessed`, `No card on the board has a ${label} yet, so its field name is a guess: "${keys[f].key}".`)
    }
  }

  // ── date format ──
  const dateValues = []
  for (const c of sample) for (const k of [keys.due.key, keys.created.key, keys.updated.key]) if (k && c[k] != null) dateValues.push(c[k])
  for (const l of listNodes) for (const k of CREATED_KEYS) if (l[k] != null) dateValues.push(l[k])
  for (const k of CREATED_KEYS.concat(UPDATED_KEYS)) if (board[k] != null) dateValues.push(board[k])
  let dateFormat = overrides.dateFormat ? { format: overrides.dateFormat, evidence: 'override' } : detectDateFormat(dateValues)
  const idStyle = detectIdStyle(sample.map(c => keys.id.key && c[keys.id.key]))
  if (!dateFormat) {
    dateFormat = { format: idStyle === 'uuid-upper' ? 'appleReference' : 'iso8601', evidence: null }
    add('confirm', 'date-format-guessed', `No dates on the board to copy the format from — guessing "${dateFormat.format}"` +
      (dateFormat.format === 'appleReference' ? ' (Swift\'s default: seconds since 2001).' : '.'))
  }

  // ── priority vocabulary ──
  const prioValues = [...new Set(sample.map(c => c[keys.priority.key]).filter(v => v != null))]
  let priority = { mode: 'skip', values: prioValues }
  if (overrides.priorityValues) priority = { mode: 'map', values: overrides.priorityValues }
  else if (prioValues.length && prioValues.every(v => typeof v === 'string')) priority = { mode: 'map', values: prioValues }
  else if (prioValues.length && prioValues.every(v => typeof v === 'number')) {
    priority = { mode: 'skip', values: prioValues }
    add('confirm', 'priority-numeric', `Priorities are numbers (${prioValues.join(', ')}) — which number means "high" is not knowable, so new cards keep the copied card's priority. Set priorityValues in overrides to map them.`)
  } else if (keys.priority.source !== 'board') {
    priority = { mode: 'guess', values: ['high', 'medium', 'low'] }
  } else {
    add('confirm', 'priority-unknown', 'No card has a priority value yet — priority will not be set.')
  }

  // ── tag element style ──
  const tagEls = sample.flatMap(c => Array.isArray(c[keys.tags.key]) ? c[keys.tags.key] : [])
  let tagStyle = overrides.tagStyle || null
  let tagTemplate = null
  if (!tagStyle) {
    if (tagEls.length && tagEls.every(t => typeof t === 'string')) {
      tagStyle = tagEls.every(t => UUID_RE.test(t)) ? 'ref' : 'string'
    } else if (tagEls.length && tagEls.every(isObj)) {
      tagStyle = 'object'
      tagTemplate = tagEls.find(t => norm(nameOf(t)) === RADAR_TAG) || tagEls[0]
    } else if (keys.tags.source === 'board') {
      tagStyle = 'skip'
      add('confirm', 'tags-empty', 'Cards have a tags field but none has a tag yet, so the tag format is unknown — the "radar" tag will not be added. Set tagStyle in overrides to enable it.')
    } else {
      tagStyle = 'string'
    }
  }
  if (tagStyle === 'ref') {
    add('confirm', 'tags-are-refs', 'Tags are stored as references to a tag list — the radar will not add a "radar" tag (it could break the board).')
    tagStyle = 'skip'
  }

  // ── integers the JSON round trip cannot preserve ──
  let unsafe = 0
  const walk = (v) => {
    if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) unsafe++
    else if (v && typeof v === 'object') for (const c of Object.values(v)) walk(c)
  }
  walk(root)
  if (unsafe) add('blocking', 'unsafe-integers', `${unsafe} number(s) on the board are too large to round-trip exactly — refusing to rewrite it.`)

  // ── fields the planner must keep consistent (seen on real boards) ──
  const known = new Set(Object.values(keys).map(v => v.key).filter(Boolean))

  // A card-level back-reference to its own list (e.g. `listId`) in a nested
  // board: every card's value equals the id of the list that holds it. It
  // must follow the card when the card moves, or the app sees a card that
  // claims to live somewhere else.
  let parentRefKey = null
  if (layout.mode === 'nested' && sample.length && lists.every(l => l.id != null)) {
    const cands = Object.keys(sample[0]).filter(key => !known.has(key))
    parentRefKey = cands.find(key => lists.every(l => cardsOf(l).every(c => c[key] != null && String(c[key]) === String(l.id)))) || null
  }
  if (parentRefKey) known.add(parentRefKey)

  // Per-field profile, so a cloned card gets fresh values where the board's
  // values are per-card (story numbers, free text, secondary ids) and keeps
  // them where they are shared settings (item type, board id).
  const fieldProfile = {}
  for (const key of new Set(sample.flatMap(c => Object.keys(c)))) {
    if (known.has(key)) continue
    const vals = sample.map(c => c[key]).filter(v => typeof v === 'string')
    if (vals.length < 2) continue
    const distinct = new Set(vals)
    const unique = distinct.size === vals.length
    if (unique && vals.every(v => UUID_RE.test(v))) fieldProfile[key] = 'uuid'
    else if (unique && vals.every(v => /^(.*?)(\d+)$/.test(v))) fieldProfile[key] = 'sequence'
    else if (distinct.size > 10 || distinct.size / vals.length > 0.5) fieldProfile[key] = 'text'
    else fieldProfile[key] = 'enum'
  }
  const sequenceKeys = Object.keys(fieldProfile).filter(k2 => fieldProfile[k2] === 'sequence')

  // The card new cards are cloned from: the most TYPICAL card (matching the
  // board's most common value on the most shared-setting fields), so a new
  // card is a Story like most, not an Epic like one.
  const enumKeys = Object.keys(fieldProfile).filter(k2 => fieldProfile[k2] === 'enum').concat(keys.priority.key ? [keys.priority.key] : [])
  const mode = {}
  for (const key of enumKeys) {
    const counts = new Map()
    for (const c of sample) if (c[key] != null) counts.set(JSON.stringify(c[key]), (counts.get(JSON.stringify(c[key])) || 0) + 1)
    mode[key] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  }
  const typicality = (c) => enumKeys.reduce((n, key) => n + (JSON.stringify(c[key]) === mode[key] ? 1 : 0), 0)
  const pool = backlog && cardsOf(backlog).length ? cardsOf(backlog) : sample
  const templateCard = pool.slice().sort((a, b) => typicality(b) - typicality(a))[0] || null

  // Board-level fields (keys + scalar values only — never card content),
  // so a dry run shows whether the app keeps its own counters.
  const boardFields = {}
  for (const [key, v] of Object.entries(board)) {
    if (key === layout.listsKey || (layout.mode === 'flat' && key === layout.cardsKey)) continue
    boardFields[key] = Array.isArray(v) ? `array(${v.length})` : isObj(v) ? 'object' : typeof v === 'number' || typeof v === 'boolean' ? v : typeof v
  }

  return {
    ok: !issues.some(i => i.level === 'blocking'),
    issues, board, path, layout, lists, cardsOf, allCards, backlog, done, keys,
    dateFormat, idStyle, priority, tagStyle, tagTemplate,
    parentRefKey, fieldProfile, sequenceKeys, templateCard, boardFields,
  }
}

/** Next value of a per-card sequence like "MFB-S-033": same prefix as `like`, max + 1. */
function nextSequence(cards, key, like) {
  const m = /^(.*?)(\d+)$/.exec(String(like))
  const prefix = m ? m[1] : ''
  const width = m ? m[2].length : 1
  let max = 0
  for (const c of cards) {
    const mm = /^(.*?)(\d+)$/.exec(String(c[key] ?? ''))
    if (mm && mm[1] === prefix) max = Math.max(max, Number(mm[2]))
  }
  return prefix + String(max + 1).padStart(width, '0')
}

// ── value encoders ─────────────────────────────────────────────────────────

/** Local noon of a day key, as a Date — noon so no timezone shows it as the day before. */
function localNoon(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0)
}

function encodeDate(date, format) {
  const ms = date.getTime()
  switch (format) {
    case 'appleReference': return ms / 1000 - APPLE_EPOCH_S
    case 'epochSeconds': return Math.round(ms / 1000)
    case 'epochMs': return ms
    case 'iso8601ms': return date.toISOString()
    case 'dayKey': {
      const p = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
    }
    case 'iso8601':
    default: return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
}

function newId(shape, allCards) {
  const style = shape.idStyle
  const key = shape.keys.id.key
  if (style === 'int' || style === 'string-int') {
    const max = allCards.reduce((m, c) => Math.max(m, Number(c[key]) || 0), 0)
    return style === 'int' ? max + 1 : String(max + 1)
  }
  const u = crypto.randomUUID()
  return style === 'uuid-upper' ? u.toUpperCase() : u
}

const PRIO_SYNONYMS = {
  high: ['high', 'urgent', 'p1', 'important', 'critical'],
  medium: ['medium', 'normal', 'med', 'p2', 'moderate'],
  low: ['low', 'p3', 'minor'],
}
function priorityValue(shape, want) {
  if (shape.priority.mode === 'skip') return undefined
  if (shape.priority.mode === 'guess') return want
  // Only the board's own vocabulary; if it has never shown a "low", fall
  // back to its neutral values rather than inventing one.
  const chain = { high: PRIO_SYNONYMS.high, medium: PRIO_SYNONYMS.medium, low: [...PRIO_SYNONYMS.low, 'none', ...PRIO_SYNONYMS.medium] }[want]
  for (const syn of chain) {
    const hit = shape.priority.values.find(v => norm(v) === syn)
    if (hit != null) return hit
  }
  return undefined
}

// ── notes block ────────────────────────────────────────────────────────────

function checklistBlock(checklist) {
  const lines = checklist.map(c => `${c.is_done ? '☑' : '☐'} ${c.label}${c.location_hint ? ` — ${c.location_hint}` : ''}`)
  return [RADAR_BLOCK_START, ...(lines.length ? lines : ['(no documents listed)']), RADAR_BLOCK_END].join('\n')
}

/** Append the radar block, or replace it in place if it is already there. */
function mergeNotes(existing, checklist) {
  const block = checklistBlock(checklist)
  const text = typeof existing === 'string' ? existing : ''
  const start = text.indexOf(RADAR_BLOCK_START)
  const end = text.indexOf(RADAR_BLOCK_END)
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + RADAR_BLOCK_END.length)
  return text.trim() ? `${text.replace(/\s+$/, '')}\n\n${block}` : block
}

// ── card edits ─────────────────────────────────────────────────────────────

function withTag(shape, tags) {
  const list = Array.isArray(tags) ? tags.slice() : []
  if (shape.tagStyle === 'string') {
    if (!list.some(t => typeof t === 'string' && norm(t) === RADAR_TAG)) list.push(RADAR_TAG)
    return list
  }
  if (shape.tagStyle === 'object') {
    if (list.some(t => isObj(t) && norm(nameOf(t)) === RADAR_TAG)) return list
    const t = clone(shape.tagTemplate)
    if (norm(nameOf(t)) !== RADAR_TAG) {
      const nk = NAME_KEYS.find(k => typeof t[k] === 'string')
      t[nk] = RADAR_TAG
      const ik = ID_KEYS.find(k => t[k] != null)
      if (ik) t[ik] = typeof t[ik] === 'number' ? Date.now() : (UUID_RE.test(t[ik]) && t[ik] === t[ik].toUpperCase() ? crypto.randomUUID().toUpperCase() : crypto.randomUUID())
    }
    list.push(t)
    return list
  }
  return list
}

/** Apply radar fields onto a card object (mutates `card`). */
function stampCard(shape, card, { item, checklist, priority, now, setPriority = false }) {
  const k = shape.keys
  if (item.due_date) card[k.due.key] = encodeDate(localNoon(item.due_date), shape.dateFormat.format)
  // Priority is Radar's to set on cards it CREATES. On a card the user
  // already had (a linked match), their priority stands.
  const pv = setPriority ? priorityValue(shape, priority) : undefined
  if (pv !== undefined) card[k.priority.key] = pv
  if (shape.tagStyle !== 'skip') card[k.tags.key] = withTag(shape, card[k.tags.key])
  card[k.notes.key] = mergeNotes(card[k.notes.key], checklist)
  if (k.updated.key && Object.prototype.hasOwnProperty.call(card, k.updated.key)) {
    card[k.updated.key] = encodeDate(now, shape.dateFormat.format)
  }
  return card
}

/**
 * A new card, cloned from an existing one so every required field exists
 * with an accepted type. Arrays (sub-tasks, attachments, comments) are
 * emptied; done-flags are cleared; everything else keeps the example's
 * value — an enum like `color: "blue"` stays valid, whereas blanking it
 * would not.
 */
function newCard(shape, { item, checklist, priority, now }) {
  const template = shape.templateCard || shape.cardsOf(shape.backlog)[0] || shape.allCards[0]
  const card = clone(template)
  const k = shape.keys
  for (const [key, v] of Object.entries(card)) {
    if (Array.isArray(v) && key !== k.tags.key) card[key] = []
    if (DONE_FLAG_KEYS.includes(key) && typeof v === 'boolean') card[key] = false
    const prof = (shape.fieldProfile || {})[key]
    if (prof === 'text' && typeof v === 'string') card[key] = ''
    if (prof === 'uuid') card[key] = UUID_RE.test(v) && v === v.toUpperCase() ? crypto.randomUUID().toUpperCase() : crypto.randomUUID()
    if (prof === 'sequence') card[key] = nextSequence(shape.allCards, key, v)
  }
  if (shape.parentRefKey) card[shape.parentRefKey] = shape.backlog.id
  if (Array.isArray(card[k.tags.key])) card[k.tags.key] = []
  card[k.id.key] = newId(shape, shape.allCards)
  card[k.title.key] = item.title
  card[k.notes.key] = ''
  if (!item.due_date) delete card[k.due.key]
  if (k.created.key && Object.prototype.hasOwnProperty.call(card, k.created.key)) card[k.created.key] = encodeDate(now, shape.dateFormat.format)
  if (shape.layout.mode === 'flat') card[shape.layout.refKey] = shape.backlog.id
  return stampCard(shape, card, { item, checklist, priority, now, setPriority: true })
}

module.exports = {
  analyze, findBoard, detectDateFormat, detectIdStyle, encodeDate, localNoon,
  mergeNotes, checklistBlock, stampCard, newCard, withTag, priorityValue, nextSequence,
  RADAR_BLOCK_START, RADAR_BLOCK_END, RADAR_TAG, DONE_FLAG_KEYS, APPLE_EPOCH_S, nameOf,
}
