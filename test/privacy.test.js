import { describe, it, expect } from 'vitest'
import p from '../src/shared/privacy.js'

describe('privacy boundary', () => {
  it.each([
    ['SSN 123-45-6789'],
    ['ssn 123 45 6789'],
    ['number is 123456789'],
    ['DOB: 04/12/1985'],
    ['date of birth 1985-04-12'],
    ['born on Apr 12'],
    ['password: hunter2'],
    ['passcode=4491'],
    ['PIN 4491'],
    ['api key: sk-abc'],
    ['data:image/png;base64,iVBORw0KGgo='],
  ])('refuses %s', (s) => {
    expect(p.findViolation(s)).not.toBeNull()
    expect(() => p.checkText('notes', s)).toThrow(/never stores/)
  })
  it.each([
    ['Social Security card: obtained'],
    ['Birth certificate — saved in ~/H1 Documents'],
    ['Photo ID front+back'],
    ['Reset password on DMV site'],
    ['NJ unclaimed property claim #1001782199 ($396.00) — check status'],
    ['MA unclaimed property claim #8443402 ($460.74)'],
    ['H-1B: I-94 expires'],
    ['Spotify Premium Duo $18.99/mo'],
  ])('allows %s', (s) => {
    expect(p.findViolation(s)).toBeNull()
  })
})
