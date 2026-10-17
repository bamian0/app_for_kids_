import { describe, expect, it } from 'vitest'
import type { Task } from '../domain/types.ts'
import { decodeTasks, encodeTask, oneLine } from './tasks.ts'

const toMs = (v: unknown) => (typeof v === 'number' ? v : null)

describe('decodeTasks', () => {
  it('reads plans from before steps exactly as before', () => {
    const tasks = decodeTasks([{ id: 't1', title: 'Edit the reel' }, { id: 't2', title: '' }, { title: 'No id' }, 'junk', null], undefined, toMs)
    expect(tasks).toStrictEqual([
      { id: 't1', title: 'Edit the reel' },
      { id: 't2', title: '' },
    ])
    expect(decodeTasks(undefined, undefined, toMs)).toEqual([])
    expect(decodeTasks({ 0: { id: 'a', title: 'A' } }, undefined, toMs)).toEqual([])
  })

  it('splits steps on the first bar and trims them', () => {
    const [task] = decodeTasks([{ id: 't1', title: 'Shoot', subs: ['s1|Scout the place', ' s2 |  Rent a lens ', 's3|A|B|C'] }], undefined, toMs)
    expect(task.subtasks).toEqual([
      { id: 's1', title: 'Scout the place' },
      { id: 's2', title: 'Rent a lens' },
      { id: 's3', title: 'A|B|C' },
    ])
  })

  it('skips malformed, untitled and duplicate steps', () => {
    const [a, b] = decodeTasks(
      [
        { id: 'a', title: 'A', subs: ['no bar', '|no id', 'bad id!|x', 's1|   ', 's1|First', 's1|Again', 'a|Clashes with a task', 'b|Clashes too', 7] },
        { id: 'b', title: 'B', subs: ['s1|Taken by a', 's2|Fine'] },
      ],
      undefined,
      toMs,
    )
    expect(a.subtasks).toEqual([{ id: 's1', title: 'First' }])
    expect(b.subtasks).toEqual([{ id: 's2', title: 'Fine' }])
  })

  it('omits subtasks when no step is usable, and stops at 8', () => {
    const [none, many] = decodeTasks(
      [
        { id: 'a', title: 'A', subs: [] },
        { id: 'b', title: 'B', subs: Array.from({ length: 10 }, (_, i) => `s${i}|Step ${i}`) },
      ],
      undefined,
      toMs,
    )
    expect(none).toStrictEqual({ id: 'a', title: 'A' })
    expect(many.subtasks?.map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'])
  })

  it('keeps only the first task with an id, and no add time for an id that repeats', () => {
    // t1 was on the list at the lock; a crafted append repeated its id with an add time.
    const tasks = decodeTasks(
      [{ id: 't0', title: 'Finish the edit' }, { id: 't1', title: 'Call the client' }, { id: 't1', title: 'Call the client', subs: ['x|Copy'] }],
      { t1: 2_000 },
      toMs,
    )
    expect(tasks).toStrictEqual([
      { id: 't0', title: 'Finish the edit' },
      { id: 't1', title: 'Call the client' },
    ])
  })

  it('reads add times from the added map', () => {
    const tasks = decodeTasks([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }], { b: 1_000, c: 'not a time', z: 5 }, toMs)
    expect(tasks).toStrictEqual([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', addedAt: 1_000 },
      { id: 'c', title: 'C' },
    ])
  })
})

describe('decodeTasks with cross-outs (SPEC §10.3)', () => {
  const list = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', subs: ['b1|Step'] }, { id: 'c', title: 'C' }]

  it('reads plans without a log exactly as before', () => {
    const before = decodeTasks(list, { c: 3_000 }, toMs)
    expect(decodeTasks(list, { c: 3_000 }, toMs, undefined)).toStrictEqual(before)
    expect(decodeTasks(list, { c: 3_000 }, toMs, {})).toStrictEqual(before)
    expect(decodeTasks(list, { c: 3_000 }, toMs, 'junk')).toStrictEqual(before)
    expect(before.every((t) => !('cancel' in t))).toBe(true)
  })

  it('gives each task its current state; others stay plain', () => {
    const tasks = decodeTasks(
      list,
      { c: 3_000 },
      toMs,
      {
        '1:a': { at: 1_000, why: 'Pool closed' },
        '1:c': { at: 4_000, why: 'Sick' },
        '2:c': { at: 5_000 },
      },
    )
    expect(tasks).toStrictEqual([
      { id: 'a', title: 'A', cancel: { cancelled: true, changes: 1, at: 1_000, why: 'Pool closed' } },
      { id: 'b', title: 'B', subtasks: [{ id: 'b1', title: 'Step' }] },
      { id: 'c', title: 'C', addedAt: 3_000, cancel: { cancelled: false, changes: 2, at: 5_000, why: 'Sick' } },
    ])
  })

  it('ignores entries for ids that aren’t on the list, and malformed ones', () => {
    const tasks = decodeTasks(list, undefined, toMs, {
      '1:zz': { at: 1_000, why: 'Not on the list' },
      '1:b': { at: 'not a time', why: 'Bad time' },
      '2:a': { at: 2_000 },
      'x:c': { at: 1_000, why: 'Bad key' },
    })
    expect(tasks).toStrictEqual(decodeTasks(list, undefined, toMs))
  })

  it('a repeated id: the first task (the one kept) carries the cross-out', () => {
    const tasks = decodeTasks([{ id: 't1', title: 'Call the client' }, { id: 't1', title: 'Copy' }], { t1: 2_000 }, toMs, {
      '1:t1': { at: 3_000, why: 'They’re away' },
    })
    expect(tasks).toStrictEqual([{ id: 't1', title: 'Call the client', cancel: { cancelled: true, changes: 1, at: 3_000, why: 'They’re away' } }])
  })
})

describe('encodeTask', () => {
  it('stores steps as id|title lines and never the add time', () => {
    const task: Task = { id: 't1', title: 'Client work', subtasks: [{ id: 's1', title: 'Send the\ninvoice ' }], addedAt: 5 }
    expect(encodeTask(task)).toStrictEqual({ id: 't1', title: 'Client work', subs: ['s1|Send the invoice'] })
    expect(encodeTask({ id: 't2', title: 'Plain', subtasks: [] })).toStrictEqual({ id: 't2', title: 'Plain' })
  })

  it('round-trips', () => {
    const tasks: Task[] = [
      { id: 't1', title: 'Edit' },
      { id: 't2', title: 'Shoot', subtasks: [{ id: 's1', title: 'Scout' }, { id: 's2', title: 'Pack | go' }] },
    ]
    expect(decodeTasks(tasks.map(encodeTask), {}, toMs)).toStrictEqual(tasks)
  })
})

describe('oneLine', () => {
  it('joins lines with a space and trims', () => {
    expect(oneLine('  a \r\n\n b c  ')).toBe('a b c')
  })
})
