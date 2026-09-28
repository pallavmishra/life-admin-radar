import React, { useEffect, useRef } from 'react'

/** Preview-before-execute dialog: shows exactly what will happen. */
export default function Confirm({ title, children, confirmLabel = 'Confirm', danger, onConfirm, onCancel, disabled }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.focus()
    const k = (e) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onCancel])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal small" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button ref={ref} className={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={disabled}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
