import { describe, it, expect } from 'vitest'
import d from '../src/shared/dates.js'

describe('dates', () => {
  it('adds and diffs across month/year/leap boundaries', () => {
    expect(d.addDays('2027-03-14', -180)).toBe('2026-09-15')
    expect(d.addDays('2026-09-26', 180)).toBe('2027-03-25')
    expect(d.addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(d.addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(d.diffDays('2026-09-28', '2027-03-14')).toBe(167)
    expect(d.diffDays('2027-03-14', '2026-09-28')).toBe(-167)
  })
  it('is immune to DST transitions', () => {
    // US DST starts 2027-03-14 and ends 2026-11-01 — plain day counts regardless.
    expect(d.diffDays('2027-03-13', '2027-03-15')).toBe(2)
    expect(d.addDays('2026-10-31', 2)).toBe('2026-11-02')
  })
  it('adds months with end-of-month clamping', () => {
    expect(d.addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(d.addMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(d.addMonths('2026-11-15', 3)).toBe('2027-02-15')
    expect(d.addMonths('2026-12-05', 12)).toBe('2027-12-05')
  })
  it('validates keys strictly', () => {
    expect(d.isDayKey('2026-02-30')).toBe(false)
    expect(d.isDayKey('2026-2-3')).toBe(false)
    expect(d.isDayKey('2026-09-28')).toBe(true)
    expect(() => d.addDays('nope', 1)).toThrow()
  })
  it('builds local day keys from local getters', () => {
    expect(d.localDayKey(new Date(2026, 8, 28, 23, 59))).toBe('2026-09-28')
    expect(d.localDayKey(new Date(2026, 8, 29, 0, 1))).toBe('2026-09-29')
  })
})
