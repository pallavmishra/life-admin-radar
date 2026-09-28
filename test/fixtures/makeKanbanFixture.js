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

/**
 * Shaped like the REAL board's dry run (2026-09-28): lists/tasks, a
 * `listId` back-reference on every card, per-card `storyId` sequence,
 * `itemType` Story/Epic, priorities None/Critical/Medium/High, stored as <data>.
 * Values are made up; only the shape is copied.
 */
function realShapeBoard() {
  const L = { backlog: U(801), todo: U(802), prog: U(803), done: U(804) }
  let n = 0
  const task = (list, title, extra = {}) => ({
    createdAt: 811046546.25, listId: L[list], itemType: 'Story', definitionOfDone: '',
    storyId: `MFB-S-${String(++n).padStart(3, '0')}`, linkedStoryIds: [], assigneeIds: [],
    title, tags: [], updatedAt: 812000000.5, priority: 'Medium', id: U(700 + n), notes: '', attachments: [], ...extra,
  })
  return {
    boards: [{
      id: U(800), name: 'My First Board', nextStoryNumber: 36,
      lists: [
        { id: L.backlog, title: 'Backlog', tasks: [
          task('backlog', 'Visa Renewal', { itemType: 'Epic', storyId: 'MFB-E-005', priority: 'Critical', notes: 'Talk to HR' }),
          task('backlog', 'Home Improvement', { definitionOfDone: 'Quotes from three contractors', priority: 'None', parentEpicId: U(701) }),
          task('backlog', 'Book Club Readings', { deadline: 826732800, parentEpicId: U(701) }),
        ] },
        { id: L.todo, title: 'To Do', tasks: [
          task('todo', 'Colonoscopy Appointment', { tags: ['Health'] }),
          task('todo', 'Prostate Appointment', { tags: ['Health'] }),
        ] },
        { id: L.prog, title: 'In Progress', tasks: [task('prog', 'MDAA Slide Deck', { priority: 'High' })] },
        { id: L.done, title: 'Done', tasks: [task('done', 'Clean Kitchen')] },
      ],
    }],
  }
}

module.exports.realShapeBoard = realShapeBoard
