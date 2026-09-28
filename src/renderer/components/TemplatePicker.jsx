import React, { useEffect, useRef, useState } from 'react'
import { describeReminder } from '../util.js'

// What each template asks for — one or two fields, so it takes seconds.
const ASK = {
  drivers_license: { title: false, date: true },
  visa_milestone: { title: 'What milestone? (e.g. H-1B extension filing)', date: true },
  subscription: { title: 'Service name', date: true, sub: true },
  insurance_claim: { title: 'Claim (e.g. Aetna claim #123 — check status)', date: true, defaultToday: true },
  health_booking: { title: 'What to book? (e.g. Book dentist appointment)', date: false },
}

export default function TemplatePicker({ meta, today, onClose, onCreated, toasts }) {
  const [pick, setPick] = useState(null)
  const [form, setForm] = useState({})
  const first = useRef(null)
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  useEffect(() => { first.current?.focus() }, [pick])

  const choose = (t) => {
    setPick(t)
    setForm({ date: ASK[t.id].defaultToday ? today : '', title: '', cost: '', billing_cycle: 'monthly', cancel_url: '' })
  }
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))
  const submit = async (e) => {
    e.preventDefault()
    try {
      const item = await window.radar.createFromTemplate(pick.id, form)
      toasts.info(`Added “${item.title}”`)
      onCreated(item)
    } catch (err) { toasts.error(err.message) }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="New from template">
        {!pick && (
          <>
            <h3>New from template</h3>
            <div className="template-grid">
              {meta.templates.map((t, i) => (
                <button key={t.id} ref={i === 0 ? first : null} className="template" onClick={() => choose(t)}>
                  <b>{t.label}</b>
                  <span>{t.blurb}</span>
                </button>
              ))}
            </div>
            <div className="modal-actions"><button onClick={onClose}>Cancel</button></div>
          </>
        )}
        {pick && (
          <form onSubmit={submit}>
            <h3>{pick.label}</h3>
            <p className="muted small">
              {pick.kind === 'nag' ? `Nudges every ${pick.nagEveryDays} days until booked.` :
                `Reminders: ${pick.reminders.map(describeReminder).join(', ')}.`}
              {pick.checklist.length ? ` Checklist: ${pick.checklist.map(c => c.label).join(', ')}.` : ''}
            </p>
            {ASK[pick.id].title && (
              <label className="block">{ASK[pick.id].title}
                <input ref={first} value={form.title} onChange={set('title')} required={pick.kind === 'nag' || pick.id === 'subscription'} />
              </label>
            )}
            {ASK[pick.id].sub && (<>
              <div className="field-grid three">
                <label>Cost<input value={form.cost} onChange={set('cost')} placeholder="$18.99" inputMode="decimal" /></label>
                <label>Cycle
                  <select value={form.billing_cycle} onChange={set('billing_cycle')}>
                    {meta.cycles.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </label>
                <label>Cancel URL<input value={form.cancel_url} onChange={set('cancel_url')} placeholder="e.g. spotify.com/account" /></label>
              </div>
              <label className="check small"><input type="checkbox" checked={!!form.cost_approx} onChange={e => setForm(f => ({ ...f, cost_approx: e.target.checked }))} /> Amount varies (utilities) — store it as approximate</label>
            </>)}
            {ASK[pick.id].date && (
              <label className="block">{pick.dateLabel}
                <input ref={ASK[pick.id].title ? null : first} type="date" value={form.date} onChange={set('date')} required={!pick.dateOptional} />
              </label>
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => setPick(null)}>Back</button>
              <button type="submit" className="primary">Add</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
