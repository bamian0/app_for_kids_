import { describe, expect, it } from 'vitest'
import {
  decodeCancels,
  decodeCheckin,
  decodeFriendship,
  decodeMemberStakes,
  decodeMonthResults,
  decodeRing,
  decodeSchedule,
  decodeScores,
  decodeSharedGoal,
  decodeShowcase,
  decodeSpaceExtras,
  decodeStats,
  decodeWeekExtras,
  isReviewMark,
  type ToMs,
} from './decode.ts'
import { goalEndsAt, goalProgress, goalShares, goalWeek } from './shared.ts'

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
    // Blank as the rules and the app see it (whyIsBlank): spaces of any width and zero-width characters too.
    for (const why of [undefined, null, '', '   ', '\n', '\u00a0', '\u3000', '\u2003', '\u2028', '\u200b', '\u200b\ufeff', 5, ['Sick'], { text: 'Sick' }]) {
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

// ---------- Batch 3 (SPEC §11.3) ----------

describe('decodeFriendship', () => {
  const good = { users: ['ana', 'ben'], by: 'ana', state: 'asked', at: ts(T) }

  it('a pair, as either side sees it', () => {
    expect(decodeFriendship('ana_ben', good, 'ana', toMs)).toEqual({ id: 'ana_ben', uid: 'ben', by: 'ana', state: 'asked', at: T })
    expect(decodeFriendship('ana_ben', good, 'ben', toMs)).toEqual({ id: 'ana_ben', uid: 'ana', by: 'ana', state: 'asked', at: T })
    for (const state of ['declined', 'withdrawn', 'friends']) expect(decodeFriendship('ana_ben', { ...good, state }, 'ben', toMs)?.state).toBe(state)
  })
  it('null for a pair that isn’t mine, an unsorted or malformed id, or users naming others', () => {
    expect(decodeFriendship('ana_ben', good, 'cleo', toMs)).toBeNull()
    expect(decodeFriendship('ben_ana', { ...good, users: ['ben', 'ana'] }, 'ana', toMs)).toBeNull()
    expect(decodeFriendship('ana', good, 'ana', toMs)).toBeNull()
    expect(decodeFriendship('ana_ana', good, 'ana', toMs)).toBeNull()
    expect(decodeFriendship('ana_ben_cleo', good, 'ana', toMs)).toBeNull()
    expect(decodeFriendship('ana_ben', { ...good, users: ['ana', 'cleo'] }, 'ana', toMs)).toBeNull()
    expect(decodeFriendship('ana_ben', { ...good, users: 'ana_ben' }, 'ana', toMs)).toBeNull()
  })
  it('null for a bad state, asker or time', () => {
    expect(decodeFriendship('ana_ben', { ...good, state: 'blocked' }, 'ana', toMs)).toBeNull()
    expect(decodeFriendship('ana_ben', { ...good, by: 'cleo' }, 'ana', toMs)).toBeNull()
    expect(decodeFriendship('ana_ben', { ...good, at: null }, 'ana', toMs)).toBeNull()
    for (const v of JUNK) {
      expect(() => decodeFriendship('ana_ben', v, 'ana', toMs)).not.toThrow()
      expect(decodeFriendship('ana_ben', v, 'ana', toMs)).toBeNull()
      expect(decodeFriendship('ana_ben', { ...good, by: v }, 'ana', toMs)).toBeNull()
      expect(decodeFriendship('ana_ben', { ...good, state: v }, 'ana', toMs)).toBeNull()
      expect(() => decodeFriendship(v as string, good, 'ana', toMs)).not.toThrow()
    }
  })
})

describe('decodeShowcase', () => {
  const good = {
    show: { stats: false, achieved: true, goals: true, earnings: true },
    achieved: [{ name: 'Sony FX3', at: ts(T) }],
    goals: [{ name: 'Bike', pct: 64 }],
    earnings: { monthId: '2026-09', amount: 420.5, currency: 'USD' },
    updatedAt: ts(T + 1),
  }

  it('every switch and item', () => {
    expect(decodeShowcase('ana', good, toMs)).toEqual({
      uid: 'ana',
      show: { stats: false, achieved: true, goals: true, earnings: true },
      achieved: [{ name: 'Sony FX3', at: T }],
      goals: [{ name: 'Bike', pct: 64 }],
      earnings: { monthId: '2026-09', amount: 420.5, currency: 'USD' },
      updatedAt: T + 1,
    })
  })
  it('no doc: null (DEFAULT_SHOW, no items)', () => {
    expect(decodeShowcase('ana', undefined, toMs)).toBeNull()
    expect(decodeShowcase('ana', null, toMs)).toBeNull()
  })
  it('an item shows only while its switch is on', () => {
    const off = decodeShowcase('ana', { ...good, show: { stats: true, achieved: false, goals: false, earnings: false } }, toMs)
    expect(off).toEqual({ uid: 'ana', show: { stats: true, achieved: false, goals: false, earnings: false }, updatedAt: T + 1 })
  })
  it('a switch that isn’t a boolean reads as its default (stats on, money off)', () => {
    const odd = decodeShowcase('ana', { ...good, show: { stats: 'no', achieved: 1, goals: null } }, toMs)
    expect(odd?.show).toEqual({ stats: true, achieved: false, goals: false, earnings: false })
    expect(odd && 'achieved' in odd).toBe(false)
    expect(decodeShowcase('ana', { updatedAt: ts(T) }, toMs)?.show).toEqual({ stats: true, achieved: false, goals: false, earnings: false })
  })
  it('malformed items are dropped: a bad name, pct or time; lists cut to their caps', () => {
    const d = decodeShowcase(
      'ana',
      {
        ...good,
        achieved: [
          { name: 'Ok', at: ts(T) },
          { name: '', at: ts(T) },
          { name: '   ', at: ts(T) },
          { name: 'x'.repeat(61), at: ts(T) },
          { name: 'No time', at: null },
          { name: 7, at: ts(T) },
          'Sony',
          null,
          ...Array.from({ length: 14 }, (_, i) => ({ name: `G${i}`, at: ts(T - i) })),
        ],
        goals: [
          { name: 'Bike', pct: 101 },
          { name: 'Lens', pct: 1.5 },
          { name: 'Camera', pct: -1 },
          { name: 'Trip', pct: '50' },
          { name: 'x'.repeat(60), pct: 100 },
          ...Array.from({ length: 9 }, (_, i) => ({ name: `Later ${i}`, pct: i })),
        ],
      },
      toMs,
    )
    expect(d?.achieved?.[0]).toEqual({ name: 'Ok', at: T })
    expect(d?.achieved).toHaveLength(12)
    expect(d?.achieved?.[1]).toEqual({ name: 'G0', at: T })
    expect(d?.goals?.[0]).toEqual({ name: 'x'.repeat(60), pct: 100 })
    expect(d?.goals).toHaveLength(8)
  })
  it('malformed earnings are dropped: a lowercase currency, a bad month, an amount out of range', () => {
    for (const earnings of [
      { ...good.earnings, currency: 'usd' },
      { ...good.earnings, currency: 'US' },
      { ...good.earnings, monthId: '2026-13' },
      { ...good.earnings, monthId: '2026-09-01' },
      { ...good.earnings, amount: -1 },
      { ...good.earnings, amount: 1e9 + 1 },
      { ...good.earnings, amount: Number.NaN },
      { ...good.earnings, amount: '5' },
      'lots',
    ]) {
      const d = decodeShowcase('ana', { ...good, earnings }, toMs)
      expect(d && 'earnings' in d).toBe(false)
    }
    expect(decodeShowcase('ana', { ...good, earnings: { ...good.earnings, amount: 0 } }, toMs)?.earnings?.amount).toBe(0)
  })
  it('never throws', () => {
    for (const v of JUNK) {
      expect(() => decodeShowcase('ana', v, toMs)).not.toThrow()
      expect(() => decodeShowcase('ana', { show: v, achieved: v, goals: v, earnings: v, updatedAt: v }, toMs)).not.toThrow()
      expect(() => decodeShowcase('ana', { ...good, achieved: [v], goals: [v] }, toMs)).not.toThrow()
    }
  })
})

describe('decodeRing', () => {
  it('a ring', () => {
    expect(decodeRing('ana', { monthId: '2026-10', score: 92.5, final: false, spaces: 2, updatedAt: ts(T) }, toMs)).toEqual({
      uid: 'ana',
      monthId: '2026-10',
      score: 92.5,
      final: false,
      spaces: 2,
      updatedAt: T,
    })
  })
  it('no doc: null; a bad month: the empty ring', () => {
    expect(decodeRing('ana', undefined, toMs)).toBeNull()
    const empty = { uid: 'ana', monthId: null, score: null, final: false, spaces: 0, updatedAt: T }
    expect(decodeRing('ana', { monthId: '2026-13', score: 92, final: true, spaces: 1, updatedAt: ts(T) }, toMs)).toEqual(empty)
    expect(decodeRing('ana', { monthId: null, score: null, final: false, spaces: 0, updatedAt: ts(T) }, toMs)).toEqual(empty)
  })
  it('a score is a finite number kept within 0–100; spaces an int (0 without a score)', () => {
    const ring = (patch: object) => decodeRing('ana', { monthId: '2026-10', score: 80, final: true, spaces: 1, updatedAt: ts(T), ...patch }, toMs)
    expect(ring({ score: 120 })?.score).toBe(100)
    expect(ring({ score: -3 })?.score).toBe(0)
    expect(ring({ score: '80' })).toMatchObject({ score: null, spaces: 0 })
    expect(ring({ score: Number.NaN })?.score).toBeNull()
    expect(ring({ spaces: 1.5 })?.spaces).toBe(1)
    expect(ring({ spaces: -1 })?.spaces).toBe(1)
    expect(ring({ final: 'yes' })?.final).toBe(false)
  })
  it('never throws', () => {
    for (const v of JUNK) {
      expect(() => decodeRing('ana', v, toMs)).not.toThrow()
      expect(() => decodeRing('ana', { monthId: v, score: v, final: v, spaces: v, updatedAt: v }, toMs)).not.toThrow()
    }
  })
})

describe('decodeStats', () => {
  const good = { monthsCleared: 3, currentStreak: 2, bestStreak: 3, weeksPlayed: 14, finishedMonths: 4, since: '2026-10', updatedAt: ts(T) }
  it('the facts', () => {
    expect(decodeStats('ana', good, toMs)).toEqual({ uid: 'ana', monthsCleared: 3, currentStreak: 2, bestStreak: 3, weeksPlayed: 14, finishedMonths: 4, since: '2026-10', updatedAt: T })
    expect(decodeStats('ana', undefined, toMs)).toBeNull()
  })
  it('a malformed count reads 0, a bad since null', () => {
    const d = decodeStats('ana', { ...good, monthsCleared: -1, currentStreak: 1.5, bestStreak: '3', weeksPlayed: Number.NaN, since: 'October' }, toMs)
    expect(d).toMatchObject({ monthsCleared: 0, currentStreak: 0, bestStreak: 0, weeksPlayed: 0, finishedMonths: 4, since: null })
    for (const v of JUNK) expect(() => decodeStats('ana', { ...good, since: v, finishedMonths: v, updatedAt: v }, toMs)).not.toThrow()
  })
})

describe('decodeScores', () => {
  it('the months, with each space’s entry; weeks deduplicated and sorted', () => {
    const d = decodeScores(
      { months: { '2026-10': { s1: { score: 95, weeks: ['2026-10-12', '2026-10-05', '2026-10-12'], final: true }, s2: { score: null, weeks: [], final: false } } }, updatedAt: ts(T) },
      toMs,
    )
    expect(d).toEqual({ '2026-10': { s1: { score: 95, weeks: ['2026-10-05', '2026-10-12'], final: true }, s2: { score: null, weeks: [], final: false } } })
  })
  it('malformed months, entries and weeks are dropped', () => {
    const d = decodeScores(
      {
        months: {
          '2026-13': { s1: { score: 95, weeks: [], final: true } },
          '2026-11': { s1: 'x', s2: { score: 50 }, s3: { score: 'x', weeks: ['2026-11-02', 'soon', 4], final: 'yes' } },
          '2026-12': {},
          '2026-09': [],
        },
      },
      toMs,
    )
    expect(d).toEqual({ '2026-11': { s3: { score: null, weeks: ['2026-11-02'], final: false } } })
  })
  it('nothing usable: no months; never throws', () => {
    for (const v of JUNK) {
      expect(decodeScores(v, toMs)).toEqual({})
      expect(decodeScores({ months: v }, toMs)).toEqual({})
      expect(() => decodeScores({ months: { '2026-10': v } }, toMs)).not.toThrow()
      expect(() => decodeScores({ months: { '2026-10': { s1: v } } }, toMs)).not.toThrow()
    }
  })
})

describe('decodeSharedGoal', () => {
  const good = {
    name: 'Run 100 km',
    unit: 'km',
    target100: 10000,
    endsOn: '2026-12-31',
    timezone: 'Europe/Berlin',
    utcOffsetMin: 120,
    zones: { ana: 'Europe/Berlin', ben: 'Asia/Tokyo' },
    ownerId: 'ana',
    createdBy: 'ana',
    memberIds: ['ana', 'ben'],
    invited: ['cleo'],
    joinedAt: { ana: ts(T - 2), ben: ts(T - 1) },
    leftAt: { dan: ts(T - 3) },
    totals100: { ana: 3010, ben: 2500, dan: 1250 },
    total100: 6760,
    last: { by: 'ben', weekId: '2026-10-12', at: ts(T) },
    reachedAt: null,
    archivedAt: null,
    createdAt: ts(T - 5),
  }
  const id = 'Xy12AbCdEfGhIjKlMn34'

  it('in real units', () => {
    expect(decodeSharedGoal(id, good, toMs)).toEqual({
      id,
      name: 'Run 100 km',
      unit: 'km',
      target: 100,
      endsOn: '2026-12-31',
      timezone: 'Europe/Berlin',
      utcOffsetMin: 120,
      zones: { ana: 'Europe/Berlin', ben: 'Asia/Tokyo' },
      ownerId: 'ana',
      createdBy: 'ana',
      memberIds: ['ana', 'ben'],
      invited: ['cleo'],
      joinedAt: { ana: T - 2, ben: T - 1 },
      leftAt: { dan: T - 3 },
      totals: { ana: 30.1, ben: 25, dan: 12.5 },
      total: 67.6,
      last: { by: 'ben', weekId: '2026-10-12', at: T },
      reachedAt: null,
      archivedAt: null,
      createdAt: T - 5,
    })
  })
  it('reached and finished times', () => {
    const d = decodeSharedGoal(id, { ...good, reachedAt: ts(T + 1), archivedAt: ts(T + 2) }, toMs)
    expect([d?.reachedAt, d?.archivedAt]).toEqual([T + 1, T + 2])
  })
  it('null for an id that fails isGoalId', () => {
    for (const bad of ['', 'a_b', 'a#b', 'a'.repeat(41), 'g/1']) expect(decodeSharedGoal(bad, good, toMs)).toBeNull()
  })
  it('null for a bad target100, name, unit, owner, members or offset', () => {
    for (const target100 of [0, -100, 12.5, 1e11 + 1, '10000', null, Number.NaN]) expect(decodeSharedGoal(id, { ...good, target100 }, toMs)).toBeNull()
    expect(decodeSharedGoal(id, { ...good, target100: 1e11 }, toMs)?.target).toBe(1e9)
    expect(decodeSharedGoal(id, { ...good, name: '  ' }, toMs)).toBeNull()
    expect(decodeSharedGoal(id, { ...good, unit: 5 }, toMs)).toBeNull()
    expect(decodeSharedGoal(id, { ...good, ownerId: 'a_b' }, toMs)).toBeNull()
    expect(decodeSharedGoal(id, { ...good, memberIds: 'ana' }, toMs)).toBeNull()
    expect(decodeSharedGoal(id, { ...good, utcOffsetMin: 900 }, toMs)).toBeNull()
    expect(decodeSharedGoal(id, { ...good, utcOffsetMin: 60.5 }, toMs)).toBeNull()
  })
  it('a bad zone entry is dropped; a bad goal zone falls back to the creation offset (the rules’ anchor)', () => {
    const d = decodeSharedGoal(id, { ...good, timezone: 'Mars/Olympus', utcOffsetMin: 330, zones: { ana: 'Nowhere/City', ben: 'Asia/Tokyo', 'c_d': 'UTC', eve: 7 } }, toMs)
    expect(d?.zones).toEqual({ ben: 'Asia/Tokyo' })
    expect(d?.timezone).toBe('UTC+5:30')
    // The fallback is a zone the week helpers accept.
    expect(goalWeek(d!, Date.parse('2026-10-25T19:00:00Z'))).toBe('2026-10-26')
    expect(goalWeek(d!, Date.parse('2026-10-25T18:29:59Z'))).toBe('2026-10-19')
    expect(goalEndsAt(d!)).toBe(Date.parse('2026-12-31T18:30:00Z'))
    expect(decodeSharedGoal(id, { ...good, timezone: 'x', utcOffsetMin: -30 }, toMs)?.timezone).toBe('UTC-0:30')
    expect(decodeSharedGoal(id, { ...good, timezone: null, utcOffsetMin: 0 }, toMs)?.timezone).toBe('UTC')
    expect(goalWeek(decodeSharedGoal(id, { ...good, timezone: 'x', utcOffsetMin: -30 }, toMs)!, Date.parse('2026-10-26T00:29:59Z'))).toBe('2026-10-19')
  })
  it('malformed parts, times and lists are left out', () => {
    const d = decodeSharedGoal(
      id,
      {
        ...good,
        memberIds: ['ana', 'ben', 'ana', 'x_y', 7],
        invited: ['cleo', 'ben', '', 'cleo'],
        joinedAt: { ana: ts(T - 2), ben: 'yesterday', 'x_y': ts(T) },
        totals100: { ana: 3010, ben: 25.5, cleo: '3', 'x_y': 5 },
        total100: 3010,
        endsOn: '2026-02-30',
        last: { by: 'ben', weekId: 'last week', at: ts(T) },
        reachedAt: 'soon',
        createdBy: 7,
      },
      toMs,
    )
    expect(d).toMatchObject({
      memberIds: ['ana', 'ben'],
      invited: ['cleo'],
      joinedAt: { ana: T - 2 },
      totals: { ana: 30.1 },
      total: 30.1,
      endsOn: null,
      last: null,
      reachedAt: null,
      createdBy: 'ana',
    })
  })
  it('a malformed total falls back to the sum of the parts', () => {
    expect(decodeSharedGoal(id, { ...good, total100: 67.6 }, toMs)?.total).toBe(67.6)
    expect(decodeSharedGoal(id, { ...good, total100: null }, toMs)?.total).toBe(67.6)
    expect(decodeSharedGoal(id, { ...good, total100: Number.MAX_SAFE_INTEGER + 1 }, toMs)?.total).toBe(67.6)
  })
  it('parts and totals of any size the rules take: 9 weekly check-ins of 1e11 hundredths stay counted', () => {
    // The rules bound each check-in (≤ 10¹¹) but never a part or the total.
    const ben = 9 * 1e11
    const d = decodeSharedGoal(id, { ...good, target100: 2000, totals100: { ana: 1500, ben }, total100: ben + 1500, reachedAt: ts(T) }, toMs)!
    expect(d.totals).toEqual({ ana: 15, ben: 9e9 })
    expect(d.total).toBe(9e9 + 15)
    expect(goalProgress(d)).toMatchObject({ reached: true, ratio: 1 })
    expect(goalShares(d).map((s) => s.uid)).toEqual(['ben', 'ana'])
    const huge = Number.MAX_SAFE_INTEGER - 1
    expect(decodeSharedGoal(id, { ...good, totals100: { ana: huge }, total100: huge }, toMs)?.total).toBe(huge / 100)
  })
  it('never throws', () => {
    for (const v of JUNK) {
      expect(() => decodeSharedGoal(id, v, toMs)).not.toThrow()
      const all = Object.fromEntries(Object.keys(good).map((k) => [k, v]))
      expect(() => decodeSharedGoal(id, all, toMs)).not.toThrow()
      expect(() => decodeSharedGoal(id, { ...good, zones: { ana: v }, joinedAt: { ana: v }, totals100: { ana: v }, last: v }, toMs)).not.toThrow()
    }
  })
})

describe('decodeCheckin', () => {
  const good = { uid: 'ben', weekId: '2026-10-19', amount100: 1250, note: 'Long run', at: ts(T) }
  it('in real units', () => {
    expect(decodeCheckin('2026-10-19_ben', good, toMs)).toEqual({ id: '2026-10-19_ben', uid: 'ben', weekId: '2026-10-19', amount: 12.5, note: 'Long run', at: T })
    expect(decodeCheckin('2026-10-19_ben', { ...good, amount100: 0, note: 5 }, toMs)).toMatchObject({ amount: 0, note: '' })
  })
  it('null unless the id matches its week and uid and the amount is an int 0…10¹¹', () => {
    expect(decodeCheckin('2026-10-12_ben', good, toMs)).toBeNull()
    expect(decodeCheckin('2026-10-19_ana', good, toMs)).toBeNull()
    expect(decodeCheckin('2026-10-19_ben', { ...good, uid: 'b_en' }, toMs)).toBeNull()
    for (const amount100 of [-1, 12.5, 1e11 + 1, '1250', null]) expect(decodeCheckin('2026-10-19_ben', { ...good, amount100 }, toMs)).toBeNull()
    for (const v of JUNK) {
      expect(decodeCheckin('2026-10-19_ben', v, toMs)).toBeNull()
      expect(() => decodeCheckin('2026-10-19_ben', { ...good, note: v, at: v }, toMs)).not.toThrow()
    }
  })
})
