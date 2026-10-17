import { describe, expect, it } from 'vitest'
import { decodeCancels, decodeMemberStakes, decodeMonthResults, decodeSchedule, decodeSpaceExtras, decodeWeekExtras, isReviewMark, type ToMs } from './decode.ts'

/** A stand-in for a Firestore Timestamp, as the data layer and the job get them. */
const ts = (ms: number) => ({ toMillis: () => ms })
const toMs: ToMs = (v) => (v !== null && typeof v === 'object' && 'toMillis' in v && typeof v.toMillis === 'function' ? (v.toMillis() as number) : null)

const T = Date.parse('2026-10-14T10:00:00Z')
const TERMS = { rewardMode: 'group', penaltyMode: 'each', reward: 'Dinner', penalty: 'A coffee', tiers: [{ months: 3, reward: 'Weekend away' }] }

/** Values a malformed or hostile doc could hold anywhere. */
const JUNK: unknown[] = [undefined, null, 0, -1, 1.5, Number.NaN, '', 'x', true, [], [1, 'a', null], {}, { a: 1 }, ts(Number.NaN), ts(-5), { toMillis: () => { throw new Error('boom') } }]

describe('decodeSchedule', () => {
  it('a schedule the rules accept, with exactly its three keys; else null (the usual times)', () => {
    expect(decodeSchedule({ lock: 1200, reviewOpen: 5760, deadline: 7920, extra: 1 })).toEqual({ lock: 1200, reviewOpen: 5760, deadline: 7920 })
    expect(decodeSchedule({ lock: 5760, reviewOpen: 5760, deadline: 7200 })).toBeNull()
    expect(decodeSchedule({ lock: 1440, reviewOpen: 5760, deadline: 10081 })).toBeNull()
    expect(decodeSchedule({ lock: '1440', reviewOpen: 5760, deadline: 7200 })).toBeNull()
    for (const v of JUNK) expect(decodeSchedule(v)).toBeNull()
  })
})

describe('decodeSpaceExtras', () => {
  const good = {
    name: 'Film Club',
    schedule: { lock: 1200, reviewOpen: 5760, deadline: 7920 },
    scheduleNote: { by: 'lena', at: ts(T), fromWeek: '2026-10-19', before: { lock: 1440, reviewOpen: 5760, deadline: 7200 } },
    pause: { weekId: '2026-10-19', by: 'sam', at: ts(T + 1), oks: ['sam', 'lena', 'sam', 7], declinedBy: 'ben' },
    paused: { '2026-09': '2026-09-14', '2026-13': '2026-12-28', '2026-11': 'soon' },
    judges: ['ana', 'ana', '', 3],
    stakesNote: { by: 'lena', at: ts(T + 2) },
    formerJoinedAt: { ben: ts(T - 5), kim: 'yesterday', lee: ts(-1) },
  }

  it('every valid batch-2 field', () => {
    expect(decodeSpaceExtras(good, toMs)).toEqual({
      schedule: { lock: 1200, reviewOpen: 5760, deadline: 7920 },
      scheduleNote: { by: 'lena', at: T, fromWeek: '2026-10-19', before: { lock: 1440, reviewOpen: 5760, deadline: 7200 } },
      pause: { weekId: '2026-10-19', by: 'sam', at: T + 1, oks: ['sam', 'lena'], declinedBy: 'ben' },
      paused: { '2026-09': '2026-09-14' },
      judges: ['ana'],
      stakesNote: { by: 'lena', at: T + 2 },
      formerJoinedAt: { ben: T - 5 },
    })
  })

  it('a space from before batch 2 has none of them', () => {
    expect(decodeSpaceExtras({ name: 'Film Club', reward: 'x', penalty: 'y' }, toMs)).toEqual({})
    expect(decodeSpaceExtras(undefined, toMs)).toEqual({})
  })

  it('each malformed field is left out, never thrown', () => {
    expect(decodeSpaceExtras({ ...good, schedule: { lock: 1, reviewOpen: 2, deadline: 3 } }, toMs).schedule).toBeUndefined()
    expect(decodeSpaceExtras({ ...good, scheduleNote: { ...good.scheduleNote, at: null } }, toMs).scheduleNote).toBeUndefined()
    expect(decodeSpaceExtras({ ...good, scheduleNote: { ...good.scheduleNote, fromWeek: '2026-10' } }, toMs).scheduleNote).toBeUndefined()
    expect(decodeSpaceExtras({ ...good, scheduleNote: { ...good.scheduleNote, before: null } }, toMs).scheduleNote).toBeUndefined()
    expect(decodeSpaceExtras({ ...good, pause: { ...good.pause, oks: 'sam' } }, toMs).pause).toBeUndefined()
    expect(decodeSpaceExtras({ ...good, pause: { ...good.pause, weekId: 7 } }, toMs).pause).toBeUndefined()
    expect(decodeSpaceExtras({ ...good, pause: { ...good.pause, declinedBy: 5 } }, toMs).pause).toEqual({ weekId: '2026-10-19', by: 'sam', at: T + 1, oks: ['sam', 'lena'] })
    expect(decodeSpaceExtras({ ...good, paused: { '2026-10': 5 } }, toMs).paused).toBeUndefined()
    expect(decodeSpaceExtras({ ...good, judges: 'ana' }, toMs).judges).toBeUndefined()
    expect(decodeSpaceExtras({ ...good, stakesNote: { by: 'lena' } }, toMs).stakesNote).toBeUndefined()
    expect(decodeSpaceExtras({ ...good, judges: [] }, toMs).judges).toEqual([])
    expect(decodeSpaceExtras({ ...good, formerJoinedAt: { kim: 'x' } }, toMs).formerJoinedAt).toBeUndefined()
    for (const v of JUNK) {
      const all = Object.fromEntries(['schedule', 'scheduleNote', 'pause', 'paused', 'judges', 'stakesNote', 'formerJoinedAt'].map((k) => [k, v]))
      expect(() => decodeSpaceExtras(all, toMs)).not.toThrow()
      expect(() => decodeSpaceExtras(v, toMs)).not.toThrow()
    }
  })

  it('a time the caller can’t read makes its field absent', () => {
    const throwing: ToMs = () => {
      throw new Error('no')
    }
    expect(decodeSpaceExtras(good, throwing)).toEqual({ schedule: good.schedule, paused: { '2026-09': '2026-09-14' }, judges: ['ana'] })
  })
})

describe('decodeWeekExtras', () => {
  it('a valid schedule and the judges list; else absent', () => {
    expect(decodeWeekExtras({ startAt: 1, schedule: { lock: 1200, reviewOpen: 5760, deadline: 7920 }, judges: ['ana'] })).toEqual({
      schedule: { lock: 1200, reviewOpen: 5760, deadline: 7920 },
      judges: ['ana'],
    })
    expect(decodeWeekExtras({ startAt: 1 })).toEqual({})
    expect(decodeWeekExtras({ schedule: { lock: -1, reviewOpen: 5760, deadline: 7920 }, judges: null })).toEqual({})
    for (const v of JUNK) expect(() => decodeWeekExtras(v)).not.toThrow()
  })
})

describe('decodeMemberStakes', () => {
  const doc = {
    rewardMode: 'group',
    penaltyMode: 'each',
    reward: 'Dinner',
    penalty: '',
    per: { lena: { reward: '', penalty: 'A coffee' }, sam: { penalty: 'A beer' }, marco: { reward: 'x', penalty: 'y' }, bad: 5, none: {} },
    tiers: [
      { months: 6, reward: 'A trip' },
      { months: 3, reward: 'Weekend away' },
    ],
    agreed: {
      lena: {
        at: ts(T),
        terms: TERMS,
        past: [{ ...TERMS, reward: 'Lunch', at: ts(T - 2000) }, { ...TERMS, reward: 'Pizza', at: ts(T - 1000) }],
      },
      marco: { at: ts(T), terms: TERMS, past: [] },
    },
    updatedAt: ts(T - 5000),
  }

  it('the modes, texts, per-friend entries, streak rewards (ascending) and agreements', () => {
    expect(decodeMemberStakes('marco', doc, toMs)).toEqual({
      uid: 'marco',
      rewardMode: 'group',
      penaltyMode: 'each',
      reward: 'Dinner',
      penalty: '',
      // Marco's own key and entries without texts are dropped; a missing text reads as ''.
      per: { lena: { reward: '', penalty: 'A coffee' }, sam: { reward: '', penalty: 'A beer' } },
      tiers: [
        { months: 3, reward: 'Weekend away' },
        { months: 6, reward: 'A trip' },
      ],
      agreed: {
        lena: {
          at: T,
          terms: { ...TERMS, rewardMode: 'group', penaltyMode: 'each' },
          past: [
            { ...TERMS, reward: 'Lunch', at: T - 2000 },
            { ...TERMS, reward: 'Pizza', at: T - 1000 },
          ],
        },
      },
      updatedAt: T - 5000,
    })
  })

  it('a bad mode reads as group, missing texts as empty, malformed streak rewards as none', () => {
    const s = decodeMemberStakes('marco', { rewardMode: 'both', penaltyMode: 3, reward: 5, tiers: [{ months: 1, reward: 'x' }] }, toMs)
    expect(s).toEqual({ uid: 'marco', rewardMode: 'group', penaltyMode: 'group', reward: '', penalty: '', per: {}, tiers: [], agreed: {}, updatedAt: 0 })
    expect(decodeMemberStakes('marco', { tiers: [{ months: 3, reward: 'a' }, { months: 3, reward: 'b' }] }, toMs).tiers).toEqual([{ months: 3, reward: 'a' }])
    expect(decodeMemberStakes('marco', { tiers: [{ months: 2.5, reward: 'a' }] }, toMs).tiers).toEqual([])
    expect(decodeMemberStakes('marco', { tiers: [{ months: 37, reward: 'a' }] }, toMs).tiers).toEqual([])
  })

  it('a malformed past entry is dropped; a whole agreement when its time or terms are malformed', () => {
    const agreed = (a: unknown) => decodeMemberStakes('marco', { ...doc, agreed: { lena: a } }, toMs).agreed
    const base = doc.agreed.lena
    expect(agreed({ ...base, past: [{ ...TERMS, at: 'yesterday' }, base.past[1]] }).lena.past).toEqual([{ ...TERMS, reward: 'Pizza', at: T - 1000 }])
    expect(agreed({ ...base, past: [{ ...TERMS, rewardMode: 'x', at: ts(T - 2000) }] }).lena.past).toEqual([])
    // Out of order, or not before the current one: dropped, so `past` stays oldest first and before `at`.
    expect(agreed({ ...base, past: [base.past[1], base.past[0], { ...TERMS, at: ts(T) }] }).lena.past.map((p) => p.at)).toEqual([T - 1000])
    expect(agreed({ ...base, past: 'none' }).lena.past).toEqual([])
    expect(agreed({ ...base, at: null })).toEqual({})
    expect(agreed({ ...base, at: ts(Number.NaN) })).toEqual({})
    expect(agreed({ ...base, terms: { ...TERMS, reward: 3 } })).toEqual({})
    expect(agreed({ ...base, terms: { ...TERMS, tiers: [{ months: 'three', reward: 'x' }] } })).toEqual({})
    expect(agreed('yes')).toEqual({})
  })

  it('never throws', () => {
    for (const v of JUNK) {
      expect(() => decodeMemberStakes('marco', v, toMs)).not.toThrow()
      expect(() => decodeMemberStakes('marco', { per: v, agreed: v, tiers: v, updatedAt: v, rewardMode: v }, toMs)).not.toThrow()
      expect(() => decodeMemberStakes('marco', { agreed: { lena: { at: ts(T), terms: TERMS, past: [v] } } }, toMs)).not.toThrow()
    }
  })
})

describe('decodeMonthResults', () => {
  const line = { text: 'Dinner', together: true, source: 'agreed', at: ts(T - 1000) }
  const doc = {
    monthId: '2026-10',
    completeAt: ts(T),
    members: {
      marco: { score: 93, passed: true, streak: 3, tierRuns: { '3': 3, '6': 1.5, x: 2, '12': -1 } },
      lena: { score: null, passed: null, streak: 2.5 },
      bad: 'x',
    },
    terms: {
      marco: {
        lena: { reward: line, penalty: { text: 'Coffee', together: true, source: 'house' }, tiers: [{ months: 3, reward: 'Weekend away' }] },
        sam: { reward: { ...line, source: 'friend' }, penalty: line, tiers: [] },
      },
      sam: { marco: 'nope' },
    },
    createdAt: ts(T + 1000),
  }

  it('members, streaks, tier runs and the stored terms; malformed entries and pairs dropped', () => {
    expect(decodeMonthResults(doc, toMs)).toEqual({
      monthId: '2026-10',
      completeAt: T,
      members: {
        marco: { score: 93, passed: true, streak: 3, tierRuns: { '3': 3 } },
        // A non-int streak reads as 0.
        lena: { score: null, passed: null, streak: 0 },
      },
      terms: {
        marco: {
          lena: {
            reward: { text: 'Dinner', together: true, source: 'agreed', at: T - 1000 },
            penalty: { text: 'Coffee', together: true, source: 'house' },
            tiers: [{ months: 3, reward: 'Weekend away' }],
          },
        },
      },
      createdAt: T + 1000,
    })
  })

  it('the month from the doc id when the field is missing; null when it isn’t a results doc', () => {
    expect(decodeMonthResults({ members: {} }, toMs, '2026-11')).toEqual({ monthId: '2026-11', completeAt: 0, members: {}, createdAt: 0 })
    expect(decodeMonthResults({ monthId: '2026-13', members: {} }, toMs)).toBeNull()
    expect(decodeMonthResults({ members: {} }, toMs, 'latest')).toBeNull()
    expect(decodeMonthResults(null, toMs, '2026-10')).toBeNull()
    // No terms (nobody played with anyone): no `terms` key.
    expect('terms' in (decodeMonthResults({ monthId: '2026-10', members: {}, terms: { marco: {} } }, toMs) ?? {})).toBe(false)
  })

  it('never throws', () => {
    for (const v of JUNK) {
      expect(() => decodeMonthResults(v, toMs, '2026-10')).not.toThrow()
      expect(() => decodeMonthResults({ monthId: '2026-10', members: { a: v, b: { streak: v, tierRuns: v } }, terms: v, completeAt: v }, toMs)).not.toThrow()
      expect(() => decodeMonthResults({ monthId: '2026-10', members: {}, terms: { a: { b: { reward: v, penalty: v, tiers: v } } } }, toMs)).not.toThrow()
    }
  })
})

// ---------- Batch 2.5 (SPEC §10.3, §10.4) ----------

describe('decodeCancels', () => {
  const WHY = 'The pool is closed all week'
  const out = (n: number, why = WHY) => (n % 2 === 1 ? { at: ts(T + n), why } : { at: ts(T + n) })

  it('a full log: cross out, undo, cross out, undo, cross out for good', () => {
    const log = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`${n}:swim`, out(n, `Reason ${n}`)]))
    expect(decodeCancels(log, toMs)).toEqual({ swim: { cancelled: true, changes: 5, at: T + 5, why: 'Reason 5' } })
  })

  it('each step of the log: the state, the latest change’s time, the latest cross-out’s reason', () => {
    const entries = [1, 2, 3, 4].map((n) => [`${n}:swim`, out(n, `Reason ${n}`)] as const)
    expect(decodeCancels(Object.fromEntries(entries.slice(0, 1)), toMs).swim).toEqual({ cancelled: true, changes: 1, at: T + 1, why: 'Reason 1' })
    // Restored: the reason of the cross-out stays.
    expect(decodeCancels(Object.fromEntries(entries.slice(0, 2)), toMs).swim).toEqual({ cancelled: false, changes: 2, at: T + 2, why: 'Reason 1' })
    expect(decodeCancels(Object.fromEntries(entries.slice(0, 3)), toMs).swim).toEqual({ cancelled: true, changes: 3, at: T + 3, why: 'Reason 3' })
    expect(decodeCancels(Object.fromEntries(entries), toMs).swim).toEqual({ cancelled: false, changes: 4, at: T + 4, why: 'Reason 3' })
  })

  it('several tasks, each on its own; entries in any order', () => {
    const log = { '2:read': out(2), '1:swim': out(1), '1:read': out(1, 'Library shut') }
    expect(decodeCancels(log, toMs)).toEqual({
      swim: { cancelled: true, changes: 1, at: T + 1, why: WHY },
      read: { cancelled: false, changes: 2, at: T + 2, why: 'Library shut' },
    })
  })

  it('contiguity from 1: a gap ends the log, and without entry 1 there is none', () => {
    expect(decodeCancels({ '1:swim': out(1), '3:swim': out(3) }, toMs).swim).toMatchObject({ changes: 1, cancelled: true })
    expect(decodeCancels({ '1:swim': out(1), '2:swim': out(2), '4:swim': out(4), '5:swim': out(5) }, toMs).swim).toMatchObject({ changes: 2, cancelled: false })
    expect(decodeCancels({ '2:swim': out(2), '3:swim': out(3) }, toMs)).toEqual({})
  })

  it('n = 6 and beyond, n = 0, two digits and other bad keys are dropped', () => {
    const full = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`${n}:swim`, out(n)]))
    expect(decodeCancels({ ...full, '6:swim': out(6) }, toMs).swim).toMatchObject({ changes: 5, cancelled: true, at: T + 5 })
    for (const key of ['0:swim', '6:swim', '9:swim', '01:swim', '11:swim', '1:', '1', 'swim', ':swim', '1:sw:im', '1:sw im', '1:swim!', `1:${'x'.repeat(65)}`, ' 1:swim', '1:swim ', 'a:swim', '-1:swim']) {
      expect(decodeCancels({ [key]: out(1) }, toMs)).toEqual({})
    }
    // A 64-character id is fine.
    expect(Object.keys(decodeCancels({ [`1:${'x'.repeat(64)}`]: out(1) }, toMs))).toEqual(['x'.repeat(64)])
  })

  it('a missing, malformed or non-time `at` drops the entry (and so ends the log there)', () => {
    for (const at of [undefined, null, 0, -5, 'yesterday', T, ts(Number.NaN), ts(0), ts(-1), { toMillis: () => { throw new Error('boom') } }]) {
      expect(decodeCancels({ '1:swim': { at, why: WHY } }, toMs)).toEqual({})
      expect(decodeCancels({ '1:swim': out(1), '2:swim': { at } }, toMs).swim).toMatchObject({ changes: 1, cancelled: true })
    }
    for (const value of [null, 'x', 7, true, [], [ts(T)]]) expect(decodeCancels({ '1:swim': value }, toMs)).toEqual({})
  })

  it('an odd entry needs a reason that isn’t blank; it is read on one line', () => {
    for (const why of [undefined, null, '', '   ', '\n', 5, ['Sick'], { text: 'Sick' }]) {
      expect(decodeCancels({ '1:swim': { at: ts(T), why } }, toMs)).toEqual({})
      expect(decodeCancels({ '1:swim': out(1), '2:swim': out(2), '3:swim': { at: ts(T + 3), why } }, toMs).swim).toMatchObject({ changes: 2, cancelled: false, why: WHY })
    }
    expect(decodeCancels({ '1:swim': { at: ts(T), why: '  Sick\n all week ' } }, toMs).swim.why).toBe('Sick all week')
    // Emoji and a long reason are kept as stored (the rules check the length).
    expect(decodeCancels({ '1:swim': { at: ts(T), why: '🤒 Flu' } }, toMs).swim.why).toBe('🤒 Flu')
  })

  it('an even entry with a reason, or extra fields anywhere, is still fine', () => {
    const log = { '1:swim': { ...out(1), extra: 1 }, '2:swim': { at: ts(T + 2), why: 'Changed my mind' } }
    expect(decodeCancels(log, toMs).swim).toEqual({ cancelled: false, changes: 2, at: T + 2, why: WHY })
  })

  it('ids not on any list are kept here (decodeTasks ignores them), even odd ones', () => {
    expect(Object.keys(decodeCancels({ '1:gone': out(1), '1:__proto__': out(1), '1:constructor': out(1) }, toMs)).sort()).toEqual(['__proto__', 'constructor', 'gone'])
    const odd = decodeCancels({ '1:__proto__': out(1) }, toMs)
    expect(Object.hasOwn(odd, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(odd)).toBe(Object.prototype)
  })

  it('no log, or not a map: nothing; never throws', () => {
    expect(decodeCancels(undefined, toMs)).toEqual({})
    expect(decodeCancels({}, toMs)).toEqual({})
    for (const v of JUNK) {
      expect(() => decodeCancels(v, toMs)).not.toThrow()
      expect(() => decodeCancels({ '1:a': v, '2:a': v, '1:b': { at: v, why: v } }, toMs)).not.toThrow()
    }
    expect(decodeCancels([out(1)], toMs)).toEqual({})
  })
})

describe('isReviewMark', () => {
  it('Done, Half, Not done or Fair, Skip It', () => {
    for (const v of [0, 0.5, 1, 'fair', 1.0, 0.0]) expect(isReviewMark(v)).toBe(true)
    for (const v of ['Fair', 'skip', 'FAIR', ' fair', -1, 2, 0.25, '1', '0', NaN, null, undefined, true, {}, []]) expect(isReviewMark(v)).toBe(false)
  })
})
