import React, { useEffect, useState } from 'react'

const ACTION_LABEL = {
  create: 'New card', link: 'Link existing card', update: 'Update card', 'move-to-done': 'Move to Done',
  unchanged: 'No change', orphaned: 'Card was deleted', skip: 'Skipped',
}

export default function Kanban({ toasts, refresh, version }) {
  const [st, setSt] = useState(null)
  const [pv, setPv] = useState(null)
  const [pvOpts, setPvOpts] = useState({})
  const [choices, setChoices] = useState({})
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lastWrite, setLastWrite] = useState(null)

  const load = () => window.radar.kanbanStatus().then(setSt).catch(e => toasts.error(e.message))
  useEffect(() => { load() }, [version])

  const preview = async (opts = pvOpts, ch = choices) => {
    setBusy(true); setChecked(false); setLastWrite(null)
    try {
      setPvOpts(opts)
      setPv(await window.radar.kanbanPreview({ ...opts, choices: ch }))
      await load()
    } catch (e) { toasts.error(e.message) } finally { setBusy(false) }
  }
  const previewCopy = async () => {
    const p = await window.radar.kanbanChoosePlist().catch(e => toasts.error(e.message))
    if (p) preview({ path: p }, {})
  }
  const choose = (itemId, value) => {
    const ch = { ...choices }
    if (value === 'auto') delete ch[itemId]
    else if (value === 'create') ch[itemId] = { forceCreate: true }
    else ch[itemId] = { cardId: value }
    setChoices(ch)
    preview(pvOpts, ch)
  }
  const execute = async () => {
    setBusy(true)
    try {
      const r = await window.radar.kanbanExecute(pv.planId, checked)
      if (r.ok) {
        setLastWrite(r); setPv(null); setChoices({})
        toasts.info('Kanban Board updated')
        refresh()
      } else {
        toasts.error(r.error)
        if (r.queued) setPv(p => ({ ...p, running: true }))
      }
      await load()
    } catch (e) { toasts.error(e.message) } finally { setBusy(false) }
  }

  if (!st) return <div className="view" />
  const guesses = pv ? pv.issues.filter(i => i.level === 'confirm') : []
  const blocking = pv ? pv.issues.filter(i => i.level === 'blocking') : []
  const canWrite = pv && pv.planId && !blocking.length && !pv.running && (!guesses.length || checked) && !busy
  const isCopy = !!(pv && pvOpts.path)

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>Kanban push</h1>
          <p className="lede">One way: Radar → “{st.boardName}”. Radar never reads tasks back and never writes while Kanban Board is running.</p>
        </div>
      </header>

      <div className="status-card">
        <div><span className="muted small">Board file</span><div className="mono small">{st.path}</div></div>
        <div><span className="muted small">Kanban Board</span><div className={st.running ? 'warn' : 'ok'}>{st.running ? 'Running — quit it to push' : 'Not running'}</div></div>
        <div><span className="muted small">Live pushes</span><div>{st.liveWrites}</div></div>
        <button className="mini" onClick={load}>Recheck</button>
      </div>

      <section className="section">
        <h2>Queued for the board <span className="count">{st.pending.length}</span></h2>
        {st.pending.length === 0 ? <div className="empty small">Nothing queued. Items join the queue when they enter their first reminder window, change date, or are marked done.</div> : (
          <ul className="rows">
            {st.pending.map(q => (
              <li key={q.id} className="row">
                <div className="row-main static"><span className="row-text"><span className="row-title">{q.title}</span>
                  <span className="row-sub">{q.op === 'complete' ? 'Move card to Done' : 'Add / update card'}{q.notified_at ? ' · waiting for Kanban Board to quit' : ''}</span></span></div>
                <button className="icon-btn" title="Remove from queue" onClick={() => window.radar.kanbanCancel(q.id).then(load)}>×</button>
              </li>
            ))}
          </ul>
        )}
        <div className="button-row">
          <button className="primary" disabled={busy} onClick={() => preview({}, choices)}>Preview push (dry run)</button>
          <button disabled={busy} onClick={() => preview({ all: true }, choices)} title="Queue everything currently in its reminder window, then preview">Push now…</button>
          <button disabled={busy} onClick={previewCopy} title="Recommended before your first real push: File ▸ duplicate the plist, then pick the copy">Dry run against a copy…</button>
        </div>
      </section>

      {lastWrite && (
        <div className="callout ok">
          <b>Written.</b> {lastWrite.results.filter(r => r.action !== 'unchanged').length} change(s) on the board, verified by reading it back{lastWrite.verifiedVia === 'cfprefsd' ? ' through macOS preferences' : ''}.
          {lastWrite.backup && <div className="small muted">Previous file backed up to <span className="mono">{lastWrite.backup}</span></div>}
        </div>
      )}

      {pv && (
        <section className="section preview">
          <h2>Dry run {isCopy && <span className="hint">against a copy</span>}</h2>
          <p className="small muted mono">{pv.file.path}{pv.file.format ? ` · ${pv.file.format} plist · board stored as <${pv.file.encoding}>` : ''}</p>
          {pv.running && <div className="callout warn">Kanban Board is running. Quit it (⌘Q in Kanban Board), then preview again. Your cards stay queued.</div>}
          {blocking.map(i => <div key={i.code} className="callout bad"><b>Can't write:</b> {i.message}</div>)}
          {guesses.length > 0 && (
            <div className="callout warn">
              <b>Check these before writing</b> — the board didn't show Radar how it stores them yet:
              <ul className="bullets">{guesses.map(i => <li key={i.code}>{i.message}</li>)}</ul>
            </div>
          )}
          {pv.issues.filter(i => i.level === 'info').map(i => <p key={i.code} className="small muted">{i.message}</p>)}
          {pv.results.length === 0 && !blocking.length && <div className="empty small">Nothing to push.</div>}

          {pv.results.map(r => (
            <div key={`${r.itemId}-${r.op}`} className={`plan-card ${r.action}`}>
              <div className="plan-head">
                <span className={`action-badge ${r.action}`}>{ACTION_LABEL[r.action] || r.action}</span>
                <b>{r.itemTitle}</b>
                {r.cardTitle && r.cardTitle !== r.itemTitle && <span> → card “{r.cardTitle}”</span>}
                {r.list && <span className="muted"> in {r.list}</span>}
              </div>
              {r.reason && <p className="small">{r.reason}</p>}
              {r.op === 'upsert' && ['create', 'link'].includes(r.action) && pv.shape && (
                <label className="small match-choice">
                  {r.action === 'link' && r.match && !r.match.manual ? `Matched by title (${Math.round(r.match.score * 100)}%). ` : ''}
                  Use:
                  <select value={choices[r.itemId]?.forceCreate ? 'create' : choices[r.itemId]?.cardId || 'auto'} onChange={e => choose(r.itemId, e.target.value)}>
                    <option value="auto">Automatic (dedupe by title)</option>
                    <option value="create">A new card</option>
                    {pv.shape.cards.map(c => <option key={c.id} value={c.id}>Existing: {c.title}</option>)}
                  </select>
                </label>
              )}
              {r.after && (
                <details>
                  <summary className="small">Card JSON that would be written</summary>
                  <pre className="json">{JSON.stringify(r.after, null, 2)}</pre>
                  {r.before && <><div className="small muted">Before:</div><pre className="json dim">{JSON.stringify(r.before, null, 2)}</pre></>}
                </details>
              )}
            </div>
          ))}

          {pv.invariants && <p className="small muted">Safety check: cards on the board {pv.invariants.cardsBefore} → {pv.invariants.cardsAfter} (+{pv.invariants.created} new); no other card, list, board or preference changes.</p>}
          {pv.shape && (
            <details className="small">
              <summary>How Radar reads this board</summary>
              <pre className="json">{JSON.stringify({ ...pv.shape, cards: `${pv.shape.cards.length} cards` }, null, 2)}</pre>
            </details>
          )}

          {pv.planId && (
            <div className="execute-bar">
              {guesses.length > 0 && (
                <label className="check"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} /> I checked the dry run</label>
              )}
              <button className="primary" disabled={!canWrite} onClick={execute}>{isCopy ? 'Write to the copy' : 'Write to Kanban Board'}</button>
              <span className="small muted">Writes one complete file atomically; backs up the old one first.</span>
            </div>
          )}
        </section>
      )}

      <section className="section">
        <h2>Linked cards <span className="count">{st.links.length}</span></h2>
        {st.links.length === 0 ? <div className="empty small">None yet.</div> : (
          <ul className="plain small">{st.links.map(l => <li key={l.item_id}>{l.title} — {l.orphaned ? 'card removed from board' : l.linked_how === 'created' ? 'card created by Radar' : 'linked to an existing card'}{l.done_pushed ? ' · in Done' : ''}</li>)}</ul>
        )}
      </section>

      <section className="section">
        <h2>Automatic push</h2>
        <label className="check">
          <input type="checkbox" checked={st.autoPush} disabled={st.liveWrites < 1}
            onChange={e => window.radar.saveSettings({ kanbanAutoPush: e.target.checked ? '1' : '0' }).then(load).catch(err => toasts.error(err.message))} />
          Push queued cards automatically when Kanban Board is quit
        </label>
        <p className="small muted">{st.liveWrites < 1 ? 'Unlocks after your first reviewed push.' : 'Title matches and anything new that would need a guess still wait here for you to review.'}</p>
      </section>

      {st.history.length > 0 && (
        <section className="section dim">
          <h2>History</h2>
          <ul className="plain small">{st.history.map(h => <li key={h.id}>{h.applied_at || h.created_at} · {h.title} · {h.op} · {h.status}{h.error ? ` — ${h.error}` : ''}</li>)}</ul>
        </section>
      )}
    </div>
  )
}
