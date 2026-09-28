#!/usr/bin/env node
'use strict'
/**
 * Runs every test/headless/*.headless.js as its own process under the REAL
 * Electron runtime (ELECTRON_RUN_AS_NODE) — the same binary and native
 * better-sqlite3 the app ships with — Vitals' headless pattern.
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const ELECTRON_BIN = require('electron') // the real binary path, not the cli.js wrapper

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.headless.js')).sort()
let failed = 0
for (const f of files) {
  console.log(`\n=== ${f} ===`)
  const r = spawnSync(ELECTRON_BIN, [path.join(__dirname, f)], {
    stdio: 'inherit', timeout: 120000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  if (r.status !== 0) { failed++; console.log(`✗ ${f} (exit ${r.status}${r.signal ? `, ${r.signal}` : ''})`) }
}
console.log(`\n${files.length - failed}/${files.length} headless files passed`)
process.exit(failed ? 1 : 0)
