import React, { useState } from 'react'

// Keyword → category, so a typed title usually lands in the right place
// without touching the dropdown.
const GUESS = [
  [/\b(visa|h-?1b|i-?94|i-?797|green card|ead|passport|uscis|immigration)\b/i, 'immigration'],
  [/\b(licen[cs]e|registration|inspection|dmv|car|vehicle|toll|ez-?pass)\b/i, 'vehicle_license'],
  [/\b(insurance|policy|premium|deductible)\b/i, 'insurance'],
  [/\b(claim|unclaimed|refund|reimburse)/i, 'claims'],
  [/\b(doctor|dentist|appointment|pcp|physical|vaccine|colonoscopy|eye exam|prescription|health)\b/i, 'health'],
  [/\b(tax|irs|bank|401k|ira|hsa|fsa|credit|loan|mortgage)\b/i, 'finance'],
  [/\b(subscription|netflix|spotify|prime|premium)\b/i, 'subscriptions'],
  [/\b(lease|rent|utility|internet|repair|warranty|apple|iphone|home)\b/i, 'household'],
]
export const guessCategory = (t) => (GUESS.find(([re]) => re.test(t)) || [null, 'other'])[1]

export default function QuickAdd({ meta, onCreated, toasts, openTemplates }) {
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const item = await window.radar.createItem({
        title, due_date: date || null, category: category || guessCategory(title),
        reminders: date ? [30, 7, 1] : [],
      })
      setTitle(''); setDate(''); setCategory('')
      toasts.info(`Added “${item.title}”`)
      onCreated(item)
    } catch (err) { toasts.error(err.message) } finally { setBusy(false) }
  }

  return (
    <form className="quick-add" onSubmit={submit}>
      <input id="quick-add-title" className="qa-title" placeholder="Add something with a date… (e.g. Car registration)"
        value={title} onChange={e => setTitle(e.target.value)} aria-label="Title" autoComplete="off" />
      <input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Due date" />
      <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Category">
        <option value="">{title ? `Auto: ${meta.categories.find(c => c.id === guessCategory(title)).label}` : 'Category'}</option>
        {meta.categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      <button type="submit" className="primary" disabled={!title.trim() || busy}>Add</button>
      <button type="button" onClick={openTemplates} title="⌘T">From template…</button>
    </form>
  )
}
