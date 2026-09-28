// Sandboxed preload: the only require is `electron`.
const { contextBridge, ipcRenderer } = require('electron')

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args)
  if (!r || !r.ok) {
    const err = new Error((r && r.error) || 'Something went wrong')
    err.code = r && r.code
    throw err
  }
  return r.data
}

const on = (channel) => (fn) => {
  const listener = (_e, payload) => fn(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('radar', {
  dashboard: () => call('radar:dashboard'),
  meta: () => call('radar:meta'),
  tick: () => call('radar:tick'),

  getItem: (id) => call('items:get', id),
  createItem: (draft) => call('items:create', draft),
  updateItem: (id, patch) => call('items:update', id, patch),
  deleteItem: (id) => call('items:delete', id),
  completeItem: (id) => call('items:complete', id),
  reopenItem: (id) => call('items:reopen', id),
  bookItem: (id, date) => call('items:book', id, date),
  createFromTemplate: (templateId, input) => call('templates:create', templateId, input),

  addChecklist: (itemId, c) => call('checklist:add', itemId, c),
  updateChecklist: (id, patch) => call('checklist:update', id, patch),
  deleteChecklist: (id) => call('checklist:delete', id),

  listSubscriptions: () => call('subs:list'),
  decideSubscription: (id, decision, note) => call('subs:decide', id, decision, note),
  openCancelUrl: (id) => call('subs:openCancel', id),

  listConsumables: () => call('consumables:list'),
  addConsumable: (name, have) => call('consumables:add', name, have),
  setConsumable: (id, have) => call('consumables:set', id, have),
  deleteConsumable: (id) => call('consumables:delete', id),

  kanbanStatus: () => call('kanban:status'),
  kanbanPreview: (opts) => call('kanban:preview', opts),
  kanbanExecute: (planId, confirm) => call('kanban:execute', planId, confirm),
  kanbanUnlink: (itemId) => call('kanban:unlink', itemId),
  kanbanCancel: (queueId) => call('kanban:cancel', queueId),
  kanbanChoosePlist: () => call('kanban:choosePlist'),

  getSettings: () => call('settings:get'),
  saveSettings: (patch) => call('settings:save', patch),
  getLoginItem: () => call('app:getLoginItem'),
  setLoginItem: (on) => call('app:setLoginItem', on),
  dataCounts: () => call('data:counts'),
  clearData: (phrase) => call('data:clear', phrase),

  onChanged: on('radar:changed'),
  onOpenItem: on('radar:open-item'),
  onCommand: on('radar:command'),
})
