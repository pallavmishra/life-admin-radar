import React, { useEffect, useRef, useState } from 'react'

/**
 * Household consumables: binary presence only — "have it" / "out of it".
 * No quantities, no depletion, no days-of-supply. Type a name, press
 * Enter: it lands on the "Out of" list (that is why you are typing it).
 */
export default function Reorder({ toasts, version, refresh }) {
  const [list, setList] = useState([])
  const [name, setName] = useState('')
  const input = useRef(null)
  const load = () => window.radar.listConsumables().then(setList).catch(e => toasts.error(e.message))
  useEffect(() => { load() }, [version])
  useEffect(() => { input.current?.focus() }, [])

  const run = async (fn) => { try { await fn(); await load(); refresh() } catch (e) { toasts.error(e.message) } }
  const add = (e) => { e.preventDefault(); if (!name.trim()) return; run(() => window.radar.addConsumable(name, false)); setName('') }
  const out = list.filter(x => !x.have)
  const have = list.filter(x => x.have)

  return (
    <div className="view">
      <header className="view-head">
        <div><h1>Reorder list</h1><p className="lede">Have it or out of it — that's all. Click to flip.</p></div>
      </header>
      <form className="quick-add" onSubmit={add}>
        <input ref={input} className="qa-title" value={name} onChange={e => setName(e.target.value)} placeholder="Out of something? Type it, press Enter" aria-label="Item name" autoComplete="off" />
        <button className="primary" type="submit" disabled={!name.trim()}>Out of it</button>
      </form>
      <div className="two-col">
        <section className="section overdue">
          <h2>Out of <span className="count">{out.length}</span></h2>
          {out.length === 0 ? <div className="empty small">Nothing to reorder.</div> : (
            <ul className="pills">{out.map(x => (
              <li key={x.id}><button className="pill out" onClick={() => run(() => window.radar.setConsumable(x.id, true))} title="Got it — mark as have">{x.name}</button>
                <button className="icon-btn" onClick={() => run(() => window.radar.deleteConsumable(x.id))} aria-label={`Remove ${x.name}`}>×</button></li>
            ))}</ul>
          )}
        </section>
        <section className="section">
          <h2>Have <span className="count">{have.length}</span></h2>
          <ul className="pills">{have.map(x => (
            <li key={x.id}><button className="pill" onClick={() => run(() => window.radar.setConsumable(x.id, false))} title="Ran out — mark as out">{x.name}</button>
              <button className="icon-btn" onClick={() => run(() => window.radar.deleteConsumable(x.id))} aria-label={`Remove ${x.name}`}>×</button></li>
          ))}</ul>
        </section>
      </div>
    </div>
  )
}
