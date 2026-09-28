import React, { useCallback, useEffect, useState } from 'react'
import Radar from './views/Radar.jsx'
import AllItems from './views/AllItems.jsx'
import Subscriptions from './views/Subscriptions.jsx'
import Reorder from './views/Reorder.jsx'
import Kanban from './views/Kanban.jsx'
import Settings from './views/Settings.jsx'
import ItemDrawer from './components/ItemDrawer.jsx'
import TemplatePicker from './components/TemplatePicker.jsx'
import { Toasts, useToasts } from './components/Toasts.jsx'

const NAV = [
  { id: 'radar', label: 'Radar' },
  { id: 'all', label: 'All items' },
  { id: 'subs', label: 'Subscriptions' },
  { id: 'reorder', label: 'Reorder list' },
  { id: 'kanban', label: 'Kanban push' },
  { id: 'settings', label: 'Settings' },
]

export default function App() {
  const [view, setView] = useState('radar')
  const [meta, setMeta] = useState(null)
  const [dash, setDash] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [version, setVersion] = useState(0)
  const [toastList, toasts] = useToasts()

  const refresh = useCallback(async () => {
    try { setDash(await window.radar.dashboard()) } catch (e) { toasts.error(e.message) }
    setVersion(v => v + 1)
  }, [toasts])

  useEffect(() => {
    window.radar.meta().then(setMeta)
    refresh()
    const offs = [
      window.radar.onChanged(() => refresh()),
      window.radar.onOpenItem((id) => { setOpenId(id); }),
      window.radar.onCommand((cmd) => {
        if (cmd === 'template') setTemplateOpen(true)
        if (cmd === 'new-item') { setView('radar'); setTimeout(() => document.getElementById('quick-add-title')?.focus(), 0) }
      }),
    ]
    return () => offs.forEach(off => off())
  }, [refresh])

  if (!meta || !dash) return <div className="boot">Loading…</div>

  const badge = { kanban: dash.kanbanPending || null, reorder: dash.consumablesOut || null }
  const ctx = { meta, dash, today: dash.today, refresh, openItem: setOpenId, toasts, version, openTemplates: () => setTemplateOpen(true) }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Life-Admin Radar</div>
        <nav>
          {NAV.map(n => (
            <button key={n.id} className={`nav ${view === n.id ? 'active' : ''}`} onClick={() => setView(n.id)}>
              <span>{n.label}</span>
              {badge[n.id] ? <span className="badge">{badge[n.id]}</span> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">Local-only · nothing leaves this Mac</div>
      </aside>
      <main className="content">
        {view === 'radar' && <Radar {...ctx} />}
        {view === 'all' && <AllItems {...ctx} />}
        {view === 'subs' && <Subscriptions {...ctx} />}
        {view === 'reorder' && <Reorder {...ctx} />}
        {view === 'kanban' && <Kanban {...ctx} />}
        {view === 'settings' && <Settings {...ctx} />}
      </main>
      {openId != null && <ItemDrawer id={openId} onClose={() => setOpenId(null)} {...ctx} />}
      {templateOpen && <TemplatePicker onClose={() => setTemplateOpen(false)} onCreated={(it) => { setTemplateOpen(false); refresh(); setOpenId(it.id) }} {...ctx} />}
      <Toasts list={toastList} />
    </div>
  )
}
