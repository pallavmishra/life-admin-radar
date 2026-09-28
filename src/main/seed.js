'use strict'
/**
 * First-run seed (§5): real items so the app is useful on day one. Runs
 * exactly once — guarded by the `seeded` setting — so deleting a seed item
 * never makes it come back.
 */
const { addDays, nextOnDay } = require('../shared/dates')

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

/**
 * Later seed batches, applied once each on the next launch (db.applySeedBatch),
 * so a database created before they existed gets them too. `today` fixes
 * dates that depend on when the batch lands.
 */
function seedBatches(today) {
  const sub = (title, { cost, approx = false, day = null, notes = '', via = '' }) => ({
    title, category: 'subscriptions', kind: 'subscription', notes, template_id: 'subscription',
    // A known billing day gives the next renewal; otherwise the date stays
    // empty — a dateless subscription has no reminder until one is set.
    due_date: day ? nextOnDay(today, day) : null,
    reminders: [{ days_before: 7, channel: 'notification' }],
    checklist: [],
    subscription: { cost_cents: Math.round(cost * 100), cost_approx: approx, billing_cycle: 'monthly', billing_day: day, cancel_url: '', via },
  })
  return [
    {
      id: '2026-09-utilities',
      items: [
        sub('Optimum internet', { cost: 100, day: 29, via: 'Auto-pay', notes: 'Auto-pay. Renews around the 29th of each month.' }),
        sub('JCP&L electric', { cost: 173.28, approx: true, notes: 'Amount varies month to month (~$173.28). Renewal date unknown — add it from a bill to get the 7-day reminder.' }),
        sub('PSE&G gas', { cost: 12.20, approx: true, notes: 'Amount varies month to month (~$12.20). Renewal date unknown — add it from a bill to get the 7-day reminder.' }),
      ],
    },
  ]
}

function applySeedBatches(store, ctx) {
  return seedBatches(ctx.today).map(b => ({ id: b.id, ...store.applySeedBatch(b.id, b.items, ctx) }))
}

module.exports = { seedItems, seedBatches, applySeedBatches, CLAIM_FILED }
