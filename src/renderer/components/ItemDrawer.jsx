import React, { useCallback, useEffect, useState } from 'react'
import Confirm from './Confirm.jsx'
import { formatDay, relative, describeReminder, money } from '../util.js'

const PRESETS = [180, 90, 60, 30, 14, 7, 1, 0]

export default function ItemDrawer({ id, onClose, meta, today, refresh, toasts, version }) {
  const [item, setItem] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [newLabel, setNewLabel] = useState('')
  const [newHint, setNewHint] = useState('')
  const [customDays, setCustomDays] = useState('')
  const [bookDate, setBookDate] = useState('')

  const load = useCallback(async () => {
    try { setItem(await window.radar.getItem(id)) } catch (e) { toasts.error(e.message) }
  }, [id, toasts])
  useEffect(() => { load() }, [load, version])
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && !confirm) onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose, confirm])

  const run = async (fn, msg) => {
    try { const r = await fn(); if (msg) toasts.info(msg); await load(); refresh(); return r } catch (e) { toasts.error(e.message); await load() }
  }
  const patch = (p) => run(() => window.radar.updateItem(id, p))

  if (!item) return <div className="drawer" />
  const isNag = item.kind === 'nag'
  const isSub = item.kind === 'subscription'
  const done = item.status === 'done'
  const days = item.reminders.map(r => r.days_before)

  const setReminders = (list) => patch({ reminders: list.map(d => ({ days_before: d, channel: (item.reminders.find(r => r.days_before === d) || {}).channel || 'notification' })) })
  const toggleChannel = (r) => patch({ reminders: item.reminders.map(x => ({ days_before: x.days_before, channel: x.id === r.id ? (x.channel === 'digest' ? 'notification' : 'digest') : x.channel })) })

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label={item.title}>
        <div className="drawer-head">
          <input className="title-input" defaultValue={item.title} key={`t${item.updated_at}`}
            onBlur={e => e.target.value !== item.title && patch({ title: e.target.value })} aria-label="Title" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="field-grid">
          <label>Category
            <select value={item.category} onChange={e => patch({ category: e.target.value })}>
              {meta.categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          {!isNag && (
            <label>{isSub ? 'Next renewal' : 'Due date'}
              <input type="date" value={item.due_date || ''} onChange={e => patch({ due_date: e.target.value || null })} />
            </label>
          )}
        </div>
        {!isNag && item.due_date && <p className="muted small">{formatDay(item.due_date)} · {relative(item.due_date, today)}</p>}

        {isNag && !done && (
          <div className="callout">
            <b>Not booked yet.</b> The radar nudges every {item.nag_every_days} days until you book it.
            <div className="inline-form">
              <input type="date" value={bookDate} onChange={e => setBookDate(e.target.value)} aria-label="Appointment date" />
              <button className="primary" disabled={!bookDate} onClick={() => run(() => window.radar.bookItem(id, bookDate), 'Booked — reminders set for 7 days and 1 day before')}>Booked for this date</button>
            </div>
          </div>
        )}

        {isSub && item.subscription && <SubscriptionFields item={item} meta={meta} run={run} onCancel={() => setConfirm({ kind: 'cancel-sub' })} />}

        {!isNag && (
          <section className="drawer-section">
            <h4>Reminders</h4>
            <div className="chips">
              {item.reminders.length === 0 && <span className="muted small">None</span>}
              {item.reminders.map(r => (
                <span key={r.id} className={`chip removable ${r.fired_at ? 'fired' : ''}`} title={r.fired_at ? `Sent ${r.fire_note === 'superseded' ? '(skipped — a later reminder covered it)' : ''}` : 'Not sent yet'}>
                  {describeReminder(r.days_before)}
                  <button className="chip-mode" onClick={() => toggleChannel(r)} title="Notification or morning digest">{r.channel === 'digest' ? 'digest' : '🔔'}</button>
                  <button className="chip-x" onClick={() => setReminders(days.filter(d => d !== r.days_before))} aria-label="Remove reminder">×</button>
                </span>
              ))}
            </div>
            <div className="presets">
              {PRESETS.filter(p => !days.includes(p)).map(p => (
                <button key={p} className="mini" onClick={() => setReminders([...days, p])}>+ {describeReminder(p)}</button>
              ))}
              <form onSubmit={e => { e.preventDefault(); const n = parseInt(customDays, 10); if (Number.isInteger(n)) { setReminders([...days, n]); setCustomDays('') } }}>
                <input className="tiny" value={customDays} onChange={e => setCustomDays(e.target.value)} placeholder="days" aria-label="Custom days before" />
              </form>
            </div>
            {!item.due_date && item.reminders.length > 0 && <p className="muted small">Reminders start once there is a date.</p>}
          </section>
        )}

        <section className="drawer-section">
          <h4>Documents &amp; readiness</h4>
          <p className="muted small">Track that you have it and where it lives — never its contents (no SSNs, dates of birth, passwords or ID images).</p>
          <ul className="checklist">
            {item.checklist.map(c => (
              <li key={c.id} className={c.is_done ? 'done' : ''}>
                <input type="checkbox" checked={!!c.is_done} onChange={e => run(() => window.radar.updateChecklist(c.id, { is_done: e.target.checked }))} aria-label={c.label} />
                <div className="cl-text">
                  <input className="cl-label" defaultValue={c.label} key={`l${c.id}${c.label}`} onBlur={e => e.target.value !== c.label && run(() => window.radar.updateChecklist(c.id, { label: e.target.value }))} />
                  <input className="cl-hint" defaultValue={c.location_hint} key={`h${c.id}${c.location_hint}`} placeholder="Where is it? e.g. ~/H1 Documents"
                    onBlur={e => e.target.value !== c.location_hint && run(() => window.radar.updateChecklist(c.id, { location_hint: e.target.value }))} />
                </div>
                <button className="icon-btn" onClick={() => run(() => window.radar.deleteChecklist(c.id))} aria-label={`Remove ${c.label}`}>×</button>
              </li>
            ))}
          </ul>
          <form className="inline-form" onSubmit={e => { e.preventDefault(); if (!newLabel.trim()) return; run(() => window.radar.addChecklist(id, { label: newLabel, location_hint: newHint })).then(() => { setNewLabel(''); setNewHint('') }) }}>
            <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Add a document (e.g. Photo ID front+back)" aria-label="New checklist item" />
            <input value={newHint} onChange={e => setNewHint(e.target.value)} placeholder="Location (optional)" aria-label="Location hint" />
            <button type="submit" disabled={!newLabel.trim()}>Add</button>
          </form>
        </section>

        <section className="drawer-section">
          <h4>Notes</h4>
          <textarea defaultValue={item.notes} key={`n${item.updated_at}`} rows={3} onBlur={e => e.target.value !== item.notes && patch({ notes: e.target.value })} placeholder="Context, claim numbers, who to call…" />
        </section>

        {item.kanban && (
          <section className="drawer-section">
            <h4>Kanban</h4>
            <p className="small">
              {item.kanban.orphaned ? 'The linked card was removed from the board; the radar will not re-create it.' :
                `Linked to a card on the board (${item.kanban.linked_how === 'created' ? 'created by Radar' : 'matched an existing card'})${item.kanban.done_pushed ? ' · moved to Done' : ''}.`}
              {' '}<button className="link" onClick={() => setConfirm({ kind: 'unlink' })}>Unlink</button>
            </p>
          </section>
        )}

        <div className="drawer-foot">
          {done
            ? <button onClick={() => run(() => window.radar.reopenItem(id), 'Reopened')}>Reopen</button>
            : <button className="primary" onClick={() => run(() => window.radar.completeItem(id), item.kanban ? 'Done — the Kanban card will move to Done on the next push' : 'Done')}>Mark done</button>}
          <button className="danger ghost" onClick={() => setConfirm({ kind: 'delete' })}>Delete…</button>
        </div>
      </aside>

      {confirm?.kind === 'delete' && (
        <Confirm title={`Delete “${item.title}”?`} danger confirmLabel="Delete" onCancel={() => setConfirm(null)}
          onConfirm={async () => { setConfirm(null); try { await window.radar.deleteItem(id); toasts.info('Deleted'); refresh(); onClose() } catch (e) { toasts.error(e.message) } }}>
          <p>This permanently removes:</p>
          <ul className="bullets">
            <li>the item{item.due_date ? ` (due ${formatDay(item.due_date)})` : ''}</li>
            <li>{item.reminders.length} reminder{item.reminders.length === 1 ? '' : 's'} and {item.checklist.length} checklist entr{item.checklist.length === 1 ? 'y' : 'ies'}</li>
            {isSub && <li>{item.decisions.length} keep/cancel decision{item.decisions.length === 1 ? '' : 's'}</li>}
            {item.kanban && <li>the link to its Kanban card — the card itself stays on your board</li>}
          </ul>
        </Confirm>
      )}
      {confirm?.kind === 'cancel-sub' && (
        <Confirm title={`Cancel ${item.title}?`} danger confirmLabel="Log as cancelled" onCancel={() => setConfirm(null)}
          onConfirm={async () => { setConfirm(null); await run(() => window.radar.decideSubscription(id, 'cancel'), `Logged: cancel ${item.title}`) }}>
          <p>Radar logs the decision and stops reminding you. It does <b>not</b> cancel anything with the provider — do that on their cancel page{item.subscription?.cancel_url ? ' (Subscriptions ▸ Open…)' : ''}.</p>
        </Confirm>
      )}
      {confirm?.kind === 'unlink' && (
        <Confirm title="Unlink from Kanban?" confirmLabel="Unlink" onCancel={() => setConfirm(null)}
          onConfirm={async () => { setConfirm(null); await run(() => window.radar.kanbanUnlink(id), 'Unlinked') }}>
          <p>The card stays on your board untouched. The radar forgets which card it was; on the next push it will look for a match again (or create a card).</p>
        </Confirm>
      )}
    </div>
  )
}

function SubscriptionFields({ item, meta, run, onCancel }) {
  const s = item.subscription
  const save = (p) => run(() => window.radar.updateItem(item.id, { subscription: p }))
  return (
    <section className="drawer-section">
      <h4>Subscription</h4>
      <div className="field-grid three">
        <label>Cost
          <input defaultValue={s.cost_cents == null ? '' : (s.cost_cents / 100).toFixed(2)} key={`c${s.cost_cents}`} placeholder="unknown" inputMode="decimal"
            onBlur={e => save({ cost: e.target.value })} />
        </label>
        <label>Cycle
          <select value={s.billing_cycle} onChange={e => save({ billing_cycle: e.target.value })}>
            {meta.cycles.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label>Billed via
          <input defaultValue={s.via} key={`v${s.via}`} placeholder="e.g. Apple" onBlur={e => e.target.value !== s.via && save({ via: e.target.value })} />
        </label>
      </div>
      <div className="field-grid">
        <label className="check"><input type="checkbox" checked={!!s.cost_approx} onChange={e => save({ cost_approx: e.target.checked })} /> Amount varies (cost is a typical bill)</label>
        {s.billing_cycle === 'monthly' && (
          <label>Renews on day of month
            <input className="tiny" defaultValue={s.billing_day || ''} key={`d${s.billing_day}`} placeholder="—" inputMode="numeric"
              onBlur={e => String(e.target.value) !== String(s.billing_day || '') && save({ billing_day: e.target.value.trim() || null })} />
          </label>
        )}
      </div>
      <label className="block">Cancel URL
        <input defaultValue={s.cancel_url} key={`u${s.cancel_url}`} placeholder="https://…" onBlur={e => e.target.value !== s.cancel_url && save({ cancel_url: e.target.value })} />
      </label>
      {item.decisions.length > 0 && (
        <ul className="decisions">
          {item.decisions.slice(0, 5).map(d => <li key={d.id}><b>{d.decision}</b> {d.renewal_date ? `for ${d.renewal_date}` : ''} <span className="muted">· {d.decided_on}</span></li>)}
        </ul>
      )}
      <p className="muted small">{s.cost_cents != null ? `${money(s.cost_cents, s.cost_approx)} per ${s.billing_cycle.replace('ly', '')}${s.cost_approx ? ' (varies)' : ''}` : 'Cost unknown'}</p>
      {item.status !== 'done' && (
        <div className="inline-form">
          <button disabled={!item.due_date} title={item.due_date ? 'Log "keep" and move the renewal date one billing cycle' : 'Set the renewal date first'}
            onClick={() => run(() => window.radar.decideSubscription(item.id, 'keep'), `Keeping ${item.title}`)}>Keep</button>
          <button className="danger ghost" onClick={() => onCancel()}>Cancel…</button>
          {s.cancel_url && <span className="muted small">Cancel page: {s.cancel_url}</span>}
        </div>
      )}
    </section>
  )
}
