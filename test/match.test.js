import { describe, it, expect } from 'vitest'
import m from '../src/main/kanban/match.js'

const cards = ['Colonoscopy Appointment', 'Prostate Appointment', 'Visa Renewal', 'Buy printer ink', 'Taxes']
  .map((title, i) => ({ id: String(i), title }))

describe('dedupe fuzzy match', () => {
  it.each([
    ['Book colonoscopy appointment', 'Colonoscopy Appointment'],
    ['Book prostate appointment', 'Prostate Appointment'],
    ['H-1B: I-94 expires', 'Visa Renewal'],
    ['BOOK Colonoscopy', 'Colonoscopy Appointment'],
    ['Colonoscopy appointment', 'Colonoscopy Appointment'],
  ])('%s → %s', (title, want) => {
    expect(m.bestMatch(title, cards).card.title).toBe(want)
  })
  it.each([
    ['NJ unclaimed property claim #1001782199 ($396.00) — check status'],
    ["Driver's license renewal"],
    ['Spotify Premium Duo'],
    ['iPhone screen replacement follow-up (Apple service damage)'],
    ['Book dentist appointment'],
  ])('does not match %s', (title) => {
    expect(m.bestMatch(title, cards)).toBeNull()
  })
  it('ignores filler words and case', () => {
    expect([...m.tokens('Book the Colonoscopy APPOINTMENT')]).toEqual(['colonoscopy'])
  })
})
