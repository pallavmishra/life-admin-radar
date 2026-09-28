'use strict'

const CATEGORIES = [
  { id: 'immigration', label: 'Immigration' },
  { id: 'vehicle_license', label: 'Vehicle & license' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'health', label: 'Health' },
  { id: 'finance', label: 'Finance' },
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'household', label: 'Household' },
  { id: 'claims', label: 'Claims' },
  { id: 'other', label: 'Other' },
]
const CATEGORY_IDS = CATEGORIES.map(c => c.id)

// status column values (see status.js for how they are derived)
const STATUSES = ['upcoming', 'due', 'overdue', 'done']

// item kinds
//   dated        — ordinary item with a due date (may be empty until known)
//   nag          — "to book" item with no due date; nudges every N days until
//                  booked, then converts to a dated item
//   subscription — recurring renewal; rolls forward by billing cycle
const KINDS = ['dated', 'nag', 'subscription']

const BILLING_CYCLES = [
  { id: 'monthly', label: 'Monthly', months: 1 },
  { id: 'quarterly', label: 'Quarterly', months: 3 },
  { id: 'yearly', label: 'Yearly', months: 12 },
]

const CHANNELS = ['notification', 'digest']

// Dashboard windows, in days from today (inclusive upper bounds).
const WINDOWS = { soon: 7, month: 30, quarter: 90 }

module.exports = { CATEGORIES, CATEGORY_IDS, STATUSES, KINDS, BILLING_CYCLES, CHANNELS, WINDOWS }
