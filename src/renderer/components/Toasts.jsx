import React, { useMemo, useState } from 'react'

/** Returns [list, api]; `api` is stable across renders. */
export function useToasts() {
  const [list, setList] = useState([])
  const api = useMemo(() => {
    const push = (kind, text) => {
      const id = Math.random().toString(36).slice(2)
      setList(l => [...l, { id, kind, text }])
      setTimeout(() => setList(l => l.filter(t => t.id !== id)), kind === 'error' ? 7000 : 3500)
    }
    return { info: (t) => push('info', t), error: (t) => push('error', t) }
  }, [])
  return [list, api]
}

export function Toasts({ list }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
    </div>
  )
}
