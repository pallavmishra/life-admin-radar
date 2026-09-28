import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import h from './helpers.js'
import fx from './fixtures/makeKanbanFixture.js'
import syncMod from '../src/main/kanban/sync.js'
import fileMod from '../src/main/kanban/plistFile.js'
import tpl from '../src/shared/templates.js'
import plist from '../src/main/kanban/plistXml.js'

const xmlConverter = { toXml: (f) => fs.readFileSync(f, 'utf8'), toBinaryInPlace: () => { throw new Error('binary not expected') } }

function setup({ running = false } = {}) {
  const dir = h.tmpDir('kanban')
  const file = path.join(dir, 'app.pallavmishra.KanbanBoard.plist')
  fs.writeFileSync(file, fx.plistXml())
  const r = h.freshRadar()
  const state = { running }
  const sync = syncMod.createKanbanSync({
    store: r.store, engine: r.engine, notifier: r.notifier, isRunning: () => state.running,
    converter: xmlConverter, backupDir: path.join(dir, 'backups'),
  })
  r.store.saveSettings({ kanbanPlistPath: file })
  return { ...r, sync, file, dir, state }
}
const readBoard = (file) => fileMod.readKanbanFile(file, { converter: xmlConverter }).root.boards[0]

describe('Kanban push end to end (against a temp copy)', () => {
  let t
  beforeEach(() => { t = setup() })

  it('queues the in-window items; dry run shows exact card JSON and writes nothing', () => {
    const before = fs.readFileSync(t.file)
    t.sync.enqueueDue(h.clockAt('2026-09-28'))
    const pending = t.sync.pending().map(p => p.title)
    // I-94 is in its 180-day window; both health nags are actionable now.
    expect(pending).toEqual(['H-1B: I-94 expires', 'Book colonoscopy appointment', 'Book prostate appointment'])
    const pv = t.sync.preview(h.clockAt('2026-09-28'))
    expect(pv.ok).toBe(true)
    expect(pv.results.map(r => [r.action, r.cardTitle])).toEqual([
      ['link', 'Visa Renewal'], ['link', 'Colonoscopy Appointment'], ['link', 'Prostate Appointment'],
    ])
    expect(pv.results[0].after.tags).toContain('radar')
    expect(fs.readFileSync(t.file).equals(before)).toBe(true)
  })

  it('live write links the three existing cards — no duplicates — and keeps every other plist key', () => {
    const c = h.clockAt('2026-09-28')
    t.sync.enqueueDue(c)
    const pv = t.sync.preview(c)
    const res = t.sync.execute(c, pv.planId)
    expect(res.ok).toBe(true)
    expect(fs.existsSync(res.backup)).toBe(true)
    const b = readBoard(t.file)
    const titles = b.columns.flatMap(col => col.cards.map(x => x.title))
    expect(titles.filter(x => /colonoscopy/i.test(x))).toEqual(['Colonoscopy Appointment'])
    expect(titles.filter(x => /visa/i.test(x))).toEqual(['Visa Renewal'])
    expect(b.columns[0].cards.find(x => x.title === 'Visa Renewal').tags).toEqual(['admin', 'radar'])
    const tree = plist.parse(fs.readFileSync(t.file, 'utf8'))
    expect(tree.entries.map(e => e[0])).toEqual(['NSWindow Frame main', 'kanban_v3_data', 'launchCount', 'lastOpened', 'showCompleted', 'zoom'])
    expect(plist.dictGet(tree, 'zoom').v).toBe('1.1000000000000001')
    expect(t.sync.pending()).toEqual([])
    // Re-running changes nothing
    t.sync.enqueueDue(c)
    expect(t.sync.pending()).toEqual([])
    // no temp files left behind
    expect(fs.readdirSync(t.dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('license renewal from template → card appears in Backlog; completing it moves it to Done', () => {
    const c = h.clockAt('2026-09-28')
    t.sync.enqueueDue(c); t.sync.execute(c, t.sync.preview(c).planId)
    const lic = t.store.createItem(tpl.instantiate('drivers_license', { date: '2026-11-20' }), c) // 60-day window opens 2026-09-21
    t.sync.enqueueDue(c)
    const pv = t.sync.preview(c)
    expect(pv.results).toHaveLength(1)
    expect(pv.results[0]).toMatchObject({ action: 'create', list: 'Backlog', cardTitle: "Driver's license renewal" })
    expect(t.sync.execute(c, pv.planId).ok).toBe(true)
    let b = readBoard(t.file)
    const card = b.columns[0].cards.at(-1)
    expect(card.title).toBe("Driver's license renewal")
    expect(card.notes).toContain('☐ Current license')
    // check off a document → the card's checklist block is refreshed
    t.store.updateChecklistItem(lic.checklist[0].id, { is_done: true })
    t.sync.enqueueDue(c)
    expect(t.sync.execute(c, t.sync.preview(c).planId).ok).toBe(true)
    b = readBoard(t.file)
    expect(b.columns[0].cards.at(-1).notes).toContain('☑ Current license')
    // complete in the radar → card to Done
    t.store.completeItem(lic.id, c)
    t.sync.enqueueDue(c)
    const pv2 = t.sync.preview(c)
    expect(pv2.results[0].action).toBe('move-to-done')
    expect(t.sync.execute(c, pv2.planId).ok).toBe(true)
    b = readBoard(t.file)
    expect(b.columns[2].cards.at(-1)).toMatchObject({ title: "Driver's license renewal", isCompleted: true })
    expect(b.columns[0].cards.some(x => x.title === "Driver's license renewal")).toBe(false)
  })

  it('never writes while Kanban Board is running: queues and notifies once', () => {
    t.state.running = true
    const before = fs.readFileSync(t.file)
    const c = h.clockAt('2026-09-28')
    t.sync.enqueueDue(c)
    const pv = t.sync.preview(c)
    expect(pv.running).toBe(true)
    const res = t.sync.execute(c, pv.planId)
    expect(res).toMatchObject({ ok: false, queued: true })
    expect(fs.readFileSync(t.file).equals(before)).toBe(true)
    const kanbanNotes = t.notifier.shown.filter(n => n.kind === 'kanban')
    expect(kanbanNotes).toHaveLength(1)
    expect(kanbanNotes[0].body).toBe("Quit Kanban Board so Radar can add your 3 cards ('H-1B: I-94 expires', 'Book colonoscopy appointment', …)")
    t.sync.execute(c, pv.planId)
    expect(t.notifier.shown.filter(n => n.kind === 'kanban')).toHaveLength(1) // not again
    // after quitting, the same plan goes through
    t.state.running = false
    expect(t.sync.execute(c, pv.planId).ok).toBe(true)
  })

  it('single queued card uses the exact notification wording', () => {
    t.state.running = true
    const c = h.clockAt('2026-09-28')
    t.store.saveSettings({ kanbanAutoPush: '1', kanbanLiveWrites: '1' })
    t.store.createItem({ title: 'Car registration', category: 'vehicle_license', due_date: '2026-10-10', reminders: [30] }, c)
    t.sync.enqueueDue(c, { auto: false })
    // mark the three seed rows as already notified so only the new one is fresh
    t.store.raw.prepare(`UPDATE kanban_queue SET notified_at = 'x' WHERE item_id IN (SELECT id FROM life_items WHERE title != 'Car registration')`).run()
    t.sync.autoPush(c)
    expect(t.notifier.shown.at(-1).body).toBe("Quit Kanban Board so Radar can add your 'Car registration' card")
  })

  it('refuses when the file changed after the preview', () => {
    const c = h.clockAt('2026-09-28')
    t.sync.enqueueDue(c)
    const pv = t.sync.preview(c)
    fs.appendFileSync(t.file, '\n')
    const res = t.sync.execute(c, pv.planId)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/changed since/)
  })

  it('requires explicit confirmation when the plan relies on guesses', () => {
    const b = fx.board()
    for (const col of b.boards[0].columns) for (const x of col.cards) { delete x.dueDate; delete x.createdAt }
    delete b.boards[0].createdAt
    fs.writeFileSync(t.file, fx.plistXml(b))
    const c = h.clockAt('2026-09-28')
    t.sync.enqueueDue(c)
    const pv = t.sync.preview(c)
    expect(pv.issues.map(i => i.code)).toEqual(expect.arrayContaining(['due-key-guessed', 'date-format-guessed']))
    expect(t.sync.execute(c, pv.planId).ok).toBe(false)
    expect(t.sync.execute(c, pv.planId, { confirmGuesses: true }).ok).toBe(true)
  })

  it('handles the board stored as <data> as well as <string>', () => {
    fs.writeFileSync(t.file, fx.plistXml(fx.board(), { encoding: 'data' }))
    const c = h.clockAt('2026-09-28')
    t.sync.enqueueDue(c)
    const res = t.sync.execute(c, t.sync.preview(c).planId)
    expect(res.ok).toBe(true)
    const info = fileMod.readKanbanFile(t.file, { converter: xmlConverter })
    expect(info.encoding).toBe('data')
    expect(info.root.boards[0].columns[0].cards[2].tags).toContain('radar')
  })
})

describe('subscriptions never go to the board (default)', () => {
  it('excludes template subscriptions and quick-added items filed under Subscriptions', () => {
    const t = setup()
    const c = h.clockAt('2026-09-28')
    for (const s of t.store.listItems().filter(i => i.kind === 'subscription')) t.store.updateItem(s.id, { due_date: '2026-10-02' }, c)
    t.store.createItem({ title: 'Netflix renewal', category: 'subscriptions', due_date: '2026-10-03', reminders: [7] }, c)
    t.sync.enqueueDue(c)
    const titles = t.sync.pending().map(p => p.title)
    expect(titles).not.toContain('Spotify Premium Duo')
    expect(titles).not.toContain('Netflix renewal')
    expect(titles).toContain('H-1B: I-94 expires')
    t.store.saveSettings({ kanbanIncludeSubscriptions: '1' })
    t.sync.enqueueDue(c)
    expect(t.sync.pending().map(p => p.title)).toContain('Netflix renewal')
  })
})

describe('stale queue entries are withdrawn', () => {
  it('a queued item that becomes a subscription (or the setting is turned off) leaves the queue', () => {
    const t = setup()
    const c = h.clockAt('2026-09-28')
    t.store.saveSettings({ kanbanIncludeSubscriptions: '1' })
    const ac = t.store.listItems().find(i => i.title === 'AppleCare One')
    t.store.updateItem(ac.id, { due_date: '2026-10-02' }, c)
    t.sync.enqueueDue(c)
    expect(t.sync.pending().map(p => p.title)).toContain('AppleCare One')
    t.store.saveSettings({ kanbanIncludeSubscriptions: '0' })
    t.sync.enqueueDue(c)
    expect(t.sync.pending().map(p => p.title)).not.toContain('AppleCare One')
    expect(t.sync.pending().map(p => p.title)).toContain('H-1B: I-94 expires')
    // a plain item queued, then re-filed under Subscriptions
    const x = t.store.createItem({ title: 'Warranty plan', category: 'household', due_date: '2026-10-05', reminders: [7] }, c)
    t.sync.enqueueDue(c)
    expect(t.sync.pending().map(p => p.title)).toContain('Warranty plan')
    t.store.updateItem(x.id, { category: 'subscriptions' }, c)
    t.sync.enqueueDue(c)
    expect(t.sync.pending().map(p => p.title)).not.toContain('Warranty plan')
  })
})
