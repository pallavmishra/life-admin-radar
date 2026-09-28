import { describe, it, expect } from 'vitest'
import planMod from '../src/main/kanban/plan.js'
import fx from './fixtures/makeKanbanFixture.js'

const now = new Date(2026, 8, 28, 9, 0, 0)
const item = (id, title, due_date = null) => ({ id, title, due_date, kind: 'dated', status: 'upcoming' })
const plan = (root, requests) => planPush(root, { requests, boardName: 'My First Board', now })
const { planPush } = planMod
const lists = (root) => root.boards[0].lists

describe('real board shape (lists/tasks, listId, storyId)', () => {
  it('detects the list back-reference and the story sequence', () => {
    const p = plan(fx.realShapeBoard(), [])
    expect(p.shape.layout).toMatchObject({ listsKey: 'lists', cardsKey: 'tasks' })
    expect(p.shape.parentRefKey).toBe('listId')
    expect(p.shape.fieldProfile.storyId).toBe('sequence')
    expect(p.shape.boardFields).toMatchObject({ nextStoryNumber: 36 })
  })

  it('linking keeps the user\'s own priority', () => {
    const p = plan(fx.realShapeBoard(), [{ item: item(1, 'H-1B: I-94 expires', '2027-03-14'), op: 'upsert', checklist: [], link: null, priority: 'low' }])
    expect(p.results[0]).toMatchObject({ action: 'link', cardTitle: 'Visa Renewal' })
    expect(p.results[0].after.priority).toBe('Critical')
    expect(p.results[0].after.notes).toMatch(/^Talk to HR\n\n--- Radar checklist ---/)
  })

  it('a new card: typical Story template, next story number, own listId, fresh free text, board vocabulary priority', () => {
    const p = plan(fx.realShapeBoard(), [{ item: item(9, "Driver's license renewal", '2026-11-20'), op: 'upsert', checklist: [], link: null, priority: 'low' }])
    expect(p.ok).toBe(true)
    const c = p.results[0].after
    expect(p.results[0]).toMatchObject({ action: 'create', list: 'Backlog' })
    expect(c.itemType).toBe('Story')                       // not cloned from the Epic
    expect(c.storyId).toBe('MFB-S-008')                    // highest MFB-S is 007 → 008, never a duplicate
    expect(c.listId).toBe(lists(p.newRoot)[0].id)
    expect(c.definitionOfDone).toBe('')                    // template's free text not copied
    expect(c.priority).toBe('None')                        // board has no "Low"
    expect(c.linkedStoryIds).toEqual([])
    const ids = lists(p.newRoot).flatMap(l => l.tasks.map(t => t.storyId))
    expect(new Set(ids).size).toBe(ids.length)
    expect(p.issues.map(i => i.code)).toContain('sequence-numbering')
    expect(p.issues.find(i => i.code === 'sequence-numbering').message).toMatch(/nextStoryNumber=36/)
  })

  it('move to Done updates listId with the card', () => {
    const root = fx.realShapeBoard()
    const colo = lists(root)[1].tasks[0]
    const p = plan(root, [{ item: item(1, 'Colonoscopy'), op: 'complete', checklist: [], link: { card_id: colo.id } }])
    expect(p.ok).toBe(true)
    const moved = lists(p.newRoot)[3].tasks.at(-1)
    expect(moved.id).toBe(colo.id)
    expect(moved.listId).toBe(lists(p.newRoot)[3].id)
    for (const l of lists(p.newRoot)) for (const t of l.tasks) expect(t.listId).toBe(l.id)
  })
})
