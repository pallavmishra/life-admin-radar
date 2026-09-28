'use strict'
/**
 * Is Kanban Board running? FAIL CLOSED: if the check itself errors, the
 * answer is "yes, running" — a missed push is recoverable, a board written
 * under a live app is not.
 */
const { execFileSync } = require('child_process')

const BUNDLE_ID = 'app.pallavmishra.KanbanBoard'

function isKanbanRunning({ exec = execFileSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') return true
  try {
    // Asking System Events-free AppleScript "is running" never launches the app.
    const out = exec('/usr/bin/osascript', ['-e', `application id "${BUNDLE_ID}" is running`], { timeout: 5000 }).toString().trim()
    if (out === 'true') return true
    if (out !== 'false') return true
  } catch (_) {
    return true
  }
  try {
    // Belt and braces: a process whose bundle path matches, even if
    // LaunchServices has not caught up yet.
    exec('/usr/bin/pgrep', ['-f', 'KanbanBoard.app/Contents/MacOS|Kanban Board.app/Contents/MacOS'], { timeout: 5000 })
    return true // pgrep exit 0 → found
  } catch (e) {
    return !(e && e.status === 1) // exit 1 = no match; anything else = unknown → running
  }
}

module.exports = { isKanbanRunning, BUNDLE_ID }
