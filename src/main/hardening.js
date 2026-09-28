'use strict'
/**
 * Renderer hardening, ported from Vitals (main.js, PLATFORM_ROADMAP Phase 83):
 * the renderer is pinned to its own origin, can never open a second window
 * that inherits the preload, and runs under a strict CSP.
 */
const path = require('path')

/**
 * Is this URL the app's own document? Compared on the PARSED url, never
 * with startsWith on the raw string (`file:///…/dist/renderer/../../..` and
 * `dist/renderer-evil` are both near-misses a prefix check lets through).
 */
function isOwnOrigin(rawUrl, { isDev, devOrigin, rendererRoot }) {
  let u
  try { u = new URL(rawUrl) } catch (_) { return false }
  if (isDev) {
    const dev = new URL(devOrigin)
    return u.protocol === dev.protocol && u.host === dev.host
  }
  if (u.protocol !== 'file:') return false
  let target
  try { target = path.resolve(decodeURIComponent(u.pathname)) } catch (_) { return false }
  const rel = path.relative(rendererRoot, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function safeProtocol(rawUrl) {
  try { return new URL(rawUrl).protocol } catch (_) { return '' }
}

function hardenRendererNavigation(webContents, opts) {
  // window.open never creates a BrowserWindow (it would inherit the
  // preload). https links go to the real browser.
  webContents.setWindowOpenHandler(({ url }) => {
    if (safeProtocol(url) === 'https:') opts.shell.openExternal(url)
    return { action: 'deny' }
  })
  // Both will-navigate AND will-redirect: a 302 does not always fire the first.
  const block = (e, url) => {
    if (isOwnOrigin(url, opts)) return
    e.preventDefault()
    console.warn('[harden] blocked navigation to', url)
  }
  webContents.on('will-navigate', block)
  webContents.on('will-redirect', block)
  webContents.on('will-attach-webview', (e, webPreferences) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    e.preventDefault()
  })
}

/**
 * Strict CSP. Production is file:// with no network origin at all:
 * connect-src 'self' and no remote anything. Dev adds only what Vite's HMR
 * needs.
 */
function buildCsp({ isDev, devOrigin }) {
  const ws = devOrigin.replace(/^http/, 'ws')
  return [
    "default-src 'self'",
    "script-src 'self'" + (isDev ? " 'unsafe-inline' 'unsafe-eval'" : ''),
    "style-src 'self'" + (isDev ? " 'unsafe-inline'" : ''),
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'" + (isDev ? ` ${devOrigin} ${ws}` : ''),
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ')
}

module.exports = { isOwnOrigin, hardenRendererNavigation, buildCsp }
