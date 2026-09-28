'use strict'
/**
 * First-run seed (§5): real items so the app is useful on day one. Runs
 * exactly once — guarded by the `seeded` setting — so deleting a seed item
 * never makes it come back.
 */
const { addDays } = require('../shared/dates')

const CLAIM_FILED = '2026-09-26'

function seedItems() {
  const sub = (title, cost, cancel_url, via = '') => ({
    title, category: 'subscriptions', kind: 'subscription', due_date: null, notes: '',
    template_id: 'subscription',
    reminders: [{ days_before: 7, channel: 'notification' }],
    checklist: [],
    subscription: { cost_cents: cost == null ? null : Math.round(cost * 100), billing_cycle: 'monthly', cancel_url, via },
  })
  return [
    {
      title: 'H-1B: I-94 expires', category: 'immigration', kind: 'dated', due_date: '2027-03-14',
      notes: '', template_id: 'visa_milestone',
      reminders: [180, 90, 30, 7].map(d => ({ days_before: d, channel: 'notification' })),
      checklist: [],
    },
    {
      title: 'NJ unclaimed property claim #1001782199 ($396.00) — check status', category: 'claims',
      kind: 'dated', due_date: addDays(CLAIM_FILED, 180),
      notes: `Filed ${CLAIM_FILED}. Check status 180 days after filing.`, template_id: 'insurance_claim',
      reminders: [{ days_before: 0, channel: 'notification' }],
      checklist: [{ label: 'Claim confirmation', location_hint: 'saved in NJ claim folder' }],
    },
    {
      title: 'MA unclaimed property claim #8443402 ($460.74) — check status', category: 'claims',
      kind: 'dated', due_date: addDays(CLAIM_FILED, 180),
      notes: `Filed ${CLAIM_FILED}. Check status 180 days after filing.`, template_id: 'insurance_claim',
      reminders: [{ days_before: 0, channel: 'notification' }],
      checklist: [{ label: 'Claim confirmation', location_hint: 'saved in MA claim folder' }],
    },
    {
      title: 'Book colonoscopy appointment', category: 'health', kind: 'nag', due_date: null,
      nag_every_days: 14, notes: '', template_id: 'health_booking', reminders: [],
      checklist: [
        { label: 'Get PCP referral' },
        { label: 'Confirm coded as preventive/screening for $0 coverage' },
      ],
    },
    {
      title: 'Book prostate appointment', category: 'health', kind: 'nag', due_date: null,
      nag_every_days: 14, notes: '', template_id: 'health_booking', reminders: [],
      checklist: [],
    },
    {
      title: 'iPhone screen replacement follow-up (Apple service damage)', category: 'household',
      kind: 'dated', due_date: null, notes: '', reminders: [], checklist: [],
    },
    sub('Spotify Premium Duo', 18.99, 'https://www.spotify.com/account/subscription/'),
    sub('YouTube Premium', 20.99, 'https://apps.apple.com/account/subscriptions', 'Apple'),
    sub('AppleCare One', 19.99, 'https://apps.apple.com/account/subscriptions', 'Apple'),
    sub('NYT', null, 'https://myaccount.nytimes.com/seg/subscription'),
    sub('Amazon Prime', null, 'https://www.amazon.com/mc/manage'),
  ]
}

module.exports = { seedItems, CLAIM_FILED }
