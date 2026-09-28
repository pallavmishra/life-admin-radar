import React, { useMemo, useState } from 'react'
import ItemRow from '../components/ItemRow.jsx'

export default function AllItems({ dash, meta, today, openItem, openTemplates }) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [show, setShow] = useState('open')
  const all = useMemo(() => Object.values(dash.buckets).flat(), [dash])
  const list = all
    .filter(i => (show === 'all') || (show === 'done' ? i.status === 'done' : i.status !== 'done'))
    .filter(i => !cat || i.category === cat)
    .filter(i => !q || i.title.toLowerCase().includes(q.toLowerCase()) || (i.notes || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.title.localeCompare(b.title))
  return (
    <div className="view">
      <header className="view-head"><h1>All items</h1><button onClick={openTemplates}>From template…</button></header>
      <div className="filters">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search" aria-label="Search" />
        <select value={cat} onChange={e => setCat(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {meta.categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <div className="segmented" role="group" aria-label="Status">
          {['open', 'done', 'all'].map(s => <button key={s} className={show === s ? 'active' : ''} onClick={() => setShow(s)}>{s[0].toUpperCase() + s.slice(1)}</button>)}
        </div>
      </div>
      {list.length === 0 ? <div className="empty">Nothing matches.</div> : (
        <ul className="rows">{list.map(i => <ItemRow key={i.id} item={i} today={today} onOpen={openItem} />)}</ul>
      )}
    </div>
  )
}
