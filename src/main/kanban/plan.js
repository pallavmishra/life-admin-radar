'use strict'
/**
 * Plan a push: take the board JSON + the radar's requests, return the
 * complete NEW board JSON and a per-item account of what would change.
 * PURE — the original object is never mutated; everything happens on a
 * deep copy. The dry-run and the live write both call this; the live write
 * then writes exactly the JSON the plan produced.
 */
const { analyze, stampCard, newCard, nameOf, DONE_FLAG_KEYS } = require('./board')
const { bestMatch } = require('./match')

const clone = (v) => JSON.parse(JSON.stringify(v))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * @param {object} root  parsed kanban_v3_data
 * @param {object} opts
 * @param {Array<{ item, checklist, op: 'upsert'|'complete', link, priority, manualCardId?, forceCreate? }>} opts.requests
 * @param {Set<string>} opts.linkedCardIds  card ids already linked to ANY radar item
 * @param {Date} opts.now
 */
function planPush(root, { requests, linkedCardIds = new Set(), boardName, overrides, now = new Date() }) {
  const next = clone(root)
  const shape = analyze(next, { boardName, overrides })
  if (!shape.ok) return { ok: false, issues: shape.issues, results: [], newRoot: null, shape: summarize(shape) }

  const k = shape.keys
  const idOf = (c) => String(c[k.id.key])
  const findCard = (id) => shape.allCards.find(c => idOf(c) === String(id)) || null
  const listOfCard = (card) => shape.lists.find(l => shape.cardsOf(l).includes(card)) || null
  const claimed = new Set([...linkedCardIds].map(String))
  const results = []

  for (const req of requests) {
    const { item, checklist = [], op, link, priority = 'medium' } = req
    const base = { itemId: item.id, itemTitle: item.title, op }

    if (op === 'complete') {
      const card = link && findCard(link.card_id)
      if (!card) { results.push({ ...base, action: 'skip', reason: 'The linked card is no longer on the board.' }); continue }
      if (!shape.done) { results.push({ ...base, action: 'skip', reason: 'There is no Done list to move it to.', cardId: idOf(card) }); continue }
      const from = listOfCard(card)
      if (from === shape.done) { results.push({ ...base, action: 'unchanged', cardId: idOf(card), cardTitle: card[k.title.key], list: shape.done.title }); continue }
      const before = clone(card)
      for (const f of DONE_FLAG_KEYS) if (typeof card[f] === 'boolean') card[f] = true
      if (shape.layout.mode === 'nested') {
        const src = from.node[shape.layout.cardsKey]
        src.splice(src.indexOf(card), 1)
        shape.done.node[shape.layout.cardsKey].push(card)
      } else {
        card[shape.layout.refKey] = shape.done.id
      }
      results.push({ ...base, action: 'move-to-done', cardId: idOf(card), cardTitle: card[k.title.key], fromList: from && from.title, list: shape.done.title, before, after: clone(card) })
      continue
    }

    // upsert
    if (link) {
      const card = findCard(link.card_id)
      if (!card) { results.push({ ...base, action: 'orphaned', cardId: link.card_id, reason: 'The linked card was removed from the board — the radar will not re-create it.' }); continue }
      const before = clone(card)
      stampCard(shape, card, { item, checklist, priority, now })
      results.push({ ...base, action: same(before, card) ? 'unchanged' : 'update', cardId: idOf(card), cardTitle: card[k.title.key], list: (listOfCard(card) || {}).title, before, after: clone(card) })
      continue
    }

    let target = null
    let match = null
    if (req.manualCardId) {
      target = findCard(req.manualCardId)
      if (!target) { results.push({ ...base, action: 'skip', reason: `Card ${req.manualCardId} is not on the board.` }); continue }
    } else if (!req.forceCreate) {
      const candidates = shape.allCards
        .filter(c => !claimed.has(idOf(c)) && listOfCard(c) !== shape.done)
        .map(c => ({ id: idOf(c), title: String(c[k.title.key] || ''), ref: c }))
      match = bestMatch(item.title, candidates)
      if (match) target = match.card.ref
    }

    if (target) {
      const before = clone(target)
      stampCard(shape, target, { item, checklist, priority, now })
      claimed.add(idOf(target))
      results.push({
        ...base, action: 'link', cardId: idOf(target), cardTitle: target[k.title.key], list: (listOfCard(target) || {}).title,
        match: match ? { score: match.score, alternatives: match.alternatives.map(a => ({ id: a.card.id, title: a.card.title })) } : { manual: true },
        before, after: clone(target),
      })
      continue
    }

    const card = newCard(shape, { item, checklist, priority, now })
    if (shape.layout.mode === 'nested') shape.backlog.node[shape.layout.cardsKey].push(card)
    else shape.board[shape.layout.cardsKey].push(card)
    shape.allCards.push(card)
    claimed.add(idOf(card))
    results.push({ ...base, action: 'create', cardId: idOf(card), cardTitle: card[k.title.key], list: shape.backlog.title, after: clone(card) })
  }

  const inv = checkInvariants(root, next, { boardName, overrides, results })
  const issues = shape.issues.concat(inv.issues)
  return {
    ok: !issues.some(i => i.level === 'blocking'),
    issues, results, newRoot: next, shape: summarize(shape), invariants: inv.facts,
  }
}

/**
 * The guard against "the push destroyed the board". Compares the board
 * before and after and blocks unless the ONLY differences are the ones the
 * plan claims: cards created, cards stamped, cards moved to Done.
 */
function checkInvariants(before, after, { boardName, overrides, results }) {
  const issues = []
  const a = analyze(clone(before), { boardName, overrides })
  const b = analyze(clone(after), { boardName, overrides })
  if (!a.ok || !b.ok) return { issues: [{ level: 'blocking', code: 'reanalyze-failed', message: 'The new board could not be re-read.' }], facts: {} }
  const kid = a.keys.id.key
  const idsA = new Set(a.allCards.map(c => String(c[kid])))
  const idsB = new Set(b.allCards.map(c => String(c[kid])))
  const created = results.filter(r => r.action === 'create').map(r => String(r.cardId))
  const touched = new Set(results.filter(r => r.after).map(r => String(r.cardId)))

  const lost = [...idsA].filter(id => !idsB.has(id))
  if (lost.length) issues.push({ level: 'blocking', code: 'cards-lost', message: `${lost.length} existing card(s) would disappear.` })
  if (idsB.size !== idsA.size + created.length) issues.push({ level: 'blocking', code: 'card-count', message: `Card count would change by ${idsB.size - idsA.size}, expected +${created.length}.` })
  if (b.lists.length !== a.lists.length || b.lists.some((l, i) => l.title !== a.lists[i].title)) {
    issues.push({ level: 'blocking', code: 'lists-changed', message: 'The board\'s lists would change.' })
  }
  const byIdB = new Map(b.allCards.map(c => [String(c[kid]), c]))
  const changedUntouched = a.allCards.filter(c => !touched.has(String(c[kid])) && !same(c, byIdB.get(String(c[kid]))))
  if (changedUntouched.length) issues.push({ level: 'blocking', code: 'collateral', message: `${changedUntouched.length} card(s) the radar did not intend to touch would change.` })

  // Everything outside this board must be byte-for-byte the same.
  const strip = (root, path) => { const r = clone(root); let o = r; for (const p of path.slice(0, -1)) o = o[p]; if (path.length) o[path[path.length - 1]] = null; else return null; return r }
  if (!same(strip(before, a.path), strip(after, b.path))) {
    issues.push({ level: 'blocking', code: 'outside-board', message: 'Data outside "' + (boardName || 'the board') + '" would change.' })
  }
  // And the board's own fields other than its cards.
  const boardMeta = (s) => { const o = clone(s.board); delete o[s.layout.listsKey]; if (s.layout.mode === 'flat') delete o[s.layout.cardsKey]; return o }
  if (!same(boardMeta(a), boardMeta(b))) issues.push({ level: 'blocking', code: 'board-meta', message: 'The board\'s own settings would change.' })

  return { issues, facts: { cardsBefore: idsA.size, cardsAfter: idsB.size, created: created.length } }
}

/** A JSON-safe description of the detected schema, for the dry-run screen. */
function summarize(shape) {
  if (!shape || !shape.board) return null
  return {
    board: nameOf(shape.board),
    path: shape.path.join('.'),
    layout: shape.layout,
    lists: shape.lists.map(l => ({ title: l.title, cards: shape.cardsOf(l).length })),
    backlog: shape.backlog && shape.backlog.title,
    done: shape.done && shape.done.title,
    keys: Object.fromEntries(Object.entries(shape.keys).map(([n, v]) => [n, `${v.key ?? '—'} (${v.source})`])),
    dateFormat: shape.dateFormat,
    idStyle: shape.idStyle,
    priority: shape.priority,
    tagStyle: shape.tagStyle,
    cards: shape.allCards.map(c => ({ id: String(c[shape.keys.id.key]), title: String(c[shape.keys.title.key] || '') })),
  }
}

module.exports = { planPush, checkInvariants }
