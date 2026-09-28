import { describe, it, expect } from 'vitest'
import plist from '../src/main/kanban/plistXml.js'
import boardMod from '../src/main/kanban/board.js'
import planMod from '../src/main/kanban/plan.js'
import fx from './fixtures/makeKanbanFixture.js'

const { planPush } = planMod
const now = new Date(2026, 8, 28, 9, 0, 0)
const item = (id, title, due_date = null, o = {}) => ({ id, title, due_date, kind: 'dated', status: 'upcoming', ...o })
const upsert = (it, checklist = [], o = {}) => ({ item: it, op: 'upsert', checklist, link: null, priority: 'high', ...o })
const opts = (requests, o = {}) => ({ requests, boardName: 'My First Board', now, ...o })
const backlogTitles = (root) => root.boards[0].columns[0].cards.map(c => c.title)

describe('XML plist', () => {
  it('round-trips losslessly (numbers, dates, data, booleans, key order)', () => {
    const xml = fx.plistXml()
    const tree = plist.parse(xml)
    expect(plist.serialize(tree)).toBe(xml)
    expect(tree.entries.map(e => e[0])).toEqual(['NSWindow Frame main', 'kanban_v3_data', 'launchCount', 'lastOpened', 'showCompleted', 'zoom'])
    expect(plist.dictGet(tree, 'zoom').v).toBe('1.1000000000000001')
  })
  it('decodes entities and CDATA', () => {
    const t = plist.parse('<?xml version="1.0"?><plist version="1.0"><dict><key>a&amp;b</key><string>&lt;x&gt; &#x263A;</string><key>c</key><string><![CDATA[<raw>]]></string></dict></plist>')
    expect(t.entries[0][0]).toBe('a&b')
    expect(t.entries[0][1].v).toBe('<x> ☺')
    expect(t.entries[1][1].v).toBe('<raw>')
  })
})

describe('board analysis', () => {
  it('finds My First Board and infers the schema from evidence', () => {
    const s = boardMod.analyze(fx.board())
    expect(s.ok).toBe(true)
    expect(s.layout).toMatchObject({ mode: 'nested', listsKey: 'columns', cardsKey: 'cards' })
    expect(s.backlog.title).toBe('Backlog')
    expect(s.done.title).toBe('Done')
    expect(s.keys.due).toEqual({ key: 'dueDate', source: 'board' })
    expect(s.dateFormat.format).toBe('appleReference')
    expect(s.idStyle).toBe('uuid-upper')
    expect(s.tagStyle).toBe('string')
    expect(s.priority.mode).toBe('map')
  })
  it('blocks when the board is missing, and names the boards it saw', () => {
    const s = boardMod.analyze(fx.board(), { boardName: 'Nope' })
    expect(s.ok).toBe(false)
    expect(s.issues[0].message).toMatch(/"My First Board", "Work"/)
  })
  it('flags guesses as confirm issues when the board has no dates or tags yet', () => {
    const b = fx.board()
    for (const col of b.boards[0].columns) for (const c of col.cards) { delete c.dueDate; c.tags = []; delete c.createdAt }
    delete b.boards[0].createdAt
    const s = boardMod.analyze(b)
    expect(s.ok).toBe(true)
    const codes = s.issues.map(i => i.code)
    expect(codes).toContain('due-key-guessed')
    expect(codes).toContain('date-format-guessed')
    expect(codes).toContain('tags-empty')
    expect(s.tagStyle).toBe('skip')
  })
  it('encodes dates the way the board does', () => {
    const noon = boardMod.localNoon('2027-03-14')
    expect(boardMod.encodeDate(noon, 'appleReference')).toBe(noon.getTime() / 1000 - 978307200)
    expect(boardMod.encodeDate(noon, 'dayKey')).toBe('2027-03-14')
    expect(boardMod.encodeDate(noon, 'iso8601')).toMatch(/^2027-03-1\dT\d\d:00:00Z$/)
  })
})

describe('dedupe: link, do not duplicate', () => {
  it('links the three dateless cards from the brief instead of creating new ones', () => {
    const root = fx.board()
    const reqs = [
      upsert(item(1, 'Book colonoscopy appointment'), [{ label: 'Get PCP referral', is_done: 0 }, { label: 'Confirm coded as preventive/screening for $0 coverage', is_done: 1 }]),
      upsert(item(2, 'Book prostate appointment')),
      upsert(item(3, 'H-1B: I-94 expires', '2027-03-14'), [{ label: 'Passport', is_done: 0, location_hint: '~/H1 Documents' }]),
    ]
    const p = planPush(root, opts(reqs))
    expect(p.ok).toBe(true)
    expect(p.results.map(r => [r.action, r.cardTitle])).toEqual([
      ['link', 'Colonoscopy Appointment'], ['link', 'Prostate Appointment'], ['link', 'Visa Renewal'],
    ])
    expect(p.invariants).toEqual({ cardsBefore: 6, cardsAfter: 6, created: 0 })
    // no new cards anywhere
    expect(backlogTitles(p.newRoot)).toEqual(backlogTitles(root))
    const visa = p.newRoot.boards[0].columns[0].cards[2]
    expect(visa.tags).toEqual(['admin', 'radar'])
    expect(visa.dueDate).toBe(boardMod.localNoon('2027-03-14').getTime() / 1000 - 978307200)
    expect(visa.notes).toContain('☐ Passport — ~/H1 Documents')
    expect(visa.priority).toBe('medium') // a linked card keeps the user's own priority
    // Dateless nags get tagged + checklist but no deadline
    const colo = p.newRoot.boards[0].columns[0].cards[0]
    expect(colo.dueDate).toBeUndefined()
    expect(colo.notes).toBe('--- Radar checklist ---\n☐ Get PCP referral\n☑ Confirm coded as preventive/screening for $0 coverage\n--- end radar ---')
    // the original object is untouched
    expect(root.boards[0].columns[0].cards[2].tags).toEqual(['admin'])
  })
  it('never matches a card on another board or one already linked', () => {
    const p = planPush(fx.board(), opts([upsert(item(1, 'Book colonoscopy appointment'))], { linkedCardIds: new Set([fx.U(1)]) }))
    expect(p.results[0].action).toBe('create') // "Colonoscopy slides" on Work is not a candidate
  })
  it('honours a manual choice or a forced create', () => {
    const p1 = planPush(fx.board(), opts([upsert(item(9, 'Something'), [], { manualCardId: fx.U(4) })]))
    expect(p1.results[0]).toMatchObject({ action: 'link', cardTitle: 'Buy printer ink' })
    const p2 = planPush(fx.board(), opts([upsert(item(1, 'Book colonoscopy appointment'), [], { forceCreate: true })]))
    expect(p2.results[0].action).toBe('create')
  })
})

describe('create / update / complete', () => {
  it('creates a card in Backlog cloned from an existing card, with radar fields', () => {
    const p = planPush(fx.board(), opts([upsert(item(7, "Driver's license renewal", '2026-11-20'), [{ label: 'Current license', is_done: 0 }])]))
    expect(p.ok).toBe(true)
    const r = p.results[0]
    expect(r).toMatchObject({ action: 'create', list: 'Backlog', cardTitle: "Driver's license renewal" })
    const card = r.after
    expect(card.id).toMatch(/^[0-9A-F-]{36}$/)
    expect(card.tags).toEqual(['radar'])
    expect(card.checklist).toEqual([])
    expect(card.isCompleted).toBe(false)
    expect(card.color).toBe('blue') // enum-ish field kept from the example card
    expect(typeof card.dueDate).toBe('number')
    expect(card.createdAt).toBeCloseTo(now.getTime() / 1000 - 978307200, 3)
    expect(p.invariants).toEqual({ cardsBefore: 6, cardsAfter: 7, created: 1 })
    expect(backlogTitles(p.newRoot).at(-1)).toBe("Driver's license renewal")
  })
  it('updates a linked card when the due date changes, replacing (not duplicating) the checklist block', () => {
    const first = planPush(fx.board(), opts([upsert(item(3, 'H-1B: I-94 expires', '2027-03-14'), [{ label: 'A', is_done: 0 }])]))
    const link = { card_id: first.results[0].cardId }
    const second = planPush(first.newRoot, opts([upsert(item(3, 'H-1B: I-94 expires', '2027-04-01'), [{ label: 'A', is_done: 1 }], { link })]))
    expect(second.results[0].action).toBe('update')
    const card = second.results[0].after
    expect(card.notes.match(/Radar checklist/g)).toHaveLength(1)
    expect(card.notes).toContain('☑ A')
    expect(card.tags).toEqual(['admin', 'radar'])
    expect(card.dueDate).toBe(boardMod.localNoon('2027-04-01').getTime() / 1000 - 978307200)
  })
  it('does not re-create a linked card the user deleted', () => {
    const p = planPush(fx.board(), opts([upsert(item(3, 'X'), [], { link: { card_id: 'GONE' } })]))
    expect(p.results[0].action).toBe('orphaned')
  })
  it('moves a completed item\'s card to Done', () => {
    const p = planPush(fx.board(), opts([{ item: item(1, 'Colonoscopy'), op: 'complete', checklist: [], link: { card_id: fx.U(1) } }]))
    expect(p.ok).toBe(true)
    expect(p.results[0]).toMatchObject({ action: 'move-to-done', fromList: 'Backlog', list: 'Done' })
    const cols = p.newRoot.boards[0].columns
    expect(cols[0].cards.map(c => c.id)).not.toContain(fx.U(1))
    expect(cols[2].cards.at(-1)).toMatchObject({ id: fx.U(1), isCompleted: true })
    expect(p.invariants.cardsAfter).toBe(6)
  })
})

describe('invariants (the "never destroy the board" guard)', () => {
  it('blocks when an unrelated card would change', () => {
    const before = fx.board()
    const after = JSON.parse(JSON.stringify(before))
    after.boards[0].columns[1].cards[0].title = 'Hacked'
    const inv = planMod.checkInvariants(before, after, { boardName: 'My First Board', results: [] })
    expect(inv.issues.map(i => i.code)).toContain('collateral')
  })
  it('blocks when a card disappears or data outside the board changes', () => {
    const before = fx.board()
    const after = JSON.parse(JSON.stringify(before))
    after.boards[0].columns[0].cards.pop()
    after.boards[1].name = 'Changed'
    const codes = planMod.checkInvariants(before, after, { boardName: 'My First Board', results: [] }).issues.map(i => i.code)
    expect(codes).toEqual(expect.arrayContaining(['cards-lost', 'card-count', 'outside-board']))
  })
  it('blocks integers that would not round-trip', () => {
    const b = fx.board(); b.boards[0].big = 2 ** 60
    expect(boardMod.analyze(b).issues.map(i => i.code)).toContain('unsafe-integers')
  })
})
