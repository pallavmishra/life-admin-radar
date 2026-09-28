'use strict'
/**
 * Smart templates: one click → a pre-filled item + reminder schedule +
 * checklist. PURE — instantiate() returns a plain draft; db.createItem()
 * persists it. Every template is designed to finish in under 10 seconds:
 * the only thing it ever asks for is the one date (or nothing at all).
 */
const { addDays, isDayKey } = require('./dates')
const { parseCents } = require('./money')

const TEMPLATES = [
  {
    id: 'drivers_license',
    label: "Driver's license renewal",
    blurb: 'Reminders 60/30/7 days out; license, address proof, fee.',
    category: 'vehicle_license',
    kind: 'dated',
    title: "Driver's license renewal",
    dateLabel: 'License expires on',
    reminders: [60, 30, 7],
    checklist: [
      { label: 'Current license' },
      { label: 'Proof of address' },
      { label: 'Renewal fee' },
    ],
  },
  {
    id: 'visa_milestone',
    label: 'H-1B / visa milestone',
    blurb: 'Reminders 180/90/30 days out; you define the checklist.',
    category: 'immigration',
    kind: 'dated',
    title: 'Visa milestone',
    dateLabel: 'Milestone date',
    reminders: [180, 90, 30],
    checklist: [],
  },
  {
    id: 'subscription',
    label: 'Subscription renewal',
    blurb: 'Keep/cancel prompt 7 days before each renewal.',
    category: 'subscriptions',
    kind: 'subscription',
    title: 'Subscription',
    dateLabel: 'Next renewal (optional)',
    dateOptional: true,
    reminders: [7],
    checklist: [],
    subscription: { billing_cycle: 'monthly' },
  },
  {
    id: 'insurance_claim',
    label: 'Insurance claim follow-up',
    blurb: 'Check claim status at filing, +90 and +180 days.',
    category: 'claims',
    kind: 'dated',
    title: 'Insurance claim — check status',
    dateLabel: 'Filed on',
    // The item is due at filing + 180; reminders land at filing (180 before
    // due), filing + 90 (90 before) and filing + 180 (on the day).
    dueOffsetDays: 180,
    reminders: [180, 90, 0],
    checklist: [
      { label: 'Claim number noted in notes' },
      { label: 'Claim paperwork filed', location_hint: '' },
    ],
  },
  {
    id: 'health_booking',
    label: 'Health appointment to book',
    blurb: 'No date yet — a gentle nudge every 14 days until booked.',
    category: 'health',
    kind: 'nag',
    title: 'Book appointment',
    dateLabel: null,
    nagEveryDays: 14,
    reminders: [],
    // After booking, the item becomes dated with these reminders.
    bookedReminders: [7, 1],
    checklist: [{ label: 'Insurance card handy' }],
  },
]

function getTemplate(id) {
  const t = TEMPLATES.find(x => x.id === id)
  if (!t) throw new Error(`Unknown template: ${id}`)
  return t
}

/**
 * @param {string} id
 * @param {{ title?, date?, cost?, billing_cycle?, cancel_url? }} input
 */
function instantiate(id, input = {}) {
  const t = getTemplate(id)
  const date = input.date && isDayKey(input.date) ? input.date : null
  if (t.dateLabel && !t.dateOptional && !date) throw new Error(`${t.dateLabel} is required`)
  const due = date ? addDays(date, t.dueOffsetDays || 0) : null
  const draft = {
    title: (input.title && input.title.trim()) || t.title,
    category: t.category,
    kind: t.kind,
    due_date: t.kind === 'nag' ? null : due,
    notes: input.notes || '',
    nag_every_days: t.kind === 'nag' ? t.nagEveryDays : null,
    template_id: t.id,
    reminders: t.reminders.map(d => ({ days_before: d, channel: 'notification' })),
    checklist: t.checklist.map(c => ({ label: c.label, location_hint: c.location_hint || '', is_done: 0 })),
  }
  if (t.kind === 'subscription') {
    draft.subscription = {
      cost_cents: parseCents(input.cost),
      cost_approx: !!input.cost_approx,
      billing_cycle: input.billing_cycle || t.subscription.billing_cycle,
      cancel_url: input.cancel_url || '',
      via: input.via || '',
    }
  }
  return draft
}

module.exports = { TEMPLATES, getTemplate, instantiate }
