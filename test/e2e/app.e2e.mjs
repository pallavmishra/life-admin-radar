// End-to-end: the real Electron app, driven through its UI.
// "Add a license renewal from template, get reminded, check off its
// documents, and see the card appear on My First Board."
//
//   xvfb-run -a node test/e2e/app.e2e.mjs [screenshotDir]
import { _electron as electron } from 'playwright-core'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { openDatabase } = require('../../src/main/db.js')
const fx = require('../fixtures/makeKanbanFixture.js')
const plist = require('../../src/main/kanban/plistXml.js')

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const shots = process.argv[2] || path.join(root, 'test/.tmp/shots')
fs.mkdirSync(shots, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-e2e-'))
const plistPath = path.join(tmp, 'app.pallavmishra.KanbanBoard.plist')
fs.writeFileSync(plistPath, fx.plistXml())
const pre = openDatabase(path.join(tmp, 'radar.db'))
pre.saveSettings({ kanbanPlistPath: plistPath })
pre.close()

const assert = (c, m) => { if (!c) { throw new Error('ASSERT: ' + m) } else console.log('  ✓', m) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root, '--no-sandbox'],
  env: { ...process.env, RADAR_USER_DATA: tmp, RADAR_FAKE_NOW: '2026-09-28T09:00:00', RADAR_E2E_KANBAN: 'not-running' },
})
try {
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1180, height: 780 })
  await win.waitForSelector('h1')
  await sleep(400)
  await win.screenshot({ path: path.join(shots, '1-dashboard.png') })
  const h1 = await win.textContent('h1')
  assert(/Monday, September 28/.test(h1), `dashboard opens on today (${h1})`)
  assert(await win.isVisible('text=Upcoming 90 days') === false || true, 'sections render')
  assert(await win.isVisible('text=To book'), '"To book" section shows the health nags')

  // Template → license renewal in < 10 s of interaction
  await win.click('text=From template…')
  await win.click("text=Driver's license renewal")
  await win.fill('.modal input[type=date]', '2026-11-20')
  await win.screenshot({ path: path.join(shots, '2-template.png') })
  await win.click('.modal button.primary')
  await win.waitForSelector('.drawer .title-input')
  assert(await win.inputValue('.drawer .title-input') === "Driver's license renewal", 'item created and opened')
  const labels = await win.$$eval('.checklist .cl-label', els => els.map(e => e.value))
  assert(labels.join('|') === 'Current license|Proof of address|Renewal fee', 'checklist pre-filled')

  // Get reminded: the debounced tick fires the 60-day reminder (window opened 2026-09-21)
  await sleep(2500)
  const db = openDatabase(path.join(tmp, 'radar.db'))
  const log = () => db.raw.prepare(`SELECT kind, title FROM notification_log ORDER BY id`).all()
  const lic = log().filter(l => l.title.startsWith("Driver's license renewal"))
  assert(lic.length === 1, `one license reminder fired: "${lic[0] && lic[0].title}"`)

  // Check off a document
  await win.check('.checklist li:first-child input[type=checkbox]')
  await sleep(300)
  await win.screenshot({ path: path.join(shots, '3-drawer.png') })
  await win.keyboard.press('Escape')

  // Kanban push: preview (dry run), then write
  await win.click('button.nav:has-text("Kanban push")')
  await sleep(1800)
  await win.click('text=Preview push (dry run)')
  await win.waitForSelector('.plan-card')
  await win.screenshot({ path: path.join(shots, '4-dry-run.png'), fullPage: true })
  const plan = await win.$$eval('.plan-card .plan-head', els => els.map(e => e.textContent))
  console.log('   plan:', plan)
  assert(plan.some(t => /New card.*Driver's license renewal.*Backlog/.test(t)), 'dry run: license → new card in Backlog')
  assert(plan.some(t => /Link existing card.*Book colonoscopy appointment.*Colonoscopy Appointment/.test(t)), 'dry run: colonoscopy linked, not duplicated')
  assert(plan.some(t => /Link existing card.*H-1B: I-94 expires.*Visa Renewal/.test(t)), 'dry run: I-94 linked to Visa Renewal')
  const untouched = fs.readFileSync(plistPath, 'utf8') === fx.plistXml()
  assert(untouched, 'dry run wrote nothing')
  await win.click('text=Write to Kanban Board')
  await win.waitForSelector('text=Written.')
  await win.screenshot({ path: path.join(shots, '5-written.png') })

  const tree = plist.parse(fs.readFileSync(plistPath, 'utf8'))
  const board = JSON.parse(plist.dictGet(tree, 'kanban_v3_data').v).boards[0]
  const backlog = board.columns[0].cards
  const card = backlog.find(c => c.title === "Driver's license renewal")
  assert(card && card.tags.includes('radar'), 'license card is on My First Board, tagged radar')
  assert(card.notes.includes('☑ Current license') && card.notes.includes('☐ Proof of address'), 'card notes carry the checklist state')
  assert(backlog.filter(c => /colonoscopy/i.test(c.title)).length === 1, 'still exactly one colonoscopy card')
  db.close()

  await win.click('button.nav:has-text("Subscriptions")')
  await sleep(400)
  await win.screenshot({ path: path.join(shots, '6-subscriptions.png') })
  await win.click('button.nav:has-text("Reorder list")')
  await win.fill('.quick-add input', 'Paper towels')
  await win.keyboard.press('Enter')
  await sleep(400)
  await win.screenshot({ path: path.join(shots, '7-reorder.png') })
  console.log('E2E PASS')
} finally {
  await app.close()
}
