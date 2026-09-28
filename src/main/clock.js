'use strict'
/**
 * The one place the app reads the wall clock. RADAR_FAKE_NOW (an ISO
 * timestamp) pins it — used by the headless tests and handy for trying a
 * date in the app ("what will the radar say on March 1st?").
 */
const { localDayKey } = require('../shared/dates')

function makeClock(nowFn = () => (process.env.RADAR_FAKE_NOW ? new Date(process.env.RADAR_FAKE_NOW) : new Date())) {
  return () => {
    const now = nowFn()
    return { now, today: localDayKey(now), nowIso: now.toISOString(), hour: now.getHours() }
  }
}

module.exports = { makeClock }
