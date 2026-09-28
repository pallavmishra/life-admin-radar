'use strict'
/**
 * Builds a Kanban preferences plist shaped like a Swift/Codable app would
 * write it: UUID-uppercase ids, dates as seconds since 2001, the whole board
 * JSON in a <string> under kanban_v3_data, plus unrelated keys the radar
 * must leave untouched. The three dateless cards from the brief are here.
 */
const plist = require('../../src/main/kanban/plistXml')

const U = (n) => `0000000${n}-AAAA-4BBB-8CCC-DDDDDDDDDDDD`.slice(-36).toUpperCase()

function board() {
  const card = (n, title, extra = {}) => ({
    id: U(n), title, notes: '', priority: 'medium', tags: [], color: 'blue',
    checklist: [], createdAt: 812345678.25, isCompleted: false, ...extra,
  })
  return {
    version: 3,
    selectedBoardID: U(900),
    boards: [
      {
        id: U(900), name: 'My First Board', createdAt: 800000000.5,
        columns: [
          { id: U(901), title: 'Backlog', cards: [
            card(1, 'Colonoscopy Appointment'),
            card(2, 'Prostate Appointment', { priority: 'high' }),
            card(3, 'Visa Renewal', { tags: ['admin'] }),
            card(4, 'Buy printer ink', { checklist: [{ id: U(40), text: 'black', done: false }] }),
          ] },
          { id: U(902), title: 'In Progress', cards: [card(5, 'Taxes', { priority: 'low', dueDate: 812999999 })] },
          { id: U(903), title: 'Done', cards: [card(6, 'Car wash', { isCompleted: true })] },
        ],
      },
      {
        id: U(910), name: 'Work', createdAt: 800000001,
        columns: [{ id: U(911), title: 'Backlog', cards: [card(7, 'Colonoscopy slides')] }],
      },
    ],
  }
}

function plistXml(root = board(), { encoding = 'string' } = {}) {
  const json = JSON.stringify(root)
  const tree = { t: 'dict', entries: [
    ['NSWindow Frame main', { t: 'string', v: '100 100 1200 800 0 0 1728 1079 ' }],
    ['kanban_v3_data', encoding === 'string' ? { t: 'string', v: json } : { t: 'data', v: Buffer.from(json).toString('base64') }],
    ['launchCount', { t: 'integer', v: '42' }],
    ['lastOpened', { t: 'date', v: '2026-09-27T12:00:00Z' }],
    ['showCompleted', { t: 'true' }],
    ['zoom', { t: 'real', v: '1.1000000000000001' }],
  ] }
  return plist.serialize(tree)
}

module.exports = { board, plistXml, U }
