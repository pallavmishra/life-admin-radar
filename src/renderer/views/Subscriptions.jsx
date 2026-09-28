import React, { useEffect, useState } from 'react'
import Confirm from '../components/Confirm.jsx'
import { money, formatDay, relative, diffDays } from '../util.js'

const per = { monthly: 'mo', quarterly: 'qtr', yearly: 'yr' }
const monthly = (s) => s.cost_cents == null ? 0 : s.billing_cycle === 'yearly' ? s.cost_cents / 12 : s.billing_cycle === 'quarterly' ? s.cost_cents / 3 : s.cost_cents

export default function Subscriptions({ today, openItem, refresh, toasts, version, openTemplates }) {
  const [subs, setSubs] = useState([])
  const [confirm, setConfirm] = useState(null)
  const [showDone, setShowDone] = useState(false)
  const load = () => window.radar.listSubscriptions().then(setSubs).catch(e => toasts.error(e.message))
  useEffect(() => { load() }, [version])

  const act = async (fn, msg) => { try { await fn(); toasts.info(msg); await load(); refresh() } catch (e) { toasts.error(e.message) } }
  const active = subs.filter(s => s.status !== 'done')
  const list = showDone ? subs : active
  const known = active.filter(s => s.subscription.cost_cents != null)
  const total = known.reduce((n, s) => n + monthly(s.subscription), 0)
  const autoRenewed = active.filter(s => s.decisions.some(d => d.decision === 'auto-renewed'))

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>Subscriptions</h1>
          <p className="lede">{active.length} active · {money(Math.round(total))}/mo known{known.length < active.length ? ` (+${active.length - known.length} with unknown cost)` : ''}
            {autoRenewed.length ? ` · ${autoRenewed.length} renewed without a keep/cancel decision` : ''}</p>
        </div>
        <button onClick={openTemplates}>Add subscription…</button>
      </header>
      <table className="subs">
        <thead><tr><th>Name</th><th>Cost</th><th>Next renewal</th><th>Cancel</th><th>Last decision</th><th /></tr></thead>
        <tbody>
          {list.map(s => {
            const sub = s.subscription
            const last = s.decisions[0]
            const soon = s.due_date && diffDays(today, s.due_date) <= 7 && s.status !== 'done'
            return (
              <tr key={s.id} className={s.status === 'done' ? 'dim' : soon ? 'soon' : ''}>
                <td><button className="link strong" onClick={() => openItem(s.id)}>{s.title}</button>{sub.via && <span className="muted small"> via {sub.via}</span>}</td>
                <td>{sub.cost_cents == null ? <span className="muted">unknown</span> : `${money(sub.cost_cents)}/${per[sub.billing_cycle]}`}</td>
                <td>
                  <input type="date" className="compact" value={s.due_date || ''} aria-label={`Next renewal for ${s.title}`}
                    onChange={e => act(() => window.radar.updateItem(s.id, { due_date: e.target.value || null }), 'Renewal date saved')} />
                  {s.due_date ? <div className="muted small">{relative(s.due_date, today)}</div> : <div className="muted small">set it to get the 7-day prompt</div>}
                </td>
                <td>{sub.cancel_url ? <button className="link" onClick={() => setConfirm({ kind: 'open', s })}>Open…</button> : <span className="muted">—</span>}</td>
                <td className="small">{last ? <><b>{last.decision}</b> <span className="muted">{last.decided_on}</span></> : <span className="muted">none yet</span>}</td>
                <td className="actions">
                  {s.status !== 'done' && <>
                    <button className="mini" disabled={!s.due_date} title={s.due_date ? `Keep — next renewal moves one ${sub.billing_cycle.replace('ly', '')}` : 'Set a renewal date first'}
                      onClick={() => act(() => window.radar.decideSubscription(s.id, 'keep'), `Keeping ${s.title}`)}>Keep</button>
                    <button className="mini danger ghost" onClick={() => setConfirm({ kind: 'cancel', s })}>Cancel…</button>
                  </>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="hidden-toggle"><button className="link" onClick={() => setShowDone(v => !v)}>{showDone ? 'Hide' : 'Show'} cancelled</button></div>

      {confirm?.kind === 'open' && (
        <Confirm title="Open the cancel page?" confirmLabel="Open in browser" onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); act(() => window.radar.openCancelUrl(confirm.s.id), 'Opened in your browser') }}>
          <p>This opens <code>{confirm.s.subscription.cancel_url}</code> in your default browser. Nothing is sent from Radar.</p>
        </Confirm>
      )}
      {confirm?.kind === 'cancel' && (
        <Confirm title={`Cancel ${confirm.s.title}?`} confirmLabel="Log as cancelled" danger onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); act(() => window.radar.decideSubscription(confirm.s.id, 'cancel'), `Logged: cancel ${confirm.s.title}`) }}>
          <p>Radar logs the decision and stops reminding you. It does <b>not</b> cancel anything itself — use the cancel page{confirm.s.subscription.cancel_url ? ' (Open… in the list)' : ''} to actually cancel with the provider.</p>
          {confirm.s.due_date && <p className="muted small">Current renewal: {formatDay(confirm.s.due_date)}.</p>}
        </Confirm>
      )}
    </div>
  )
}
