import React, { useEffect, useState } from 'react'
import Confirm from '../components/Confirm.jsx'

export default function Settings({ toasts, refresh, version }) {
  const [s, setS] = useState(null)
  const [counts, setCounts] = useState(null)
  const [phrase, setPhrase] = useState('')
  const [overrides, setOverrides] = useState('')
  const [login, setLogin] = useState(false)
  useEffect(() => { window.radar.getLoginItem().then(setLogin).catch(() => {}) }, [])
  const load = async () => {
    const x = await window.radar.getSettings()
    setS(x); setOverrides(x.kanbanFieldOverrides || '')
  }
  useEffect(() => { load().catch(e => toasts.error(e.message)) }, [version])
  const save = async (patch, msg = 'Saved') => {
    try { setS(await window.radar.saveSettings(patch)); toasts.info(msg); refresh() } catch (e) { toasts.error(e.message) }
  }
  if (!s) return <div className="view" />

  return (
    <div className="view narrow">
      <header className="view-head"><h1>Settings</h1></header>

      <section className="section">
        <h2>Running</h2>
        <label className="check">
          <input type="checkbox" checked={login} onChange={e => window.radar.setLoginItem(e.target.checked).then(setLogin).catch(err => toasts.error(err.message))} />
          Open at login (hidden) — reminders only fire while Radar is running
        </label>
        <p className="small muted">Closing the window keeps Radar running in the Dock; ⌘Q quits it.</p>
      </section>

      <section className="section">
        <h2>Morning digest</h2>
        <label className="check">
          <input type="checkbox" checked={s.digestEnabled === '1'} onChange={e => save({ digestEnabled: e.target.checked ? '1' : '0' })} />
          One notification each morning listing what's due in the next 7 days
        </label>
        <label className="inline small">Around
          <select value={s.digestHour} disabled={s.digestEnabled !== '1'} onChange={e => save({ digestHour: e.target.value })}>
            {[6, 7, 8, 9, 10].map(h => <option key={h} value={String(h)}>{h}:00 AM</option>)}
          </select>
        </label>
        <p className="small muted">Off by default. Skipped on days when nothing is due — a quiet week sends nothing.</p>
      </section>

      <section className="section">
        <h2>Kanban Board</h2>
        <label className="block">Board name
          <input defaultValue={s.kanbanBoardName} onBlur={e => e.target.value !== s.kanbanBoardName && save({ kanbanBoardName: e.target.value })} />
        </label>
        <label className="block">Preferences file <span className="muted small">(blank = ~/Library/Preferences/app.pallavmishra.KanbanBoard.plist)</span>
          <input defaultValue={s.kanbanPlistPath} placeholder="default" onBlur={e => e.target.value !== s.kanbanPlistPath && save({ kanbanPlistPath: e.target.value })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={s.kanbanEnabled === '1'} onChange={e => save({ kanbanEnabled: e.target.checked ? '1' : '0' })} />
          Queue cards for the board as items enter their reminder window
        </label>
        <label className="check">
          <input type="checkbox" checked={s.kanbanIncludeSubscriptions === '1'} onChange={e => save({ kanbanIncludeSubscriptions: e.target.checked ? '1' : '0' })} />
          Include subscriptions (off: they auto-renew; keep/cancel happens here in Radar)
        </label>
        <details className="small">
          <summary>Advanced: board format overrides</summary>
          <p className="muted">JSON. Only needed if a dry run shows a wrong guess, e.g. <code>{'{"dueKey":"deadline","dateFormat":"iso8601","tagStyle":"string","priorityValues":["High","Medium","Low"]}'}</code></p>
          <textarea className="mono" rows={3} value={overrides} onChange={e => setOverrides(e.target.value)} />
          <button className="mini" onClick={() => save({ kanbanFieldOverrides: overrides.trim() })}>Save overrides</button>
        </details>
      </section>

      <section className="section">
        <h2>Privacy</h2>
        <p className="small">Everything stays in a local database on this Mac. Radar never stores Social Security numbers, dates of birth, ID images, passwords or credential values — it refuses to save text that looks like one. Track <i>where</i> a document lives instead.</p>
      </section>

      <section className="section">
        <h2>Data</h2>
        <button className="danger ghost" onClick={() => window.radar.dataCounts().then(setCounts)}>Clear all data…</button>
      </section>

      {counts && (
        <Confirm title="Clear all Radar data?" danger confirmLabel="Clear everything" disabled={phrase !== 'clear'}
          onCancel={() => { setCounts(null); setPhrase('') }}
          onConfirm={async () => {
            try { await window.radar.clearData(phrase); toasts.info('Cleared'); refresh() } catch (e) { toasts.error(e.message) }
            setCounts(null); setPhrase('')
          }}>
          <p>This permanently deletes:</p>
          <ul className="bullets">
            <li>{counts.items} items, {counts.reminders} reminders, {counts.checklist} checklist entries</li>
            <li>{counts.decisions} subscription decisions, {counts.consumables} reorder-list entries</li>
            <li>{counts.kanbanLinks} Kanban links (cards on your board are not touched)</li>
          </ul>
          <label className="block">Type <b>clear</b> to confirm<input value={phrase} onChange={e => setPhrase(e.target.value)} autoFocus /></label>
        </Confirm>
      )}
    </div>
  )
}
