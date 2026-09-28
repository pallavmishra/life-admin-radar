'use strict'
/**
 * DEFINITION OF DONE: seed the DB with the §5 items, advance the clock past
 * a reminder threshold, assert exactly one notification fires per reminder,
 * and no duplicates on re-run — where "re-run" is a brand-new PROCESS
 * opening the same database file, like relaunching the app.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const phase = process.argv[2]
const dbFile = process.argv[3]

function run(phaseName, file, day) {
  const r = spawnSync(process.execPath, [__filename, phaseName, file, day], { env: process.env, encoding: 'utf8' })
  if (r.status !== 0) { process.stderr.write(r.stdout + r.stderr); throw new Error(`${phaseName} failed`) }
  return JSON.parse(r.stdout.trim().split('\n').pop())
}

if (phase) {
  // ── child: one "app launch" at a given day ──
  const { openDatabase } = require('../../src/main/db')
  const { createEngine } = require('../../src/main/engine')
  const { seedItems } = require('../../src/main/seed')
  const { localDayKey } = require('../../src/shared/dates')
  const [y, m, d] = process.argv[4].split('-').map(Number)
  const now = new Date(y, m - 1, d, 9, 0, 0)
  const clock = { now, today: localDayKey(now), nowIso: now.toISOString(), hour: 9 }
  const store = openDatabase(dbFile)
  const shown = []
  const engine = createEngine({ store, notifier: { show: (n) => shown.push(n) } })
  store.seedIfNeeded(seedItems(), clock)
  const t1 = engine.tick(clock)
  const t2 = engine.tick(clock) // a second tick in the same launch
  store.close()
  console.log(JSON.stringify({ first: t1.notifications, second: t2.notifications, shown: shown.length }))
  process.exit(0)
}

// ── parent ──
let pass = 0, fail = 0
const check = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-headless-'))
const file = path.join(tmp, 'radar.db')
try {
  console.log(`  runtime: electron ${process.versions.electron}, node ${process.versions.node}`)

  // Launch 1 — first run, 2026-09-28: seed; the I-94 180-day threshold
  // (2026-09-15) is already behind us → exactly one reminder.
  let r = run('launch', file, '2026-09-28')
  check(r.first.length === 1 && r.first[0].title === 'H-1B: I-94 expires — due in 167 days', `first run fires the I-94 180-day reminder once (${r.first.map(n => n.title)})`)
  check(r.second.length === 0, 'second tick in the same process fires nothing')

  // Relaunch same day → nothing.
  r = run('launch', file, '2026-09-28')
  check(r.first.length === 0 && r.shown === 0, 're-run in a new process fires nothing')

  // Advance the clock past the 90-day threshold (2026-12-14).
  r = run('launch', file, '2026-12-15')
  const titles = r.first.map(n => n.title)
  check(titles.includes('H-1B: I-94 expires — due in 89 days'), 'advancing past the 90-day threshold fires it')
  check(titles.filter(t => t.startsWith('H-1B')).length === 1, 'exactly one I-94 notification')
  r = run('launch', file, '2026-12-15')
  check(r.first.length === 0, 're-run after the advance fires nothing')

  // Jump past everything: the claims' check-status day (2027-03-25) and
  // the I-94's 30- and 7-day thresholds, in one leap. No burst for I-94.
  r = run('launch', file, '2027-03-25')
  const t = r.first.map(n => n.title)
  check(t.filter(x => x.startsWith('H-1B')).length === 1, 'I-94: 30- and 7-day thresholds crossed together → one notification, not two')
  check(t.some(x => x.startsWith('NJ unclaimed')) && t.some(x => x.startsWith('MA unclaimed')), 'both unclaimed-property claims remind on 2027-03-25')
  check(!t.some(x => /Spotify|YouTube|AppleCare|NYT|Prime/.test(x)), 'dateless subscriptions never fire and never error')
  r = run('launch', file, '2027-03-25')
  check(r.first.length === 0, 're-run fires nothing')

  // The log: one row per reminder id.
  const Database = require('better-sqlite3')
  const db = new Database(file, { readonly: true })
  const rows = db.prepare(`SELECT ref_id, COUNT(*) n FROM notification_log WHERE kind = 'reminder' GROUP BY ref_id`).all()
  check(rows.every(x => x.n === 1), `notification log: ${rows.length} reminders, each logged exactly once`)
  db.close()
} catch (e) {
  fail++; console.log('  ✗', e.message)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
