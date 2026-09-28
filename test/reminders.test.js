import { describe, it, expect } from 'vitest'
import r from '../src/main/reminders.js'

const item = (o = {}) => ({ id: 1, due_date: '2026-12-01', status: 'upcoming', kind: 'dated', ...o })
const rem = (id, days_before, o = {}) => ({ id, item_id: 1, days_before, channel: 'notification', fired_at: null, ...o })

describe('fire-day arithmetic', () => {
  it('fires at due - days_before; negative means after', () => {
    expect(r.fireDay('2027-03-14', 180)).toBe('2026-09-15')
    expect(r.fireDay('2027-03-14', 7)).toBe('2027-03-07')
    expect(r.fireDay('2027-03-25', 0)).toBe('2027-03-25')
    expect(r.fireDay('2026-10-01', -3)).toBe('2026-10-04')
  })
})

describe('computeDueReminders', () => {
  const rs = [rem(1, 60), rem(2, 30), rem(3, 7)]

  it('fires nothing before the first fire day', () => {
    const out = r.computeDueReminders([item()], rs, '2026-10-01') // 61 days out
    expect(out.fire).toEqual([])
    expect(out.supersede).toEqual([])
  })
  it('fires exactly on the fire day', () => {
    const out = r.computeDueReminders([item()], rs, '2026-10-02') // 60 days out
    expect(out.fire.map(f => f.reminder.id)).toEqual([1])
  })
  it('never bursts: only the latest eligible reminder fires, older ones are superseded', () => {
    const out = r.computeDueReminders([item()], rs, '2026-11-25') // 6 days out: all three eligible
    expect(out.fire.map(f => f.reminder.id)).toEqual([3])
    expect(out.supersede.map(f => f.reminder.id).sort()).toEqual([1, 2])
  })
  it('never double-fires: fired reminders are ignored', () => {
    const fired = [rem(1, 60, { fired_at: 'x' }), rem(2, 30), rem(3, 7)]
    expect(r.computeDueReminders([item()], fired, '2026-10-05').fire).toEqual([])
    expect(r.computeDueReminders([item()], fired, '2026-11-01').fire.map(f => f.reminder.id)).toEqual([2])
  })
  it('handles dateless items gracefully (no reminders, no errors)', () => {
    const out = r.computeDueReminders([item({ due_date: null, kind: 'subscription' })], [rem(1, 7)], '2026-10-05')
    expect(out).toEqual({ fire: [], supersede: [] })
  })
  it('skips done items', () => {
    expect(r.computeDueReminders([item({ status: 'done' })], rs, '2026-11-25').fire).toEqual([])
  })
  it('supersedes silently when the item is long past due', () => {
    const out = r.computeDueReminders([item({ due_date: '2026-06-01' })], rs, '2026-09-28')
    expect(out.fire).toEqual([])
    expect(out.supersede).toHaveLength(3)
  })
  it('fires an on-the-day reminder for a dated claim follow-up', () => {
    const claim = item({ due_date: '2027-03-25' })
    expect(r.computeDueReminders([claim], [rem(1, 0)], '2027-03-24').fire).toEqual([])
    expect(r.computeDueReminders([claim], [rem(1, 0)], '2027-03-25').fire).toHaveLength(1)
  })
})

describe('nags', () => {
  const nag = (o = {}) => ({ id: 5, kind: 'nag', status: 'upcoming', nag_every_days: 14, created_on: '2026-09-28', last_nag_on: null, ...o })
  it('is quiet for the first interval, then every 14 days', () => {
    expect(r.computeDueNags([nag()], '2026-10-11')).toEqual([])
    expect(r.computeDueNags([nag()], '2026-10-12')).toHaveLength(1)
    expect(r.computeDueNags([nag({ last_nag_on: '2026-10-12' })], '2026-10-25')).toEqual([])
    expect(r.computeDueNags([nag({ last_nag_on: '2026-10-12' })], '2026-10-26')).toHaveLength(1)
  })
  it('stops when done', () => {
    expect(r.computeDueNags([nag({ status: 'done' })], '2027-01-01')).toEqual([])
  })
})

describe('re-arming on a due-date change', () => {
  it('re-arms only reminders whose new fire day is in the future', () => {
    const rs = [rem(1, 60, { fired_at: 'x' }), rem(2, 30, { fired_at: 'x' }), rem(3, 7)]
    // new due date 2027-01-15 → fire days 2026-11-16, 2026-12-16, 2027-01-08
    expect(r.rearmForNewDueDate(rs, '2027-01-15', '2026-11-20')).toEqual([2])
    expect(r.rearmForNewDueDate(rs, null, '2026-11-20')).toEqual([])
  })
})

describe('first reminder window (Kanban trigger)', () => {
  const rs = [rem(1, 60), rem(2, 7)]
  it('opens at the largest days_before', () => {
    expect(r.inFirstReminderWindow(item(), rs, '2026-10-01')).toBe(false)
    expect(r.inFirstReminderWindow(item(), rs, '2026-10-02')).toBe(true)
  })
  it('is always open for nags, never for dateless or done items', () => {
    expect(r.inFirstReminderWindow(item({ kind: 'nag', due_date: null }), [], '2026-10-01')).toBe(true)
    expect(r.inFirstReminderWindow(item({ due_date: null }), rs, '2026-10-01')).toBe(false)
    expect(r.inFirstReminderWindow(item({ status: 'done' }), rs, '2026-11-30')).toBe(false)
  })
})
