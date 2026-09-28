'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { openDatabase } = require('../src/main/db')
const { createEngine } = require('../src/main/engine')
const { seedItems } = require('../src/main/seed')
const { localDayKey } = require('../src/shared/dates')

function clockAt(dayKey, hour = 9) {
  const [y, m, d] = dayKey.split('-').map(Number)
  const now = new Date(y, m - 1, d, hour, 0, 0)
  return { now, today: localDayKey(now), nowIso: now.toISOString(), hour }
}

function fakeNotifier() {
  const shown = []
  return { shown, show: (n) => shown.push(n) }
}

function tmpDir(tag = 'radar') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`))
}

function freshRadar({ seed = true, day = '2026-09-28', file = ':memory:' } = {}) {
  const store = openDatabase(file)
  const notifier = fakeNotifier()
  const engine = createEngine({ store, notifier })
  if (seed) store.seedIfNeeded(seedItems(), clockAt(day))
  return { store, engine, notifier }
}

module.exports = { clockAt, fakeNotifier, freshRadar, tmpDir }
