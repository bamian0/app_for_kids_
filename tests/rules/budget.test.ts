// The rules' worst cases against Firestore's limits (SPEC §9.9): at most 1000 expressions per
// request, and at most 10 document reads per request (20 for a batch or transaction). Each case below
// must pass against the published rules.
//
// Measured headroom: `MEASURE=<out.json> npx firebase emulators:exec --only firestore --project
// demo-stakes "npx vitest run --config vitest.rules.config.ts tests/rules/budget.test.ts -t 'every case'"`
// re-runs each case with k cheap terms appended to the condition that allows it, and the largest k
// that still passes is its headroom (a term is 5.24 expressions: 191 of them alone fill the limit);
// then likewise with k reads of missing docs (tried up to 10). Measured 2026-10-14 (emulator of
// firebase-tools 15.33):
//
//   case                                                       used   headroom   spare reads
//   week plan, 25 × 8, batched with the week fill               895      105          10
//   week append after the lock: the 25th full task              304      696           8
//   monthly plan, 25 × 8, batched with syncsPeriod              895      105          10
//   validNewWeek: own times, judges, a note, 8 members          450      550           9
//   retimesWeek, 8 members (last in the week chain)             534      466           9
//   syncsPeriod on a week, 8 members                            157      843           9
//   setsSchedule (8th in the space chain)                       550      450          10
//   validNewMonthly, 8 members, judges (moved clock)            461      539           9
//   retimesMonthly with both weeks stored                       513      487           7
//   finalizesPause, 8 members (last in the space chain)         644      356           9
//   declinesPause: Not Now, 8 members (reads the week)          602      398           9   (2026-10-16)
//   asksToPause after a lapsed request, 8 members               654      346           8
//   stakes create: 7 per, 5 streak rewards                      832      168           9
//   stakes owner edit: 7 per, 5 streaks, 7 × 6 agreements       838      162           9
//   Agree, the 6th (drops the oldest), per friend, 5 streaks    335      665           9
//   months create, its last week and list stored                288      712           7
//   months re-freeze of an early freeze                         319      681           7
//   owner's house-stakes edit, the space op (2 freezes)         702      298          10
//   monthly review with 25 marks, one of a 7-review submit      487      513           9
//   setJudge, the space op of space + 4 periods                 283      717          10
//   settlement, one of a group line of 7                        241      759           9
//
// The plan path keeps canPlan's judge check: its headroom (105) is above the 40 SPEC §9.4 asks for.
// "moved clock": validNewMonthly can't run on real time on most days, so it is measured on the
// calendar.test.ts variant, which costs a little more than the published rule.
import { describe, expect, test } from 'vitest'
import { writeFileSync } from 'node:fs'
import {
  arrayUnion, doc, runTransaction, serverTimestamp, setDoc, updateDoc, writeBatch, type DocumentData, type Firestore,
} from 'firebase/firestore'
import {
  addMonths, allowed, CUSTOM, DAY, fullTask, HOUR, mondayOf, monthlyDoc, monthlyOn, monthStr, monthWeeks, movedClock,
  PUBLISHED_RULES, spaceDoc, ts, useRulesEnv, USUAL, weekDoc, weekOn, type Schedule,
} from './helpers.ts'

const { db, seed, loadRules, clear } = useRulesEnv()

const ZONE = 'Europe/Berlin'
const M8 = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']
const LATER: Schedule = { lock: 2880, reviewOpen: 5760, deadline: 8640 }
const C = monthStr(Date.now())
const P = addMonths(C, -1)
const M2 = addMonths(C, 2)
const M3 = addMonths(C, 3)
const NEXT = mondayOf(ZONE, 1)
const AFTER = mondayOf(ZONE, 2)
const full = Array.from({ length: 25 }, (_, i) => fullTask(i))
const marks25 = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`t${i}`.padEnd(64, 'x'), 0.5]))

type Db = (uid?: string) => Firestore
type Case = {
  name: string
  /** Text of the rule that allows the measured op, and the same text with `pad(1)` and `apad()` added. */
  point: string
  padded: string
  movedClock?: boolean
  seed: () => Record<string, DocumentData>
  run: (db: Db) => Promise<unknown>
}

/** Appends the pads to a rule's condition that ends with `;`. */
const atEnd = (point: string) => ({ point, padded: point.replace(/;$/, ' && pad(1) && apad();') })
const SPACE = atEnd('|| declinesPause() || finalizesPause());')
const WEEK_UPDATE = atEnd('|| retimesWeek(spaceId, weekId));')
const WEEK_CREATE = atEnd('validNewWeek(spaceId, weekId, incoming());')
const WEEK_PLAN = {
  point: '&& incoming().updatedAt == request.time)\n            || appendsTask(spaceId, weekId, uid);',
  padded: '&& incoming().updatedAt == request.time && pad(1) && apad())\n            || appendsTask(spaceId, weekId, uid);',
}
const WEEK_APPEND = atEnd('&& d.added[t.id] == request.time;')
const MONTHLY_UPDATE = atEnd('|| retimesMonthly(spaceId, monthId));')
const MONTHLY_CREATE = atEnd('validNewMonthly(spaceId, monthId, incoming());')
const MONTHLY_PLAN = atEnd('validTasks(incoming().tasks)\n            && incoming().updatedAt == request.time;')
const MONTHLY_REVIEW = atEnd("validReview(spaceId, 'monthly', monthId, rid);")
const STAKES_CREATE = atEnd('&& incoming().agreed == {};')
const STAKES_UPDATE = atEnd('(editsOwnStakes(spaceId, uid) || agreesToStakes(spaceId, uid));')
const MONTHS_CREATE = atEnd('allow create: if isMember(spaceId) && validMonthStakes(spaceId, monthId, false);')
const MONTHS_UPDATE = atEnd('allow update: if isMember(spaceId) && validMonthStakes(spaceId, monthId, true);')
const SETTLE = atEnd('allow create, update: if signedIn() && validSettlement(spaceId, sid);')

const space = (extra: DocumentData = {}) => spaceDoc(M8, { createdAt: ts(Date.now() - 90 * DAY), ...extra })
const weekEnding = (deadlineMs: number): DocumentData => ({
  startAt: ts(deadlineMs - 5 * DAY), lockAt: ts(deadlineMs - 4 * DAY), reviewOpenAt: ts(deadlineMs - DAY), deadlineAt: ts(deadlineMs),
  members: M8, submittedBy: [],
})
const lastWeekPath = (m: string) => `spaces/s1/weeks/${monthWeeks(m).last}`
const tiers5 = [2, 3, 6, 12, 24].map((months) => ({ months, reward: 'W'.repeat(120) }))
const per7 = Object.fromEntries(M8.slice(1).map((u) => [u, { reward: 'R'.repeat(120), penalty: 'P'.repeat(120) }]))
const termsOf = (d: DocumentData, f: string) => ({
  rewardMode: d.rewardMode, penaltyMode: d.penaltyMode,
  reward: d.rewardMode === 'group' ? d.reward : d.per[f].reward,
  penalty: d.penaltyMode === 'group' ? d.penalty : d.per[f].penalty,
  tiers: d.tiers,
})
const eachStakes = (text = 'R'): DocumentData => ({
  rewardMode: 'each', penaltyMode: 'each', reward: '', penalty: '',
  per: Object.fromEntries(M8.slice(1).map((u) => [u, { reward: text.repeat(120), penalty: 'P'.repeat(120) }])),
  tiers: tiers5, agreed: {}, updatedAt: ts(Date.now() - DAY),
})
/** Six agreements of `f` to stakes with reward texts A…F: five in past, the last current. */
const T0 = Date.now()
const sixAgreements = (f: string): DocumentData => {
  const past = ['A', 'B', 'C', 'D', 'E'].map((t, i) => ({ ...termsOf(eachStakes(t), f), at: ts(T0 - (10 - i) * DAY) }))
  return { at: ts(T0 - 4 * DAY), terms: termsOf(eachStakes('F'), f), past }
}

const CASES: Case[] = [
  {
    name: 'week plan, 25 × 8, batched with the week fill',
    ...WEEK_PLAN,
    seed: () => ({ 'spaces/s1': space({ judges: ['m1'] }), 'spaces/s1/weeks/W': { ...weekDoc('planning', M8.slice(0, 7)), judges: ['m1'] } }),
    run: (db) => {
      const fs = db('m8')
      const b = writeBatch(fs)
      b.update(doc(fs, 'spaces/s1/weeks/W'), { members: arrayUnion('m8') })
      b.set(doc(fs, 'spaces/s1/weeks/W/plans/m8'), { tasks: full, updatedAt: serverTimestamp() })
      return b.commit()
    },
  },
  {
    name: 'week append after the lock: the 25th full task',
    ...WEEK_APPEND,
    seed: () => ({
      'spaces/s1': space({ judges: ['m1'] }),
      'spaces/s1/weeks/W': { ...weekDoc('active', M8), judges: ['m1'] },
      'spaces/s1/weeks/W/plans/m8': { tasks: full.slice(0, 24), added: { [full[23]!.id]: ts(Date.now() - HOUR) }, updatedAt: ts(Date.now() - HOUR) },
    }),
    run: (db) => {
      const fs = db('m8')
      return runTransaction(fs, async (tx) => {
        const snap = await tx.get(doc(fs, 'spaces/s1/weeks/W/plans/m8'))
        tx.set(doc(fs, 'spaces/s1/weeks/W/plans/m8'), {
          tasks: [...snap.get('tasks'), full[24]], added: { ...snap.get('added'), [full[24]!.id]: serverTimestamp() }, updatedAt: serverTimestamp(),
        })
      })
    },
  },
  {
    name: 'monthly plan, 25 × 8, batched with syncsPeriod',
    ...MONTHLY_PLAN,
    seed: () => ({ 'spaces/s1': space({ judges: ['m1'] }), [`spaces/s1/monthly/${M2}`]: monthlyDoc('planning', M8.slice(0, 7), ['m1']) }),
    run: (db) => {
      const fs = db('m8')
      const b = writeBatch(fs)
      b.update(doc(fs, `spaces/s1/monthly/${M2}`), { members: arrayUnion('m8'), judges: ['m1'] })
      b.set(doc(fs, `spaces/s1/monthly/${M2}/plans/m8`), { tasks: full, updatedAt: serverTimestamp() })
      return b.commit()
    },
  },
  {
    name: 'validNewWeek, own times, judges, a note, 8 members',
    ...WEEK_CREATE,
    seed: () => ({
      'spaces/s1': space({ schedule: CUSTOM, judges: ['m1', 'm2'], scheduleNote: { by: 'm1', at: ts(Date.now() - 30 * DAY), fromWeek: NEXT, before: USUAL } }),
    }),
    run: (db) => setDoc(doc(db('m3'), `spaces/s1/weeks/${NEXT}`), weekOn(M8, NEXT, ZONE, CUSTOM, { judges: ['m1', 'm2'] })),
  },
  {
    name: 'retimesWeek, 8 members (last in the week chain)',
    ...WEEK_UPDATE,
    seed: () => ({ 'spaces/s1': space({ schedule: LATER, judges: ['m1'] }), [`spaces/s1/weeks/${NEXT}`]: weekOn(M8, NEXT, ZONE, USUAL, { judges: ['m1'] }) }),
    run: (db) => {
      const w = weekOn([], NEXT, ZONE, LATER)
      return updateDoc(doc(db('m2'), `spaces/s1/weeks/${NEXT}`), { lockAt: w.lockAt, reviewOpenAt: w.reviewOpenAt, deadlineAt: w.deadlineAt, schedule: LATER })
    },
  },
  {
    name: 'syncsPeriod on a week, 8 members',
    ...WEEK_UPDATE,
    seed: () => ({ 'spaces/s1': space({ judges: ['m1', 'm2'] }), 'spaces/s1/weeks/W': { ...weekDoc('planning', M8.slice(0, 7)), judges: ['m1'] } }),
    run: (db) => updateDoc(doc(db('m3'), 'spaces/s1/weeks/W'), { members: arrayUnion('m8'), judges: ['m1', 'm2'] }),
  },
  {
    name: 'setsSchedule (space chain)',
    ...SPACE,
    seed: () => ({ 'spaces/s1': space() }),
    run: (db) => updateDoc(doc(db('m1'), 'spaces/s1'), { schedule: CUSTOM, scheduleNote: { by: 'm1', at: serverTimestamp(), fromWeek: NEXT, before: USUAL } }),
  },
  {
    name: 'validNewMonthly, 8 members, judges (moved clock)',
    ...MONTHLY_CREATE,
    movedClock: true,
    seed: () => {
      const list = monthlyOn('2026-12', ZONE, CUSTOM, M8, ['m1'])
      return { 'spaces/s1': space({ schedule: CUSTOM, judges: ['m1'], utcOffsetMin: 60, testNow: ts(list.startAt.toMillis() - DAY) }) }
    },
    run: (db) => setDoc(doc(db('m2'), 'spaces/s1/monthly/2026-12'), monthlyOn('2026-12', ZONE, CUSTOM, M8, ['m1'])),
  },
  {
    name: 'retimesMonthly with both weeks stored',
    ...MONTHLY_UPDATE,
    seed: () => {
      const W = monthWeeks(M2)
      return {
        'spaces/s1': space({ schedule: CUSTOM }),
        [`spaces/s1/monthly/${M2}`]: monthlyOn(M2, ZONE, USUAL, M8),
        [`spaces/s1/weeks/${W.lock}`]: weekOn(M8, W.lock, ZONE, CUSTOM),
        [`spaces/s1/weeks/${W.last}`]: weekOn(M8, W.last, ZONE, CUSTOM),
      }
    },
    run: (db) => {
      const W = monthWeeks(M2)
      const lock = weekOn(M8, W.lock, ZONE, CUSTOM)
      const last = weekOn(M8, W.last, ZONE, CUSTOM)
      return updateDoc(doc(db('m2'), `spaces/s1/monthly/${M2}`), { lockAt: lock.lockAt, reviewOpenAt: last.reviewOpenAt, deadlineAt: last.deadlineAt })
    },
  },
  {
    name: 'finalizesPause, 8 members (last in the space chain)',
    ...SPACE,
    // m8 left after the lock; m9 joined after it. The others all said OK.
    seed: () => ({
      'spaces/s1': spaceDoc([...M8.slice(0, 7), 'm9'], {
        leftAt: { m8: ts(Date.now() - HOUR) },
        pause: { weekId: '2026-11-23', by: 'm1', at: ts(Date.now() - DAY), oks: M8.slice(0, 7) },
        paused: { '2026-10': '2026-10-19' },
      }),
      'spaces/s1/weeks/2026-11-23': weekDoc('active', M8),
    }),
    run: (db) => updateDoc(doc(db('m9'), 'spaces/s1'), { 'paused.2026-11': '2026-11-23' }),
  },
  {
    name: 'declinesPause: Not Now, 8 members (reads the week)',
    ...SPACE,
    seed: () => ({
      'spaces/s1': space({ pause: { weekId: '2026-11-23', by: 'm1', at: ts(Date.now() - DAY), oks: M8.slice(0, 7) } }),
      'spaces/s1/weeks/2026-11-23': weekDoc('active', M8),
    }),
    run: (db) => updateDoc(doc(db('m8'), 'spaces/s1'), { 'pause.declinedBy': 'm8' }),
  },
  {
    name: 'asksToPause after a lapsed request, 8 members',
    ...SPACE,
    seed: () => ({
      'spaces/s1': space({ pause: { weekId: '2026-11-16', by: 'm2', at: ts(Date.now() - 3 * DAY), oks: ['m2', 'm3'] } }),
      'spaces/s1/weeks/2026-11-16': weekDoc('review', M8),
      'spaces/s1/weeks/2026-11-23': weekDoc('planning', M8),
    }),
    run: (db) => updateDoc(doc(db('m1'), 'spaces/s1'), { pause: { weekId: '2026-11-23', by: 'm1', at: serverTimestamp(), oks: ['m1'] } }),
  },
  {
    name: 'stakes create: 7 per, 5 tiers',
    ...STAKES_CREATE,
    seed: () => ({ 'spaces/s1': space() }),
    run: (db) => setDoc(doc(db('m1'), 'spaces/s1/stakes/m1'), { ...eachStakes(), updatedAt: serverTimestamp() }),
  },
  {
    name: 'stakes owner edit: 7 per, 5 tiers, 7 × 6 agreements',
    ...STAKES_UPDATE,
    seed: () => ({
      'spaces/s1': space(),
      'spaces/s1/stakes/m1': { ...eachStakes('F'), agreed: Object.fromEntries(M8.slice(1).map((f) => [f, sixAgreements(f)])) },
    }),
    run: (db) => updateDoc(doc(db('m1'), 'spaces/s1/stakes/m1'), { per: per7, tiers: tiers5.slice(0, 4).concat([{ months: 36, reward: 'X' }]), updatedAt: serverTimestamp() }),
  },
  {
    name: 'Agree, the 6th (drops the oldest), per friend, 5 tiers',
    ...STAKES_UPDATE,
    seed: () => ({ 'spaces/s1': space(), 'spaces/s1/stakes/m1': { ...eachStakes('G'), agreed: { m2: sixAgreements('m2') } } }),
    run: (db) => {
      const old = sixAgreements('m2')
      return updateDoc(doc(db('m2'), 'spaces/s1/stakes/m1'), {
        'agreed.m2': { at: serverTimestamp(), terms: termsOf(eachStakes('G'), 'm2'), past: [...old.past.slice(1), { ...old.terms, at: old.at }] },
      })
    },
  },
  {
    name: 'months create, with its last week and list stored',
    ...MONTHS_CREATE,
    seed: () => ({
      'spaces/s1': space(),
      [lastWeekPath(C)]: weekEnding(Date.now() - 2 * HOUR),
      [`spaces/s1/monthly/${C}`]: { ...weekEnding(Date.now() - 2 * HOUR), judges: [] },
    }),
    run: (db) => setDoc(doc(db('m2'), `spaces/s1/months/${C}`), { reward: 'Dinner on me', penalty: 'You buy coffee for a week', createdAt: serverTimestamp() }),
  },
  {
    name: 'months re-freeze of an early freeze',
    ...MONTHS_UPDATE,
    seed: () => ({
      'spaces/s1': space(),
      [lastWeekPath(C)]: weekEnding(Date.now() - 2 * HOUR),
      [`spaces/s1/monthly/${C}`]: { ...weekEnding(Date.now() - 2 * HOUR), judges: [] },
      [`spaces/s1/months/${C}`]: { reward: 'Old', penalty: 'Old', createdAt: ts(Date.now() - 20 * DAY) },
    }),
    run: (db) => setDoc(doc(db('m2'), `spaces/s1/months/${C}`), { reward: 'Dinner on me', penalty: 'You buy coffee for a week', createdAt: serverTimestamp() }),
  },
  {
    name: 'owner\'s house-stakes edit: space op of the batch',
    ...SPACE,
    // Both months complete, each with its last week and monthly list stored: the most the edit reads.
    seed: () => ({
      'spaces/s1': space(),
      'invites/ABCD2345': { spaceId: 's1', spaceName: 'Film crew', reward: 'Dinner on me', penalty: 'You buy coffee for a week', inviterName: 'M', createdBy: 'm1', createdAt: ts(Date.now() - DAY) },
      [lastWeekPath(C)]: weekEnding(Date.now() - 2 * HOUR),
      [`spaces/s1/monthly/${C}`]: { ...weekEnding(Date.now() - 2 * HOUR), judges: [] },
      [lastWeekPath(P)]: weekEnding(Date.now() - 20 * DAY),
      [`spaces/s1/monthly/${P}`]: { ...weekEnding(Date.now() - 20 * DAY), judges: [] },
    }),
    run: (db) => {
      const fs = db('m1')
      const b = writeBatch(fs)
      for (const m of [P, C]) b.set(doc(fs, `spaces/s1/months/${m}`), { reward: 'Dinner on me', penalty: 'You buy coffee for a week', createdAt: serverTimestamp() })
      b.update(doc(fs, 'spaces/s1'), { reward: 'R'.repeat(120), penalty: 'P'.repeat(120), stakesNote: { by: 'm1', at: serverTimestamp() } })
      b.update(doc(fs, 'invites/ABCD2345'), { reward: 'R'.repeat(120), penalty: 'P'.repeat(120) })
      return b.commit()
    },
  },
  {
    name: 'monthly review, 25 marks, in a 7-review submit',
    ...MONTHLY_REVIEW,
    seed: () => ({ 'spaces/s1': space(), [`spaces/s1/monthly/${C}`]: monthlyDoc('review', M8) }),
    run: (db) => {
      const fs = db('m1')
      const b = writeBatch(fs)
      for (const r of M8.slice(1)) b.set(doc(fs, `spaces/s1/monthly/${C}/reviews/m1_${r}`), { reviewerId: 'm1', revieweeId: r, marks: marks25, submittedAt: serverTimestamp() })
      b.update(doc(fs, `spaces/s1/monthly/${C}`), { submittedBy: arrayUnion('m1') })
      return b.commit()
    },
  },
  {
    name: 'setJudge: the space and four unlocked periods in one transaction (space op)',
    ...SPACE,
    seed: () => ({
      'spaces/s1': space({ judges: ['m1'] }),
      'spaces/s1/weeks/W1': { ...weekDoc('planning', M8), judges: ['m1'] },
      'spaces/s1/weeks/W2': { ...weekDoc('planning', M8), judges: ['m1'] },
      [`spaces/s1/monthly/${M2}`]: monthlyDoc('planning', M8, ['m1']),
      [`spaces/s1/monthly/${M3}`]: monthlyDoc('planning', M8, ['m1']),
    }),
    run: (db) => {
      const fs = db('m2')
      return runTransaction(fs, async (tx) => {
        await tx.get(doc(fs, 'spaces/s1'))
        tx.update(doc(fs, 'spaces/s1'), { judges: ['m1', 'm2'] })
        for (const p of ['weeks/W1', 'weeks/W2', `monthly/${M2}`, `monthly/${M3}`]) tx.update(doc(fs, `spaces/s1/${p}`), { judges: ['m1', 'm2'] })
      })
    },
  },
  {
    name: 'settlement, one of a group line of 7',
    ...SETTLE,
    seed: () => ({ 'spaces/s1': space({ leftAt: { m9: ts(Date.now() - DAY) } }) }),
    run: (db) => {
      const fs = db('m1')
      const b = writeBatch(fs)
      for (const o of M8.slice(1)) b.set(doc(fs, `spaces/s1/settlements/${C}_m1_${o}_s36`), { monthId: C, uid: 'm1', other: o, tier: 36, settled: true, settledBy: 'm1', settledAt: serverTimestamp() })
      return b.commit()
    },
  },
]

describe('worst cases fit the limits', () => {
  for (const c of CASES.filter((x) => !x.movedClock)) {
    test(c.name, async () => {
      await seed(c.seed())
      await allowed(c.run(db))
    })
  }

  test('the owner\'s schedule change: the space, two weeks and two monthly lists in one transaction', async () => {
    await seed({
      'spaces/s1': space(),
      [`spaces/s1/weeks/${NEXT}`]: weekOn(M8, NEXT, ZONE),
      [`spaces/s1/weeks/${AFTER}`]: weekOn(M8, AFTER, ZONE),
      [`spaces/s1/monthly/${M2}`]: monthlyOn(M2, ZONE, USUAL, M8),
      [`spaces/s1/monthly/${M3}`]: monthlyOn(M3, ZONE, USUAL, M8),
    })
    const fs = db('m1')
    await allowed(runTransaction(fs, async (tx) => {
      await tx.get(doc(fs, 'spaces/s1'))
      tx.update(doc(fs, 'spaces/s1'), { schedule: LATER, scheduleNote: { by: 'm1', at: serverTimestamp(), fromWeek: NEXT, before: USUAL } })
      for (const w of [NEXT, AFTER]) {
        const b = weekOn([], w, ZONE, LATER)
        tx.update(doc(fs, `spaces/s1/weeks/${w}`), { lockAt: b.lockAt, reviewOpenAt: b.reviewOpenAt, deadlineAt: b.deadlineAt, schedule: LATER })
      }
      for (const m of [M2, M3]) {
        const l = monthlyOn(m, ZONE, LATER, M8)
        tx.update(doc(fs, `spaces/s1/monthly/${m}`), { lockAt: l.lockAt, reviewOpenAt: l.reviewOpenAt, deadlineAt: l.deadlineAt })
      }
    }))
  })
})

// ---------- measuring (opt-in: MEASURE=<output file>) ----------

/** k cheap terms, about 5.2 expressions each, split so no single expression is too complex. */
function padFns(k: number): string {
  if (k === 0) return 'function pad(x) { return true; }'
  const groups = Math.ceil(k / 10)
  const fns = Array.from({ length: groups }, (_, g) => `function pg${g}(x) { return ${Array.from({ length: Math.min(10, k - g * 10) }, () => 'x == 1').join(' && ')}; }`)
  const mains: string[] = []
  for (let i = 0; i < groups; i += 10) mains.push(`function pm${i}(x) { return ${Array.from({ length: Math.min(10, groups - i) }, (_, j) => `pg${i + j}(x)`).join(' && ')}; }`)
  return [...fns, ...mains, `function pad(x) { return ${mains.map((_, i) => `pm${i * 10}(x)`).join(' && ')}; }`].join('\n')
}
/** k reads of distinct missing documents. */
const apadFn = (k: number) =>
  `function apad() { return ${k === 0 ? 'true' : Array.from({ length: k }, (_, i) => `!exists(/databases/$(database)/documents/zzpad/a${i})`).join(' && ')}; }`

function padded(c: Pick<Case, 'point' | 'padded' | 'movedClock'>, terms: number, reads: number): string {
  const base = c.movedClock ? movedClock(PUBLISHED_RULES) : PUBLISHED_RULES
  if (base.split(c.point).length !== 2) throw new Error(`injection point not unique: ${c.point}`)
  return base
    .replace('match /databases/{database}/documents {', `match /databases/{database}/documents {\n${padFns(terms)}\n${apadFn(reads)}\nmatch /zzcal/{id} { allow write: if pad(1); }`)
    .replace(c.point, c.padded)
}

async function passes(c: Case, terms: number, reads: number): Promise<boolean> {
  if (!(await loadRules(padded(c, terms, reads)))) return false
  await clear()
  await seed(c.seed())
  try {
    await c.run(db)
    return true
  } catch {
    return false
  }
}

/** The largest k in [0, hi) for which `ok(k)` holds, assuming it holds for 0. */
async function largest(ok: (k: number) => Promise<boolean>, hi: number): Promise<number> {
  let lo = 0
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (await ok(mid)) lo = mid
    else hi = mid
  }
  return lo
}

describe.runIf(process.env.MEASURE)('measure headroom', () => {
  test('every case', { timeout: 1_800_000 }, async () => {
    const calibrate: Case = {
      name: 'a pad alone', point: '__none__', padded: '', seed: () => ({}),
      run: (fs) => setDoc(doc(fs('m1'), 'zzcal/x'), { a: 1 }),
    }
    const calTerms = await largest(async (k) => {
      if (!(await loadRules(padded({ ...calibrate, point: 'match /public/config {', padded: 'match /public/config {' }, k, 0)))) return false
      await clear()
      try {
        await calibrate.run(db)
        return true
      } catch {
        return false
      }
    }, 260)
    const perTerm = 1000 / calTerms
    const rows: Array<Record<string, unknown>> = [{ calibration: `${calTerms} terms fill the limit: ${perTerm.toFixed(2)} expressions per term` }]
    const only = process.env.MEASURE_ONLY
    for (const c of CASES.filter((x) => !only || x.name.includes(only))) {
      expect(await passes(c, 0, 0), `${c.name} fails unpadded`).toBe(true)
      const terms = await largest((k) => passes(c, k, 0), 200)
      const reads = await largest((k) => passes(c, 0, k), 11)
      rows.push({ case: c.name, headroom: Math.round(terms * perTerm), used: 1000 - Math.round(terms * perTerm), extraReads: reads })
    }
    await loadRules(PUBLISHED_RULES)
    writeFileSync(process.env.MEASURE!, JSON.stringify(rows, null, 2))
  })
})
