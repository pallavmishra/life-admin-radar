'use strict'
/**
 * Reading and writing the Kanban preferences plist.
 *
 * ⚠️ WRITE RULES (from the brief — this file has destroyed the board before):
 *   1. Never while Kanban Board is running — the caller (sync.js) checks
 *      immediately before calling writeAtomic, and writeAtomic checks AGAIN
 *      between building the temp file and the swap.
 *   2. Never in chunks — the complete new plist is built in memory, written
 *      to a temp file in the SAME directory (so rename is atomic on the same
 *      volume), fsynced, validated, and only then renamed over the original.
 *   3. Never blind — the original's SHA-256 is re-checked right before the
 *      swap; if the file changed since the plan was made, nothing is written.
 *
 * macOS writes preferences as BINARY plists. `plutil` (always present on
 * macOS) converts to XML for reading and back to binary for writing, so the
 * file keeps its original format.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const plist = require('./plistXml')

const DATA_KEY = 'kanban_v3_data'
const DOMAIN = 'app.pallavmishra.KanbanBoard'
const DEFAULT_PATH = path.join(os.homedir(), 'Library', 'Preferences', 'app.pallavmishra.KanbanBoard.plist')

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const PLUTIL = '/usr/bin/plutil'

function defaultConverter() {
  return {
    toXml(file) { return execFileSync(PLUTIL, ['-convert', 'xml1', '-o', '-', file], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8') },
    toBinaryInPlace(file) { execFileSync(PLUTIL, ['-convert', 'binary1', file]) },
    lint(file) { execFileSync(PLUTIL, ['-lint', '-s', file]) },
    // ⚠️ cfprefsd caches preference domains in memory and does not watch
    // the files. After the atomic swap, `defaults import` of the very file
    // we just wrote makes cfprefsd's cache match the disk — otherwise the
    // next launch of Kanban Board could be served the OLD board from cache
    // and write it back over the radar's cards. Then `defaults export`
    // reads the board back through cfprefsd — the same path Kanban Board
    // reads it — so the push is verified end to end.
    syncPrefsCache(file) { execFileSync('/usr/bin/defaults', ['import', DOMAIN, file]) },
    exportDomainXml() { return execFileSync('/usr/bin/defaults', ['export', DOMAIN, '-'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8') },
  }
}

/**
 * @returns {{ path, bytes, hash, format: 'binary'|'xml', tree, encoding: 'string'|'data', json: string, root: object }}
 */
function readKanbanFile(file, { converter = defaultConverter() } = {}) {
  const bytes = fs.readFileSync(file)
  const format = bytes.slice(0, 8).toString('latin1') === 'bplist00' ? 'binary' : 'xml'
  const xml = format === 'binary' ? converter.toXml(file) : bytes.toString('utf8')
  const tree = plist.parse(xml)
  if (tree.t !== 'dict') throw new Error('Kanban preferences are not a dictionary')
  const node = plist.dictGet(tree, DATA_KEY)
  if (!node) throw new Error(`"${DATA_KEY}" is not in ${path.basename(file)} — has Kanban Board saved a board yet?`)
  let json, encoding
  if (node.t === 'string') { json = node.v; encoding = 'string' }
  else if (node.t === 'data') { json = Buffer.from(node.v.replace(/\s+/g, ''), 'base64').toString('utf8'); encoding = 'data' }
  else throw new Error(`"${DATA_KEY}" is a <${node.t}>, expected JSON text`)
  let root
  try { root = JSON.parse(json) } catch (e) { throw new Error(`"${DATA_KEY}" is not valid JSON: ${e.message}`) }
  return { path: file, bytes, hash: sha256(bytes), format, tree, encoding, json, root }
}

/** Build the complete new plist (XML text) — every other key untouched. */
function buildNewPlist(info, newRoot) {
  const json = JSON.stringify(newRoot)
  const node = info.encoding === 'string'
    ? { t: 'string', v: json }
    : { t: 'data', v: Buffer.from(json, 'utf8').toString('base64') }
  const tree = plist.dictSet(info.tree, DATA_KEY, node)
  // Self-check: the new tree differs from the old in exactly one key.
  const changed = tree.entries.filter(([k, v], i) => info.tree.entries[i] === undefined || !plist.equal(v, info.tree.entries[i][1]))
  if (tree.entries.length !== info.tree.entries.length || changed.some(([k]) => k !== DATA_KEY)) {
    throw new Error('Refusing to write: keys other than the board would change')
  }
  return { xml: plist.serialize(tree), json }
}

/**
 * Atomic replace. `isKanbanRunning` is called once more after the temp file
 * is ready — the last possible moment before the swap.
 */
function writeAtomic(info, xml, { converter = defaultConverter(), isKanbanRunning, backupDir }) {
  const file = info.path
  const dir = path.dirname(file)
  const current = fs.readFileSync(file)
  if (sha256(current) !== info.hash) throw new Error('The Kanban file changed since this push was planned — nothing was written. Run the preview again.')

  let backup = null
  if (backupDir) {
    fs.mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backup = path.join(backupDir, `KanbanBoard-${stamp}.plist`)
    fs.writeFileSync(backup, current, { flag: 'wx' })
  }

  const tmp = path.join(dir, `.${path.basename(file)}.radar-${process.pid}-${Date.now()}.tmp`)
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try { fs.writeSync(fd, xml); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    if (info.format === 'binary') converter.toBinaryInPlace(tmp)
    if (converter.lint) converter.lint(tmp)
    // Read the temp file back through the same reader: it must parse and
    // must contain exactly the JSON we meant to write.
    const check = readKanbanFile(tmp, { converter })
    if (check.json !== buildCheckJson(xml)) throw new Error('The temporary file did not read back identically')
    try { fs.chmodSync(tmp, fs.statSync(file).mode & 0o777) } catch (_) {}

    if (isKanbanRunning && isKanbanRunning()) throw new Error('Kanban Board started while the push was being prepared — nothing was written.')
    fs.renameSync(tmp, file)
    try { const dfd = fs.openSync(dir, 'r'); fs.fsyncSync(dfd); fs.closeSync(dfd) } catch (_) {}
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch (_) {}
    throw e
  }
  const expected = buildCheckJson(xml)
  let verifiedVia = 'file'
  // Only for the REAL preferences file — importing a scratch copy into the
  // live domain would overwrite the real board with the copy.
  if (converter.syncPrefsCache && path.resolve(file) === DEFAULT_PATH) {
    converter.syncPrefsCache(file)
    const node = plist.dictGet(plist.parse(converter.exportDomainXml()), DATA_KEY)
    const got = node && (node.t === 'string' ? node.v : Buffer.from(String(node.v).replace(/\s+/g, ''), 'base64').toString('utf8'))
    if (got !== expected) {
      throw new Error('The board was written, but macOS preferences did not read it back identically.' +
        (backup ? ` The previous file is saved at ${backup}.` : ''))
    }
    verifiedVia = 'cfprefsd'
  } else {
    if (readKanbanFile(file, { converter }).json !== expected) throw new Error('The written file did not read back identically')
  }
  return { backup, hash: sha256(fs.readFileSync(file)), verifiedVia }
}

function buildCheckJson(xml) {
  const node = plist.dictGet(plist.parse(xml), DATA_KEY)
  return node.t === 'string' ? node.v : Buffer.from(node.v.replace(/\s+/g, ''), 'base64').toString('utf8')
}

module.exports = { readKanbanFile, buildNewPlist, writeAtomic, DEFAULT_PATH, DATA_KEY, DOMAIN, sha256, defaultConverter }
