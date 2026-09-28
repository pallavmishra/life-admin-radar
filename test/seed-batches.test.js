import { describe, it, expect } from 'vitest'
import path from 'path'
import Database from 'better-sqlite3'
import h from './helpers.js'
import seed from '../src/main/seed.js'
import dates from '../src/shared/dates.js'
import dbMod from '../src/main/db.js'

const { clockAt, freshRadar } = h

describe('anchored billing day', () => {
  it('keeps the 29th across short months', () => {
    expect(dates.addMonthsAnchored('2027-01-29', 1, 29)).toBe('2027-02-28')
    expect(dates.addMonthsAnchored('2027-02-28', 1, 29)).toBe('2027-03-29')
    expect(dates.addMonthsAnchored('2028-01-29', 1, 29)).toBe('2028-02-29')
    expect(dates.addMonthsAnchored('2026-12-29', 1, 29)).toBe('2027-01-29')
    expect(dates.nextOnDay('2026-09-28', 29)).toBe('2026-09-29')
    expect(dates.nextOnDay('2026-09-30', 29)).toBe('2026-10-29')
    expect(dates.nextOnDay('2027-02-15', 29)).toBe('2027-02-28')
  })
})

describe('utilities batch (2026-09)', () => {
  it('adds the three items once, on top of the original seed, with no duplicates', () => {
    const { store } = freshRadar()
    const c = clockAt('2026-10-01')
    const r = seed.applySeedBatches(store, c)
    expect(r[0]).toMatchObject({ applied: true, added: ['Optimum internet', 'JCP&L electric', 'PSE&G gas'], skipped: [] })
    expect(seed.applySeedBatches(store, c)[0].applied).toBe(false)           // never again
    const items = store.listItems()
    expect(items).toHaveLength(14)
    expect(new Set(items.map(i => i.title)).size).toBe(14)

    const opt = items.find(i => i.title === 'Optimum internet')
    expect(opt).toMatchObject({ category: 'subscriptions', kind: 'subscription', due_date: '2026-10-29' })
    expect(opt.subscription).toMatchObject({ cost_cents: 10000, cost_approx: 0, billing_cycle: 'monthly', billing_day: 29, via: 'Auto-pay' })
    expect(opt.reminders.map(x => [x.days_before, x.channel])).toEqual([[7, 'notification']])

    for (const [t, cents] of [['JCP&L electric', 17328], ['PSE&G gas', 1220]]) {
      const u = items.find(i => i.title === t)
      expect(u).toMatchObject({ category: 'subscriptions', kind: 'subscription', due_date: null })
      expect(u.subscription).toMatchObject({ cost_cents: cents, cost_approx: 1, billing_day: null })
      expect(u.reminders.map(x => x.days_before)).toEqual([7])
    }
  })

  it('skips an item already typed in by hand', () => {
    const { store } = freshRadar()
    const c = clockAt('2026-10-01')
    store.createItem({ title: 'Optimum', category: 'subscriptions', kind: 'subscription', subscription: {} }, c)
    const r = seed.applySeedBatches(store, c)[0]
    expect(r.added).toEqual(['JCP&L electric', 'PSE&G gas'])
    expect(r.skipped[0]).toMatch(/Optimum internet \(already have "Optimum"\)/)
  })

  it('dateless utilities never remind; Optimum reminds 7 days out and rolls on the 29th', () => {
    const { store, engine } = freshRadar()
    seed.applySeedBatches(store, clockAt('2026-10-01'))
    const opt = store.listItems().find(i => i.title === 'Optimum internet')
    expect(engine.tick(clockAt('2026-10-21')).notifications.some(n => /JCP|PSE|Optimum/.test(n.title))).toBe(false)
    const n = engine.tick(clockAt('2026-10-22')).notifications.find(x => x.itemId === opt.id)
    expect(n).toMatchObject({ title: 'Optimum internet renews in 7 days', body: 'Keep or cancel? Renews Thu, Oct 29 2026 · $100.00.' })
    // no decision → auto-renews and rolls to Nov 29, then Dec 29, Jan 29, Feb 28, Mar 29
    engine.tick(clockAt('2027-03-01'))
    expect(store.getItem(opt.id).due_date).toBe('2027-03-29')
    // a utility gets a date from a bill → it starts reminding, with ~amount
    const jcpl = store.listItems().find(i => i.title === 'JCP&L electric')
    store.updateItem(jcpl.id, { due_date: '2027-03-10' }, clockAt('2027-03-01'))
    const m = engine.tick(clockAt('2027-03-03')).notifications.find(x => x.itemId === jcpl.id)
    expect(m.body).toContain('~$173.28')
  })

  it('stays off the Kanban board', () => {
    const { store, engine } = freshRadar()
    seed.applySeedBatches(store, clockAt('2026-10-01'))
    expect(engine.kanbanCandidates('2026-10-25').map(i => i.title)).not.toContain('Optimum internet')
  })
})

describe('upgrading an existing database', () => {
  it('adds the new subscription columns without losing data', () => {
    const file = path.join(h.tmpDir('migrate'), 'radar.db')
    const old = new Database(file)
    old.exec(`CREATE TABLE subscriptions (item_id INTEGER PRIMARY KEY, cost_cents INTEGER, billing_cycle TEXT NOT NULL DEFAULT 'monthly', cancel_url TEXT NOT NULL DEFAULT '', via TEXT NOT NULL DEFAULT '')`)
    old.prepare(`INSERT INTO subscriptions (item_id, cost_cents) VALUES (1, 6999)`).run()
    old.close()
    const store = dbMod.openDatabase(file)
    expect(store.raw.prepare('SELECT * FROM subscriptions WHERE item_id = 1').get()).toMatchObject({ cost_cents: 6999, cost_approx: 0, billing_day: null })
    store.close()
  })
})
