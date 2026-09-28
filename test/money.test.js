import { describe, it, expect } from 'vitest'
import m from '../src/shared/money.js'
import tpl from '../src/shared/templates.js'
import h from './helpers.js'

describe('cost parsing', () => {
  it.each([['$69.99', 6999], ['69.99', 6999], ['$ 69.99', 6999], ['1,299.00', 129900], ['18.99/mo', 1899], ['$139', 13900], ['0', 0], ['', null], [null, null]])('%s → %s', (i, o) => {
    expect(m.parseCents(i)).toBe(o)
  })
  it('explains what it wants instead of "positive"', () => {
    expect(() => m.parseCents('sixty')).toThrow('Cost should be an amount like 69.99 (got "sixty")')
    expect(() => m.parseCents('-5')).toThrow(/amount like 69.99/)
  })
})

describe('cancel URL', () => {
  it('adds https:// when it is missing', () => {
    expect(m.normalizeUrl('membership.ouraring.com')).toBe('https://membership.ouraring.com/')
    expect(m.normalizeUrl('http://example.com/cancel')).toBe('https://example.com/cancel')
    expect(m.normalizeUrl('https://www.spotify.com/account/subscription/')).toBe('https://www.spotify.com/account/subscription/')
    expect(m.normalizeUrl('')).toBe('')
  })
  it('rejects things that are not web addresses', () => {
    expect(() => m.normalizeUrl('call them')).toThrow(/doesn't look like a web address/)
    expect(() => m.normalizeUrl('javascript:alert(1)')).toThrow()
  })
})

describe('the Oura subscription from the screenshot', () => {
  it('saves', () => {
    const { store } = h.freshRadar({ seed: false })
    const it1 = store.createItem(tpl.instantiate('subscription', {
      title: 'Oura', cost: '$69.99', billing_cycle: 'yearly', cancel_url: 'membership.ouraring.com', date: '2027-02-27',
    }), h.clockAt('2026-09-28'))
    expect(it1).toMatchObject({ title: 'Oura', due_date: '2027-02-27', kind: 'subscription' })
    expect(it1.subscription).toMatchObject({ cost_cents: 6999, billing_cycle: 'yearly', cancel_url: 'https://membership.ouraring.com/' })
    const upd = store.updateItem(it1.id, { subscription: { cost: '$74.99' } }, h.clockAt('2026-09-28'))
    expect(upd.subscription.cost_cents).toBe(7499)
  })
})
