'use strict'
const { app, BrowserWindow, ipcMain, shell, session, Notification, powerMonitor, dialog, Menu } = require('electron')
const path = require('path')

// Single instance — better-sqlite3 must never have two processes writing
// the same file (same guard as Vitals' singleInstanceGuard.js).
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const { hardenRendererNavigation, buildCsp } = require('./src/main/hardening')
const { openDatabase } = require('./src/main/db')
const { createEngine } = require('./src/main/engine')
const { createKanbanSync } = require('./src/main/kanban/sync')
const { isKanbanRunning } = require('./src/main/kanban/appRunning')
const { createNotifier } = require('./src/main/notifier')
const { makeClock } = require('./src/main/clock')
const { seedItems, applySeedBatches } = require('./src/main/seed')
const { registerIpc } = require('./src/main/ipc')

const isDev = process.env.VITE_DEV === 'true'
const DEV_ORIGIN = 'http://localhost:5174'
const TICK_MS = 60 * 1000

app.setName('Life-Admin Radar')
// Tests and "try it on a scratch profile" runs point this elsewhere.
if (process.env.RADAR_USER_DATA) app.setPath('userData', process.env.RADAR_USER_DATA)

let mainWindow = null
let store = null
let tickTimer = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    title: 'Life-Admin Radar',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandbox ON: preload.js only requires `electron` (contextBridge +
      // ipcRenderer), both available to sandboxed preloads.
      sandbox: true,
    },
  })
  if (process.platform === 'darwin') mainWindow.setWindowButtonPosition({ x: 16, y: 18 })
  hardenRendererNavigation(mainWindow.webContents, { isDev, devOrigin: DEV_ORIGIN, rendererRoot: path.join(__dirname, 'dist', 'renderer'), shell })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })
  if (isDev) mainWindow.loadURL(DEV_ORIGIN)
  else mainWindow.loadFile(path.join(__dirname, 'dist', 'renderer', 'index.html'))
}

function focusItem(itemId) {
  if (!mainWindow) createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (itemId != null) mainWindow.webContents.send('radar:open-item', itemId)
}

app.on('second-instance', () => focusItem(null))

app.whenReady().then(() => {
  // The packaged app gets its icon from the bundle (build/icon.png →
  // icon.icns). `npm start`/`npm run dev` run inside Electron's own bundle,
  // so set the Dock icon explicitly there too.
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')) } catch (_) {}
  }
  // Deny every permission request (camera, mic, geolocation, notifications
  // from the page itself — notifications come from main, not the renderer).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  const CSP = buildCsp({ isDev, devOrigin: DEV_ORIGIN })
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } })
  })

  const userData = app.getPath('userData')
  store = openDatabase(path.join(userData, 'radar.db'))
  const clock = makeClock()
  const log = (...a) => console.warn('[radar]', ...a)
  const notifier = createNotifier({ Notification, onClick: focusItem, log })

  // engine ↔ sync reference each other: the engine asks sync to enqueue,
  // sync asks the engine which items are in their window.
  const kanbanRef = {}
  const engine = createEngine({ store, notifier, kanban: { enqueueDue: (c) => kanbanRef.sync.enqueueDue(c) }, log })
  kanbanRef.sync = createKanbanSync({
    store, engine, notifier, log,
    // RADAR_E2E_KANBAN=not-running exists only for the Linux end-to-end
    // test; on macOS the real check always runs, whatever the environment.
    isRunning: (process.platform !== 'darwin' && process.env.RADAR_E2E_KANBAN === 'not-running')
      ? () => false
      : () => isKanbanRunning(),
    backupDir: path.join(userData, 'kanban-backups'),
  })

  store.seedIfNeeded(seedItems(), clock())
  for (const b of applySeedBatches(store, clock())) {
    if (b.applied) log(`seed batch ${b.id}: added ${b.added.join(', ') || 'nothing'}${b.skipped.length ? `; skipped ${b.skipped.join(', ')}` : ''}`)
  }

  const notifyRenderer = () => { if (mainWindow) mainWindow.webContents.send('radar:changed') }
  const tick = () => {
    try {
      const r = engine.tick(clock())
      if (r.notifications.length || r.kanbanQueued) notifyRenderer()
    } catch (e) { log('tick failed', e) }
  }
  // After any edit, tick shortly (debounced) so a new item that is already
  // inside a reminder window reminds now, not at the next minute.
  let soon = null
  const afterChange = () => {
    notifyRenderer()
    clearTimeout(soon)
    soon = setTimeout(tick, 1500)
  }
  const loginItem = {
    get: () => app.getLoginItemSettings().openAtLogin,
    set: (on) => { app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true }); return app.getLoginItemSettings().openAtLogin },
  }
  registerIpc(ipcMain, { store, engine, sync: kanbanRef.sync, clock, shell, afterChange, dialog, getWindow: () => mainWindow, loginItem })

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [
      { label: 'New Item', accelerator: 'CmdOrCtrl+N', click: () => mainWindow && mainWindow.webContents.send('radar:command', 'new-item') },
      { label: 'New from Template…', accelerator: 'CmdOrCtrl+T', click: () => mainWindow && mainWindow.webContents.send('radar:command', 'template') },
      { type: 'separator' }, { role: 'close' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload', visible: isDev }, { role: 'toggleDevTools', visible: isDev }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]))

  createWindow()
  tick()
  tickTimer = setInterval(tick, TICK_MS)
  powerMonitor.on('resume', tick)

  app.on('activate', () => { if (!mainWindow) createWindow() })
})

// Quiet by default, but the radar keeps its schedule running while the
// window is closed — that is what makes it a radar. Cmd+Q really quits.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

app.on('before-quit', () => {
  if (tickTimer) clearInterval(tickTimer)
  try { store && store.close() } catch (_) {}
})

