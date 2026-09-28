import React from 'react'
import { relative, formatDay, readiness, CATEGORY_COLORS, money } from '../util.js'

export default function ItemRow({ item, today, onOpen, onComplete, tone }) {
  const r = readiness(item.checklist)
  const isSub = item.kind === 'subscription'
  return (
    <li className={`row ${tone || ''}`}>
      <button className="row-main" onClick={() => onOpen(item.id)}>
        <span className="dot" style={{ background: CATEGORY_COLORS[item.category] }} aria-hidden />
        <span className="row-text">
          <span className="row-title">{item.title}</span>
          <span className="row-sub">
            {item.kind === 'nag'
              ? <span>No date yet · nudges every {item.nag_every_days} days until booked</span>
              : item.due_date
                ? <span title={formatDay(item.due_date)}>{formatDay(item.due_date, { year: false })} · <b>{relative(item.due_date, today)}</b></span>
                : <span className="muted">No date{isSub ? ' — add the renewal date' : ''}</span>}
            {isSub && item.subscription && item.subscription.cost_cents != null && <span className="muted"> · {money(item.subscription.cost_cents, item.subscription.cost_approx)}/{item.subscription.billing_cycle === 'yearly' ? 'yr' : item.subscription.billing_cycle === 'quarterly' ? 'qtr' : 'mo'}</span>}
          </span>
        </span>
        {r && <span className={`chip ${r.all ? 'ok' : ''}`} title="Documents ready">{r.done}/{r.total} ready</span>}
        {item.kanban && !item.kanban.orphaned && <span className="chip kanban" title="Linked to a Kanban card">Kanban</span>}
      </button>
      {onComplete && item.status !== 'done' && (
        <button className="icon-btn" title="Mark done" aria-label={`Mark ${item.title} done`} onClick={() => onComplete(item)}>✓</button>
      )}
    </li>
  )
}
