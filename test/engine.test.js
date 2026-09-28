import { describe, it, expect } from 'vitest'
import h from './helpers.js'
import { bucketItems } from '../src/main/status.js'
import tpl from '../src/shared/templates.js'

const { freshRadar, clockAt } = h

describe('seed (§5)', () => {
  it('creates the real items exactly once', () => {
    const { store } = freshRadar()
    const items = store.listItems()
    expect(items).toHaveLength(11)
    const i94 = items.find(i => i.title === 'H-1B: I-94 expires')
    expect(i94).toMatchObject({ due_date: '2027-03-14', category: 'immigration' })
    expect(i94.reminders.map(r => r.days_before)).toEqual([180, 90, 30, 7])
    const nj = items.find(i => i.title.startsWith('NJ unclaimed'))
    expect(nj.due_date).toBe('2027-03-25') // 180 days after 2026-09-26
    const colo = items.find(i => i.title === 'Book colonoscopy appointment')
    expect(colo.kind).toBe('nag')
    expect(colo.checklist.map(c => c.label)).toEqual(['Get PCP referral', 'Confirm coded as preventive/screening for $0 coverage'])
    const subs = items.filter(i => i.kind === 'subscription')
    expect(subs.map(s => s.title)).toEqual(['Spotify Premium Duo', 'YouTube Premium', 'AppleCare One', 'NYT', 'Amazon Prime'])
    expect(subs.every(s => s.due_date === null && s.reminders[0].days_before === 7)).toBe(true)
    expect(subs[0].subscription.cost_cents).toBe(1899)
    expect(subs[3].subscription.cost_cents).toBeNull()
    expect(store.seedIfNeeded([{ title: 'x' }], clockAt('2026-09-28'))).toBe(false)
  })
})

describe('tick: exactly-once notifications', () => {
  it('fires the I-94 180-day reminder once on first run, then nothing on re-run', () => {
    const { store, engine, notifier } = freshRadar()
    const r1 = engine.tick(clockAt('2026-09-28'))
    expect(r1.notifications.map(n => n.title)).toEqual(['H-1B: I-94 expires — due in 167 days'])
    const r2 = engine.tick(clockAt('2026-09-28'))
    expect(r2.notifications).toEqual([])
    expect(notifier.shown).toHaveLength(1)
    expect(store.raw.prepare('SELECT COUNT(*) n FROM notification_log').get().n).toBe(1)
  })

  it('walks the clock day by day through 2027 and fires each reminder exactly once', () => {
    const { store, engine } = freshRadar()
    let day = '2026-09-28'
    const { addDays } = require('../src/shared/dates')
    for (let i = 0; i < 200; i++) {
      engine.tick(clockAt(day)); engine.tick(clockAt(day, 18)) // two ticks per day
      day = addDays(day, 1)
    }
    const log = store.raw.prepare(`SELECT kind, ref_id, day, title FROM notification_log ORDER BY id`).all()
    const reminders = log.filter(l => l.kind === 'reminder')
    const ids = reminders.map(l => l.ref_id)
    expect(new Set(ids).size).toBe(ids.length) // no duplicates
    const days = reminders.map(l => `${l.day} ${l.title.split(' —')[0]}`)
    expect(days).toEqual([
      '2026-09-28 H-1B: I-94 expires',   // 180 before (15 Sep) — caught up once
      '2026-12-14 H-1B: I-94 expires',   // 90 before
      '2027-02-12 H-1B: I-94 expires',   // 30 before
      '2027-03-07 H-1B: I-94 expires',   // 7 before
      expect.stringMatching(/^2027-03-25 (NJ|MA) unclaimed/),
      expect.stringMatching(/^2027-03-25 (NJ|MA) unclaimed/),
    ])
    // Nags: every 14 days from creation for both health items, never twice a day
    const nags = log.filter(l => l.kind === 'nag')
    const perDay = new Set(nags.map(n => `${n.ref_id}@${n.day}`))
    expect(perDay.size).toBe(nags.length)
    expect(nags.filter(n => n.title.includes('colonoscopy')).map(n => n.day).slice(0, 3)).toEqual(['2026-10-12', '2026-10-26', '2026-11-09'])
    // Dateless subscriptions: no reminders, no errors
    expect(log.some(l => /Spotify|NYT|Prime/.test(l.title))).toBe(false)
  })

  it('is silent when nothing is due', () => {
    const { engine, notifier } = freshRadar({ seed: false })
    expect(engine.tick(clockAt('2026-09-28')).notifications).toEqual([])
    expect(notifier.shown).toEqual([])
  })

  it('re-fires after a due-date change only for reminders now in the future', () => {
    const { store, engine } = freshRadar({ seed: false })
    const c = clockAt('2026-09-28')
    const it1 = store.createItem(tpl.instantiate('drivers_license', { date: '2026-10-20' }), c)
    expect(engine.tick(c).notifications).toHaveLength(1) // 30-day (60 superseded)
    expect(engine.tick(clockAt('2026-10-13')).notifications).toHaveLength(1) // 7-day
    store.updateItem(it1.id, { due_date: '2027-01-20' }, clockAt('2026-10-14'))
    expect(engine.tick(clockAt('2026-10-14')).notifications).toEqual([])
    expect(engine.tick(clockAt('2026-11-21')).notifications).toHaveLength(1) // new 60-day
  })
})

describe('digest (Phase 4)', () => {
  it('is off by default', () => {
    const { engine } = freshRadar()
    const r = engine.tick(clockAt('2027-03-10', 9))
    expect(r.notifications.some(n => n.kind === 'digest')).toBe(false)
  })
  it('sends once a day at/after 8, only when something is due within 7 days', () => {
    const { store, engine } = freshRadar()
    store.saveSettings({ digestEnabled: '1' })
    expect(engine.tick(clockAt('2026-10-01', 9)).notifications.some(n => n.kind === 'digest')).toBe(false) // nothing due in 7d
    expect(engine.tick(clockAt('2027-03-09', 7)).notifications.some(n => n.kind === 'digest')).toBe(false) // before 8
    const d = engine.tick(clockAt('2027-03-09', 8)).notifications.find(n => n.kind === 'digest')
    expect(d.title).toBe('Radar: 1 due this week')
    expect(d.body).toContain('H-1B: I-94 expires — in 5 days')
    expect(engine.tick(clockAt('2027-03-09', 12)).notifications.some(n => n.kind === 'digest')).toBe(false)
  })
})

describe('health nag → booked', () => {
  it('converts to a dated item and stops nagging', () => {
    const { store, engine } = freshRadar()
    const colo = store.listItems().find(i => i.title === 'Book colonoscopy appointment')
    const booked = store.bookNag(colo.id, '2026-11-15', clockAt('2026-10-01'))
    expect(booked).toMatchObject({ title: 'Colonoscopy appointment', kind: 'dated', due_date: '2026-11-15' })
    expect(booked.reminders.map(r => r.days_before)).toEqual([7, 1])
    expect(booked.checklist).toHaveLength(2)
    const r = engine.tick(clockAt('2026-10-12'))
    expect(r.notifications.some(n => n.itemId === colo.id)).toBe(false)
  })
})

describe('subscriptions (Phase 3)', () => {
  it('keep advances one billing cycle and re-arms; cancel completes; missed renewals log auto-renewed', () => {
    const { store, engine } = freshRadar()
    const spot = store.listItems().find(i => i.title === 'Spotify Premium Duo')
    store.updateItem(spot.id, { due_date: '2026-10-05' }, clockAt('2026-09-28'))
    const n = engine.tick(clockAt('2026-09-28')).notifications.find(x => x.itemId === spot.id)
    expect(n.title).toBe('Spotify Premium Duo renews in 7 days')
    let s = store.decideSubscription(spot.id, 'keep', clockAt('2026-09-29'))
    expect(s.due_date).toBe('2026-11-05')
    expect(s.decisions[0]).toMatchObject({ decision: 'keep', renewal_date: '2026-10-05' })
    // no decision for Nov → it rolls forward on its own, logged as auto-renewed
    engine.tick(clockAt('2026-11-06'))
    s = store.getItem(spot.id)
    expect(s.due_date).toBe('2026-12-05')
    expect(s.decisions[0]).toMatchObject({ decision: 'auto-renewed', renewal_date: '2026-11-05' })
    s = store.decideSubscription(spot.id, 'cancel', clockAt('2026-11-30'))
    expect(s.status).toBe('done')
  })
})

describe('dashboard buckets', () => {
  it('sorts into Overdue / 7 / 30 / 90 and hides the rest', () => {
    const { store } = freshRadar({ seed: false })
    const c = clockAt('2026-09-28')
    for (const [t, d] of [['late', '2026-09-20'], ['wk', '2026-10-02'], ['mo', '2026-10-20'], ['q', '2026-12-01'], ['far', '2027-06-01'], ['nodate', null]]) {
      store.createItem({ title: t, due_date: d }, c)
    }
    const b = bucketItems(store.listItems(), '2026-09-28')
    expect(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.map(i => i.title)]))).toMatchObject({
      overdue: ['late'], week: ['wk'], month: ['mo'], quarter: ['q'], later: ['far'], undated: ['nodate'],
    })
  })
})

describe('privacy at the storage layer', () => {
  it('refuses to store an SSN anywhere', () => {
    const { store } = freshRadar({ seed: false })
    const c = clockAt('2026-09-28')
    expect(() => store.createItem({ title: 'SSN 123-45-6789' }, c)).toThrow(/never stores/)
    const it1 = store.createItem({ title: 'Passport renewal' }, c)
    expect(() => store.addChecklistItem(it1.id, { label: 'Passport', location_hint: 'password: x' })).toThrow(/never stores/)
    expect(() => store.addConsumable('pin 1234', { nowIso: c.nowIso })).toThrow()
  })
})
