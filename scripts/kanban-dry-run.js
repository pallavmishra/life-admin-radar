#!/usr/bin/env node
'use strict'
/**
 * Kanban push DRY RUN from the terminal. Never writes the plist.
 *
 *   cp ~/Library/Preferences/app.pallavmishra.KanbanBoard.plist ~/Desktop/kanban-copy.plist
 *   npm run kanban:dry-run -- ~/Desktop/kanban-copy.plist [--db <radar.db>] [--date YYYY-MM-DD] [--out new.plist]
 *
 * Plans the push for the §5 seed items (or, with --db, for a COPY of your
 * real radar database) and prints every card exactly as it would be
 * written, the schema guesses, and the safety-check result. --out writes
 * the would-be plist to a NEW file for inspection — never over an existing
 * file, never to ~/Library/Preferences.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { openDatabase } = require('../src/main/db')
const { createEngine } = require('../src/main/engine')
const { createKanbanSync } = require('../src/main/kanban/sync')
const { DEFAULT_PATH } = require('../src/main/kanban/plistFile')
const { seedItems, applySeedBatches } = require('../src/main/seed')
const { localDayKey } = require('../src/shared/dates')

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const file = args.find((a, i) => !a.startsWith('--') && !['--db', '--date', '--out'].includes(args[i - 1]))
if (!file) { console.error('usage: npm run kanban:dry-run -- <copy-of-kanban.plist> [--db radar.db] [--date YYYY-MM-DD] [--out new.plist]'); process.exit(2) }
if (path.resolve(file) === DEFAULT_PATH) console.warn('⚠️  Reading the LIVE preferences file. That is safe (read-only), but a copy is recommended.\n')

const day = opt('--date') || localDayKey(new Date())
const [y, m, d] = day.split('-').map(Number)
const now = new Date(y, m - 1, d, 9, 0, 0)
const clock = { now, today: day, nowIso: now.toISOString(), hour: 9 }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-dry-'))
const dbFile = path.join(tmp, 'radar.db')
if (opt('--db')) fs.copyFileSync(opt('--db'), dbFile) // work on a copy of your DB too
const store = openDatabase(dbFile)
const engine = createEngine({ store })
if (!opt('--db')) store.seedIfNeeded(seedItems(), clock)
applySeedBatches(store, clock)
const sync = createKanbanSync({ store, engine, isRunning: () => false })
const pv = sync.preview(clock, { all: true, path: file })

console.log(`File: ${pv.file.path} (${pv.file.format || '?'} plist, board as <${pv.file.encoding || '?'}>, ${pv.file.bytes || 0} bytes)`)
console.log(`Date: ${day}\n`)
if (pv.shape) {
  console.log('Board schema as Radar reads it:')
  console.log(JSON.stringify({ ...pv.shape, cards: pv.shape.cards.map(c => c.title) }, null, 2), '\n')
}
for (const i of pv.issues) console.log(`${i.level === 'blocking' ? '⛔' : i.level === 'confirm' ? '⚠️ ' : 'ℹ️ '} ${i.message}`)
if (pv.issues.length) console.log()
for (const r of pv.results) {
  console.log(`● ${r.action.toUpperCase()}  ${r.itemTitle}${r.cardTitle && r.cardTitle !== r.itemTitle ? `  →  "${r.cardTitle}"` : ''}${r.list ? `  [${r.list}]` : ''}`)
  if (r.reason) console.log(`  ${r.reason}`)
  if (r.after) console.log(JSON.stringify(r.after, null, 2).replace(/^/gm, '    '))
}
if (pv.invariants) console.log(`\nSafety check: cards ${pv.invariants.cardsBefore} → ${pv.invariants.cardsAfter} (+${pv.invariants.created} new). ${pv.ok ? 'OK — nothing else changes.' : 'BLOCKED.'}`)

const out = opt('--out')
if (out && pv.ok && pv.planId) {
  const o = path.resolve(out)
  if (o === DEFAULT_PATH || fs.existsSync(o)) { console.error(`Refusing to write ${o}: it exists or is the live file.`); process.exit(1) }
  fs.writeFileSync(o, sync.planXml(pv.planId), { flag: 'wx' })
  console.log(`\nWould-be plist (XML) written to ${o} for inspection — the live file was not touched.`)
}
store.close()
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(pv.ok ? 0 : 1)
