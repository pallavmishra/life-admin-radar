import React, { useState } from 'react'
import ItemRow from '../components/ItemRow.jsx'
import QuickAdd from '../components/QuickAdd.jsx'
import { longToday } from '../util.js'

const SECTIONS = [
  { key: 'overdue', label: 'Overdue', tone: 'overdue' },
  { key: 'week', label: 'Due in 7 days', tone: 'soon' },
  { key: 'month', label: 'Due in 30 days' },
  { key: 'quarter', label: 'Upcoming 90 days' },
  { key: 'toBook', label: 'To book', hint: 'No date yet — gentle nudge every 14 days' },
]
const HIDDEN = [
  { key: 'later', label: 'Later than 90 days' },
  { key: 'undated', label: 'No date' },
  { key: 'done', label: 'Done' },
]

export default function Radar({ dash, today, meta, openItem, refresh, toasts, openTemplates }) {
  const [showHidden, setShowHidden] = useState(false)
  const b = dash.buckets
  const complete = async (item) => {
    try { await window.radar.completeItem(item.id); toasts.info(`Done: ${item.title}`); refresh() } catch (e) { toasts.error(e.message) }
  }
  const visible = SECTIONS.filter(s => b[s.key].length)
  const hiddenCount = HIDDEN.reduce((n, s) => n + b[s.key].length, 0)
  const soonCount = b.overdue.length + b.week.length

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>{longToday(today)}</h1>
          <p className="lede">
            {soonCount === 0
              ? 'Nothing due this week. The radar is quiet.'
              : `${soonCount} thing${soonCount === 1 ? '' : 's'} need${soonCount === 1 ? 's' : ''} attention this week${b.overdue.length ? ` — ${b.overdue.length} overdue` : ''}.`}
          </p>
        </div>
      </header>
      <QuickAdd meta={meta} toasts={toasts} openTemplates={openTemplates} onCreated={() => refresh()} />

      {visible.length === 0 && <div className="empty">Nothing in the next 90 days.</div>}
      {visible.map(s => (
        <section key={s.key} className={`section ${s.tone || ''}`}>
          <h2>{s.label} <span className="count">{b[s.key].length}</span>{s.hint && <span className="hint">{s.hint}</span>}</h2>
          <ul className="rows">
            {b[s.key].map(it => <ItemRow key={it.id} item={it} today={today} onOpen={openItem} onComplete={complete} tone={s.tone} />)}
          </ul>
        </section>
      ))}

      {hiddenCount > 0 && (
        <div className="hidden-toggle">
          <button className="link" onClick={() => setShowHidden(v => !v)}>
            {showHidden ? 'Hide' : 'Show'} {hiddenCount} more ({HIDDEN.filter(s => b[s.key].length).map(s => `${b[s.key].length} ${s.label.toLowerCase()}`).join(', ')})
          </button>
        </div>
      )}
      {showHidden && HIDDEN.filter(s => b[s.key].length).map(s => (
        <section key={s.key} className="section dim">
          <h2>{s.label} <span className="count">{b[s.key].length}</span></h2>
          <ul className="rows">
            {b[s.key].map(it => <ItemRow key={it.id} item={it} today={today} onOpen={openItem} onComplete={s.key === 'done' ? null : complete} />)}
          </ul>
        </section>
      ))}
    </div>
  )
}
