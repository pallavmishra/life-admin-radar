'use strict'
/**
 * IPC surface. Every handler validates its input here in main — the
 * renderer is treated as untrusted, same stance as Vitals.
 */
const { TEMPLATES, instantiate } = require('../shared/templates')
const { CATEGORIES, BILLING_CYCLES } = require('../shared/constants')
const { bucketItems } = require('./status')
const { nextReminderDay } = require('./reminders')

const SETTINGS_WRITABLE = new Set([
  'digestEnabled', 'digestHour', 'kanbanPlistPath', 'kanbanBoardName', 'kanbanEnabled', 'kanbanAutoPush',
  'kanbanIncludeSubscriptions', 'kanbanFieldOverrides',
])

const int = (v, what = 'id') => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${what}`)
  return n
}
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

function registerIpc(ipcMain, { store, engine, sync, clock, shell, afterChange, dialog, getWindow, loginItem }) {
  const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) } } catch (e) {
      return { ok: false, error: e.message, code: e.name === 'PrivacyError' ? 'privacy' : undefined }
    }
  })
  let chosenPath = null
  const mutate = (fn) => (...args) => { const r = fn(...args); afterChange(); return r }

  // ── read models ──
  handle('radar:dashboard', () => {
    const c = clock()
    const items = store.listItems()
    const reminders = store.rawReminders()
    for (const it of items) it.next_reminder = nextReminderDay(it, reminders, c.today)
    const s = store.getSettings()
    return {
      today: c.today,
      buckets: bucketItems(items, c.today),
      kanbanPending: sync.pending().length,
      consumablesOut: store.listConsumables().filter(x => !x.have).length,
      digestEnabled: s.digestEnabled === '1',
    }
  })
  handle('radar:meta', () => ({ categories: CATEGORIES, cycles: BILLING_CYCLES, templates: TEMPLATES, today: clock().today }))

  // ── items ──
  handle('items:get', (id) => store.getItem(int(id)))
  handle('items:create', mutate((draft) => store.createItem(obj(draft), clock())))
  handle('items:update', mutate((id, patch) => store.updateItem(int(id), obj(patch), clock())))
  handle('items:delete', mutate((id) => store.deleteItem(int(id))))
  handle('items:complete', mutate((id) => store.completeItem(int(id), clock())))
  handle('items:reopen', mutate((id) => store.reopenItem(int(id), clock())))
  handle('items:book', mutate((id, date) => store.bookNag(int(id), String(date || ''), clock())))
  handle('templates:create', mutate((id, input) => store.createItem(instantiate(String(id), obj(input)), clock())))

  // ── checklist ──
  handle('checklist:add', mutate((itemId, c) => store.addChecklistItem(int(itemId), obj(c))))
  handle('checklist:update', mutate((id, patch) => store.updateChecklistItem(int(id), obj(patch))))
  handle('checklist:delete', mutate((id) => store.deleteChecklistItem(int(id))))

  // ── subscriptions ──
  handle('subs:list', () => store.listItems().filter(i => i.kind === 'subscription'))
  handle('subs:decide', mutate((id, decision, note) => store.decideSubscription(int(id), String(decision), { ...clock(), note: String(note || '') })))
  handle('subs:openCancel', (id) => {
    const it = store.getItem(int(id))
    const url = it && it.subscription && it.subscription.cancel_url
    if (!url || !/^https:\/\//i.test(url)) throw new Error('No cancel URL saved')
    shell.openExternal(url)
    return url
  })

  // ── consumables (presence only) ──
  handle('consumables:list', () => store.listConsumables())
  handle('consumables:add', mutate((name, have) => store.addConsumable(String(name || ''), { nowIso: clock().nowIso, have: have !== false })))
  handle('consumables:set', mutate((id, have) => store.setConsumableHave(int(id), !!have, clock())))
  handle('consumables:delete', mutate((id) => store.deleteConsumable(int(id))))

  // ── kanban ──
  handle('kanban:status', () => {
    // Re-evaluate the queue first, so the screen never shows an entry that
    // no longer qualifies (setting changed, item re-filed, date moved).
    try { sync.enqueueDue(clock(), { auto: false }) } catch (_) {}
    const s = store.getSettings()
    return {
      path: sync.plistPath(), running: sync.isRunning(), pending: sync.pending(), history: sync.history(),
      liveWrites: Number(s.kanbanLiveWrites || 0), autoPush: s.kanbanAutoPush === '1', boardName: s.kanbanBoardName,
      links: store.raw.prepare(`SELECT l.*, i.title FROM kanban_links l JOIN life_items i ON i.id = l.item_id ORDER BY i.title`).all(),
    }
  })
  handle('kanban:preview', (opts) => {
    const o = obj(opts)
    const choices = {}
    for (const [k, v] of Object.entries(obj(o.choices))) {
      const c = obj(v)
      choices[int(k)] = c.forceCreate ? { forceCreate: true } : (c.cardId ? { cardId: String(c.cardId) } : {})
    }
    // A one-off path (a COPY of the real plist, for a dry run) is only
    // accepted if the user picked it in the main-process file dialog.
    const p = typeof o.path === 'string' && o.path ? o.path : undefined
    if (p && p !== chosenPath) throw new Error('Pick the file with "Choose a copy…" first')
    return sync.preview(clock(), { all: !!o.all, choices, path: p })
  })
  handle('kanban:execute', mutate((planId, confirm) => sync.execute(clock(), String(planId || ''), { confirmGuesses: confirm === true })))
  handle('kanban:unlink', mutate((itemId) => sync.unlink(int(itemId))))
  handle('kanban:cancel', mutate((qid) => sync.cancelQueued(int(qid))))
  handle('kanban:choosePlist', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose a Kanban plist (use a COPY for a dry run)', properties: ['openFile'],
      filters: [{ name: 'Property list', extensions: ['plist'] }],
    })
    if (r.canceled) return null
    chosenPath = r.filePaths[0]
    return chosenPath
  })

  // ── settings / data ──
  handle('settings:get', () => store.getSettings())
  handle('settings:save', mutate((patch) => {
    const clean = {}
    for (const [k, v] of Object.entries(obj(patch))) {
      if (!SETTINGS_WRITABLE.has(k)) throw new Error(`Setting ${k} is not writable`)
      if (k === 'kanbanFieldOverrides' && v) JSON.parse(v) // must be valid JSON
      if (k === 'kanbanAutoPush' && v === '1' && Number(store.getSettings().kanbanLiveWrites || 0) < 1) {
        throw new Error('Do one reviewed push first — auto-push unlocks after that.')
      }
      clean[k] = v
    }
    store.saveSettings(clean)
    return store.getSettings()
  }))
  handle('app:getLoginItem', () => loginItem.get())
  handle('app:setLoginItem', (on) => loginItem.set(on === true))
  handle('data:counts', () => store.countAll())
  handle('data:clear', mutate((phrase) => {
    if (phrase !== 'clear') throw new Error('Type "clear" to confirm')
    store.clearAll()
    return store.countAll()
  }))
  handle('radar:tick', mutate(() => engine.tick(clock())))
}

module.exports = { registerIpc }
