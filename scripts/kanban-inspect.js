#!/usr/bin/env node
'use strict'
/**
 * READ-ONLY diagnostics for "I pushed but Kanban Board shows no change".
 *   npm run kanban:inspect
 * Checks: did Radar write (backups, DB links/queue)? what the plist on disk
 * says, what macOS preferences (cfprefsd — what the app actually reads)
 * say, and whether Kanban Board keeps its data somewhere else (sandbox
 * container, group container). Prints card titles + radar fields only.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const plist = require('../src/main/kanban/plistXml')
const { DEFAULT_PATH, DOMAIN, DATA_KEY } = require('../src/main/kanban/plistFile')
const { APPLE_EPOCH_S } = require('../src/main/kanban/board')

const HOME = os.homedir()
const SUPPORT = process.env.RADAR_USER_DATA || path.join(HOME, 'Library', 'Application Support', 'Life-Admin Radar')
const isMac = process.platform === 'darwin'
const line = (s = '') => console.log(s)
const when = (f) => { try { return fs.statSync(f).mtime.toLocaleString() } catch (_) { return null } }

function boardFromXml(xml) {
  const node = plist.dictGet(plist.parse(xml), DATA_KEY)
  if (!node) return null
  const json = node.t === 'string' ? node.v : Buffer.from(String(node.v).replace(/\s+/g, ''), 'base64').toString('utf8')
  return JSON.parse(json)
}
function xmlOfFile(f) {
  const buf = fs.readFileSync(f)
  if (buf.slice(0, 8).toString('latin1') !== 'bplist00') return buf.toString('utf8')
  return execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', f]).toString('utf8')
}
function summarize(label, root) {
  if (!root) { line(`  ${label}: no ${DATA_KEY} key`); return }
  const cards = []
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      if (typeof v.title === 'string' && ('tags' in v || 'notes' in v)) cards.push(v)
      Object.values(v).forEach(walk)
    }
  }
  walk(root)
  const radar = cards.filter(c => Array.isArray(c.tags) && c.tags.includes('radar'))
  line(`  ${label}: ${cards.length} cards, ${radar.length} tagged radar`)
  for (const c of radar) {
    const due = typeof c.deadline === 'number' ? new Date((c.deadline + APPLE_EPOCH_S) * 1000).toDateString() : 'none'
    line(`     • ${c.title} — deadline ${due}, checklist in notes: ${String(c.notes || '').includes('Radar checklist') ? 'yes' : 'no'}`)
  }
  const visa = cards.find(c => c.title === 'Visa Renewal')
  if (visa && !radar.includes(visa)) line(`     • Visa Renewal is there but NOT tagged radar (tags: ${JSON.stringify(visa.tags)})`)
}

line('1) Did Radar write?')
const backups = path.join(SUPPORT, 'kanban-backups')
const bl = fs.existsSync(backups) ? fs.readdirSync(backups).filter(f => f.endsWith('.plist')).sort() : []
line(bl.length ? `  yes — ${bl.length} backup(s) in ${backups}, latest ${bl.at(-1)}` : `  no backups in ${backups} → no live write has completed`)
const dbFile = path.join(SUPPORT, 'radar.db')
if (fs.existsSync(dbFile)) {
  try {
    const Database = require('better-sqlite3')
    const db = new Database(dbFile, { readonly: true, fileMustExist: true })
    const s = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]))
    line(`  Radar DB: live pushes = ${s.kanbanLiveWrites || 0}, plist path setting = ${s.kanbanPlistPath || '(default)'}`)
    for (const l of db.prepare(`SELECT i.title, l.linked_how FROM kanban_links l JOIN life_items i ON i.id = l.item_id`).all()) line(`     linked: ${l.title} (${l.linked_how})`)
    for (const q of db.prepare(`SELECT i.title, q.op, q.status, q.error FROM kanban_queue q JOIN life_items i ON i.id = q.item_id ORDER BY q.id DESC LIMIT 8`).all()) line(`     queue: ${q.title} ${q.op} ${q.status}${q.error ? ' — ' + q.error : ''}`)
    db.close()
  } catch (e) { line(`  (could not read Radar DB: ${e.message})`) }
} else line(`  no Radar database at ${dbFile}`)

line('\n2) The preferences file on disk')
line(`  ${DEFAULT_PATH} — modified ${when(DEFAULT_PATH) || 'MISSING'}`)
try { summarize('on disk', boardFromXml(xmlOfFile(DEFAULT_PATH))) } catch (e) { line(`  could not read: ${e.message}`) }

line('\n3) What macOS preferences serve to Kanban Board (cfprefsd)')
if (isMac) {
  try { summarize('cfprefsd', boardFromXml(execFileSync('/usr/bin/defaults', ['export', DOMAIN, '-'], { maxBuffer: 256 << 20 }).toString('utf8'))) } catch (e) { line(`  could not export: ${e.message}`) }
} else line('  (macOS only)')

line('\n4) Other places Kanban Board could keep its board')
const others = [
  path.join(HOME, 'Library', 'Containers', DOMAIN, 'Data', 'Library', 'Preferences', `${DOMAIN}.plist`),
]
const gc = path.join(HOME, 'Library', 'Group Containers')
if (fs.existsSync(gc)) for (const d of fs.readdirSync(gc)) if (/kanban/i.test(d)) others.push(path.join(gc, d))
const cont = path.join(HOME, 'Library', 'Containers')
if (fs.existsSync(cont)) { try { for (const d of fs.readdirSync(cont)) if (/kanban/i.test(d)) others.push(path.join(cont, d)) } catch (_) { line('  (no permission to list ~/Library/Containers — give Terminal Full Disk Access to check)') } }
let found = 0
for (const o of [...new Set(others)]) {
  if (!fs.existsSync(o)) continue
  found++
  line(`  FOUND ${o} — modified ${when(o)}`)
  if (o.endsWith('.plist')) { try { summarize('   container copy', boardFromXml(xmlOfFile(o))) } catch (e) { line(`    could not read: ${e.message}`) } }
}
if (!found) line('  none found')
let running = 'unknown'
if (isMac) { try { running = execFileSync('/usr/bin/osascript', ['-e', `application id "${DOMAIN}" is running`]).toString().trim() } catch (_) {} }
line(`\nKanban Board running right now: ${running}`)
