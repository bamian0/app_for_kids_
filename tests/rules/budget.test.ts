// The rules' worst cases against Firestore's limits (SPEC §9.9, §10.7): at most 1000 expressions per
// request, and at most 10 document reads per request (20 for a batch or transaction). Each case below
// must pass against the published rules.
//
// Measured headroom: `MEASURE=<out.json> npx firebase emulators:exec --only firestore --project
// demo-stakes "npx vitest run --config vitest.rules.config.ts tests/rules/budget.test.ts -t 'every case'"`
// re-runs each case with k cheap terms appended to the condition that allows it, and the largest k
// that still passes is its headroom (a term is 5.24 expressions: 191 of them alone fill the limit, so
// a change of a few expressions may not show); then likewise with k reads of missing docs (tried up to
// 10). MEASURE_ONLY=<regex> measures only the cases whose names match. Measured 2026-10-14 (emulator of
// firebase-tools 15.33), the plan, append, cross-out and review rows again on 2026-10-17 for batch 2.5,
// and the plan and cross-out rows on 2026-10-18 after the reason's blank test became one regex (unchanged).
// Spare reads of a batch can differ by one between runs of the same rules (the plan rows: 9 or 10):
//
//   case                                                       used   headroom   spare reads
//   week plan, 25 × 8, batched with the week fill               895      105        9-10   (unchanged, also
//     at the finer steps of the guard at the end of this file)
//   week append, the 25th full task, old client's set, no log   325      675           8   (was 304)
//   week append, the 25th full task, 120-entry log (update)     325      675           8
//   week cross-out: 5th change of the 25th of 25 × 8 tasks,     482      518           8
//     124 log entries, a 120-character reason
//   monthly plan, 25 × 8, batched with syncsPeriod              895      105        9-10   (one `||` more
//     than its batch-2 rule, so now exactly a week plan's cost)
//   monthly append, the 25th full task, 120-entry log           325      675           8
//   monthly cross-out, as the week's                            482      518           8
//   validNewWeek: own times, judges, a note, 8 members          450      550           9
//   retimesWeek, 8 members (last in the week chain)             534      466           9
//   syncsPeriod on a week, 8 members                            157      843           9
//   setsSchedule (8th in the space chain)                       555      445          10   (2026-10-20: the
//     live batch-2.5 rules measure 555 too; 550 was an earlier run)
//   validNewMonthly, 8 members, judges (moved clock)            461      539           9
//   retimesMonthly with both weeks stored                       513      487           7
//   finalizesPause, 8 members (last in the space chain)         649      351           9   (2026-10-17)
//   declinesPause: Not Now, 8 members (reads the week)          602      398           9   (2026-10-17)
//   asksToPause after a lapsed request, 8 members               660      340           8   (2026-10-17)
//   an owner who judges leaves 8 members, keeping the join time 408      592          10   (2026-10-17)
//   the owner removes a judge of 8, keeping the join time       366      634          10   (2026-10-17)
//   stakes create: 7 per, 5 streak rewards                      832      168           9
//   stakes owner edit: 7 per, 5 streaks, 7 × 6 agreements       838      162           9
//   Agree, the 6th (drops the oldest), per friend, 5 streaks    335      665           9
//   months create, its last week and list stored                288      712           7
//   months re-freeze of an early freeze                         319      681           7
//   owner's house-stakes edit, the space op (2 freezes)         702      298          10
//   weekly review, 25 marks (one 'fair'), of a 7-review submit  487      513           9   ('fair' in the
//   monthly review, 25 marks (one 'fair'), of a 7-review submit 487      513           9   list: ~2, < 1 term)
//   setJudge, the space op of space + 4 periods                 283      717          10
//   settlement, one of a group line of 7                        241      759           9
//
// Batch 3 (SPEC §11.5), measured 2026-10-20 and again on 2026-10-21 with the final rules (goal names and
// units checked against trim()'s characters, shows(): +5 on create and edit); every row above re-measured
// the same both days (batch 3 only adds match blocks and functions that existing requests never call; the
// house-stakes row's spare reads came out 8 once and 10 on a re-run). Each must stay under 500 and 8
// reads (SPEC §11.5); the first showcase row is the exception (see its note):
//   friend request (create, reads the other's profile)          147      853           9
//   friend accept / decline / withdraw / re-ask / take over     79 / 110 / 105 / 136 / 152    10
//   pair delete by the asker after deleting their profile        63      937           9
//   showcase, 12 achieved + 8 goals + earnings, all three new   812      188          10   (a crafted write
//     only: the app's sync sends each changed list in its own update and a switch changes one list, so
//     no app write checks more than one list; bounded by the list caps, so no data can push it further)
//   showcase sync: 12 achieved changed, the others as stored    482      518          10   (only changed
//   showcase switch (stats off) with every list stored          131      869          10    lists are checked)
//   ring get by a friend / stats get (shown)                   58 / 52                 9
//   shared goal create, 7 invitees (about 26 each)              476      524           3   (7 reads)
//   check-in batch: the check-in op, an edit / a first one    236 / 225               10
//   check-in batch: the goal op (checksIn, 1st branch)          230      770           9   (get and getAfter
//     of the same check-in count as one read)
//   join, the 8th member (2nd branch)                           157      843          10
//   invite 7 friends (4th branch)                               440      560           3   (7 reads)
//   the owner leaves a goal of 8 (5th branch)                   377      623          10   (2026-10-21, review
//     fix: the leaver's zone goes too; it was 356)
//   the last member deletes the goal with 52 check-ins: the     21 / 52   979 / 948  10 / 9   (one read of the
//     goal op / a check-in op (one transaction)                                                goal for all 53)
//   a former member deletes a check-in after leaving             42      958           9
//   the owner edits, reaching the target (6th branch)           309      691          10
//   the owner finishes a goal (the last branch)                 246      754          10
//   a week's check-ins query, 8 docs                             26      974          10
//
// The plan path keeps canPlan's judge check: its headroom (105) is above the 40 SPEC §9.4 asks for.
// The plan rules try the whole list, then an append, then a cross-out (SPEC §10.7), so a cross-out
// pays for both branches before it; that order keeps the whole-list save at 895 (guarded at the end
// of this file, also at a finer step). Don't reorder them to make cross-outs cheaper, and keep them
// as A || (B || C): a flat A || B || C costs every whole-list save one expression more.
// "moved clock": validNewMonthly can't run on real time on most days, so it is measured on the
// calendar.test.ts variant, which costs a little more than the published rule.
import { describe, expect, test } from 'vitest'
import { writeFileSync } from 'node:fs'
import {
  arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, FieldPath, getDoc, getDocs, query, runTransaction, serverTimestamp, setDoc,
  updateDoc, where, writeBatch, type DocumentData, type Firestore,
} from 'firebase/firestore'
import {
  addMonths, allowed, CUSTOM, DAY, fullTask, goalDoc, GOAL_ZONE, HOUR, mondayOf, monthlyDoc, monthlyOn, monthStr, monthWeeks, movedClock,
  newGoalDoc, offsetNow, pairEntry, profileDoc, PUBLISHED_RULES, spaceDoc, ts, useRulesEnv, USUAL, weekDoc, weekOfClock, weekOn, type Schedule,
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
const ids = full.map((t) => t.id as string)
/** 25 marks with 64-character keys, the first a fair vote on a crossed-out task (SPEC §10.4). */
const marks25: Record<string, number | string> = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`t${i}`.padEnd(64, 'x'), i === 0 ? 'fair' : 0.5]))
/** A cross-out log (SPEC §10.3): entries 1…upto for each task id, with 120-character reasons. */
const cancelLog = (taskIds: string[], upto: number): DocumentData => {
  const out: DocumentData = {}
  const at = ts(Date.now() - HOUR)
  for (const id of taskIds) for (let n = 1; n <= upto; n++) out[`${n}:${id}`] = n % 2 ? { at, why: 'W'.repeat(120) } : { at }
  return out
}
/** What addTaskAfterLock and addMonthlyTaskAfterLock write once a plan exists: an update. */
const appendUpdate = (fs: Firestore, path: string, task: DocumentData) =>
  runTransaction(fs, async (tx) => {
    const snap = await tx.get(doc(fs, path))
    tx.update(doc(fs, path), { tasks: [...snap.get('tasks'), task], added: { ...snap.get('added'), [task.id]: serverTimestamp() }, updatedAt: serverTimestamp() })
  })
/** What crossOutTask writes: one log entry and updatedAt. */
const crossOut = (fs: Firestore, path: string, key: string, why: string) =>
  updateDoc(doc(fs, path), new FieldPath('cancels', key), { at: serverTimestamp(), why }, 'updatedAt', serverTimestamp())
/** A full 25 × 8 plan whose last task was added after the lock and changed 4 times: 124 log entries. */
const fullPlanWithLog = (): DocumentData => ({
  tasks: full, added: { [ids[24]!]: ts(Date.now() - HOUR) }, cancels: { ...cancelLog(ids.slice(0, 24), 5), ...cancelLog([ids[24]!], 4) },
  updatedAt: ts(Date.now() - HOUR),
})
/** 24 full tasks, the last added after the lock, each crossed out for good: 120 log entries. */
const listOf24WithLog = (): DocumentData => ({
  tasks: full.slice(0, 24), added: { [ids[23]!]: ts(Date.now() - HOUR) }, cancels: cancelLog(ids.slice(0, 24), 5), updatedAt: ts(Date.now() - HOUR),
})

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
const SPACE = atEnd('|| declinesPause() || finalizesPause() || marksDeals());')
const WEEK_UPDATE = atEnd('|| retimesWeek(spaceId, weekId));')
const WEEK_CREATE = atEnd('validNewWeek(spaceId, weekId, incoming());')
/** Pads the whole-list branch of a plan rule (the first of three, SPEC §10.7). */
const planBranch = (next: string) => ({
  point: `&& incoming().updatedAt == request.time)\n            || ${next}`,
  padded: `&& incoming().updatedAt == request.time && pad(1) && apad())\n            || ${next}`,
})
const WEEK_PLAN = planBranch("(appendsTask(spaceId, 'weeks', weekId, uid, 0)")
/** appendsTask is shared by weeks and monthly lists, and so is togglesCancel. */
const APPEND = atEnd('&& d.added[t.id] == request.time;')
/** The end of togglesCancel: the reason's class (WHY_BLANK) closes its last check. */
const TOGGLE = { point: "{e0fff}].*'));", padded: "{e0fff}].*')) && pad(1) && apad();" }
const WEEK_REVIEW = atEnd("validReview(spaceId, 'weeks', weekId, rid);")
const MONTHLY_UPDATE = atEnd('|| retimesMonthly(spaceId, monthId));')
const MONTHLY_CREATE = atEnd('validNewMonthly(spaceId, monthId, incoming());')
const MONTHLY_PLAN = planBranch("(appendsTask(spaceId, 'monthly', monthId, uid, 1)")
const MONTHLY_REVIEW = atEnd("validReview(spaceId, 'monthly', monthId, rid);")
const STAKES_CREATE = atEnd('&& incoming().agreed == {};')
const STAKES_UPDATE = atEnd('(editsOwnStakes(spaceId, uid) || agreesToStakes(spaceId, uid));')
const MONTHS_CREATE = atEnd('allow create: if isMember(spaceId) && validMonthStakes(spaceId, monthId, false);')
const MONTHS_UPDATE = atEnd('allow update: if isMember(spaceId) && validMonthStakes(spaceId, monthId, true);')
const SETTLE = atEnd('allow create, update: if signedIn() && validSettlement(spaceId, sid);')
// batch 3 (SPEC §11.5): the end of the condition, or of the branch, that allows each op.
const FRIEND_ASK = atEnd('allow create: if signedIn() && asksFriend(pid);')
const FRIEND_ACCEPT = atEnd("&& changedOnly(['state', 'at']) && d.state == 'friends' && d.at == request.time;")
const FRIEND_DECLINE = atEnd("&& changedOnly(['state']) && d.state == 'declined';")
const FRIEND_WITHDRAW = atEnd("&& changedOnly(['state', 'at']) && d.state == 'withdrawn' && d.at == request.time;")
const FRIEND_REASK = atEnd("&& changedOnly(['state', 'at']) && d.state == 'asked' && d.at == request.time;")
const FRIEND_TAKEOVER = atEnd("&& changedOnly(['by', 'state', 'at']) && d.by == me && d.state == 'asked' && d.at == request.time;")
const FRIEND_DELETE = atEnd('|| !exists(/databases/$(database)/documents/users/$(request.auth.uid)));')
const SHOWCASE = atEnd('allow create: if isUser(uid) && validShowcase(incoming(), incoming().keys());')
const SHOWCASE_UPDATE = atEnd('allow update: if isUser(uid) && validShowcase(incoming(), incoming().diff(existing()).affectedKeys());')
const RING = atEnd('allow get: if isUser(uid) || (signedIn() && areFriends(uid, request.auth.uid));')
const STATS = atEnd('allow get: if isUser(uid) || (signedIn() && statsShown(uid));')
const GOAL_CREATE = atEnd('allow create: if signedIn() && createsShared(goalId);')
const CHECKIN_CREATE = atEnd('allow create: if signedIn() && checkinFits(goalId, cid);')
const CHECKIN_UPDATE = atEnd('allow update: if signedIn() && existing().weekId == incoming().weekId && checkinFits(goalId, cid);')
const CHECKS_IN = atEnd('&& d.total100 == e.total100 + delta\n        && reachesRule(e, d);')
const JOIN = atEnd('&& d.zones.diff(e.zones).affectedKeys().hasOnly([me]) && isZone(d.zones[me]);')
const INVITE = atEnd('&& invitesFriends(me, added);')
const LEAVE = atEnd('&& (me == e.ownerId ? earliestJoined(d) : d.ownerId == e.ownerId));')
const EDIT = atEnd('&& validGoalText(d) && reachesRule(e, d);')
const FINISH = atEnd('&& d.archivedAt == request.time && d.invited == [];')
const CHECKINS_READ = atEnd('allow read: if signedIn() && request.auth.uid in get(goalPath(goalId)).data.memberIds;')
const GOAL_DELETE = atEnd('allow delete: if signedIn() && existing().memberIds == [request.auth.uid];')
// deals (SPEC §12.7): the whole condition that allows each op (an update pays for the branches before its own).
const DEAL_CREATE = atEnd('allow create: if signedIn() && newDeal(id);')
const DEAL_UPDATE = atEnd('allow update: if signedIn() && (agreesToDeal() || withdrawsDeal() || callsOffDeal() || settlesDeal());')
const CHECKIN_DELETE = atEnd('&& (!(request.auth.uid in get(goalPath(goalId)).data.memberIds) || !existsAfter(goalPath(goalId)));')

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

// ---------- batch 3 fixtures ----------
const B3W = weekOfClock(Date.now(), offsetNow(GOAL_ZONE))
const profiles = (uids: string[]): Record<string, DocumentData> => Object.fromEntries(uids.map((u) => [`users/${u}`, profileDoc(u)]))
const pairs = (...entries: Array<[string, DocumentData]>): Record<string, DocumentData> => Object.fromEntries(entries)
const pairPath = 'friends/m1_m2'
/** A goal of 8 (m1 owns it, joined in order), 99 of 100 km counted, m8's check-in of this week 1 km. */
const goal8 = (extra: DocumentData = {}) => goalDoc({
  name: 'Ж'.repeat(60), unit: 'U'.repeat(16), endsOn: '2099-12-31', ownerId: 'm1', createdBy: 'm1', memberIds: M8, invited: [],
  joinedAt: Object.fromEntries(M8.map((u, i) => [u, ts(Date.now() - (30 - i) * DAY)])),
  zones: Object.fromEntries(M8.map((u) => [u, 'America/Argentina/Buenos_Aires'])),
  leftAt: { x1: ts(Date.now() - DAY) },
  totals100: Object.fromEntries(M8.map((u) => [u, u === 'm8' ? 1300 : 1200])), total100: 9700, last: { by: 'm7', weekId: B3W, at: ts(Date.now() - HOUR) },
  ...extra,
})
/** m8 edits this week's check-in from 1 km to 4 km (past the target) with an 80-character note: the app's transaction. */
const editCheckin = (fs: Firestore) => runTransaction(fs, async (tx) => {
  await tx.get(doc(fs, 'sharedGoals/g1'))
  await tx.get(doc(fs, `sharedGoals/g1/checkins/${B3W}_m8`))
  tx.set(doc(fs, `sharedGoals/g1/checkins/${B3W}_m8`), { uid: 'm8', weekId: B3W, amount100: 400, note: 'Ж'.repeat(80), at: serverTimestamp() })
  tx.update(doc(fs, 'sharedGoals/g1'), { 'totals100.m8': 1600, total100: 10_000, reachedAt: serverTimestamp(), last: { by: 'm8', weekId: B3W, at: serverTimestamp() } })
})
const goal8WithCheckin = () => ({
  'sharedGoals/g1': goal8(),
  [`sharedGoals/g1/checkins/${B3W}_m8`]: { uid: 'm8', weekId: B3W, amount100: 100, note: 'N'.repeat(80), at: ts(Date.now() - HOUR) },
})
/** 52 weekly check-ins of `uid`'s, the newest this week. */
const yearOfCheckins = (uid: string): Record<string, DocumentData> =>
  Object.fromEntries(Array.from({ length: 52 }, (_, i) => {
    const w = new Date(Date.parse(`${B3W}T00:00:00Z`) - i * 7 * DAY).toISOString().slice(0, 10)
    return [`sharedGoals/g1/checkins/${w}_${uid}`, { uid, weekId: w, amount100: 100, note: 'N'.repeat(80), at: ts(Date.now() - (i * 7 + 1) * DAY) }]
  }))
/** m1, the last member of a goal 7 others have left, with a year of check-ins and 7 invitations. */
const lastMemberWithAYear = () => ({
  'sharedGoals/g1': goal8({ memberIds: ['m1'], joinedAt: { m1: ts(Date.now() - 400 * DAY) }, invited: ['i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8'], leftAt: Object.fromEntries(M8.slice(1).map((u) => [u, ts(Date.now() - DAY)])) }),
  ...yearOfCheckins('m1'),
})
/** What leaveGoal does for the last member: their check-ins and the goal in one transaction. */
const deleteLastGoal = (fs: Firestore) => runTransaction(fs, async (tx) => {
  await tx.get(doc(fs, 'sharedGoals/g1'))
  for (const id of Object.keys(yearOfCheckins('m1'))) tx.delete(doc(fs, id))
  tx.delete(doc(fs, 'sharedGoals/g1'))
})
/** 12 achieved goals and 8 goals with 60-character names (fixed times, so a rewrite leaves them unchanged). */
const SHOWN_ACHIEVED = Array.from({ length: 12 }, (_, i) => ({ name: `${'Ж'.repeat(57)}${String(i).padStart(3, '0')}`, at: ts(T0 - (i + 1) * DAY) }))
const SHOWN_GOALS = Array.from({ length: 8 }, (_, i) => ({ name: `${'Ж'.repeat(59)}${i}`, pct: i * 14 }))
const showAll = () => ({
  show: { stats: true, achieved: true, goals: true, earnings: true },
  achieved: SHOWN_ACHIEVED,
  goals: SHOWN_GOALS,
  earnings: { monthId: '2026-09', amount: 999_999_999.99, currency: 'USD' },
  updatedAt: serverTimestamp(),
})

// ---------- deals fixtures (SPEC §12) ----------
const F7 = M8.slice(1)
/** m1's deal number `seq` with the 7 others, both lines per friend with 120-character texts: the worst case. */
const dealOf7 = (seq: number, extra: DocumentData = {}): DocumentData => ({
  uid: 'm1', seq, unit: 'month', count: 12, rewardMode: 'each', penaltyMode: 'each', reward: 'R'.repeat(120), penalty: 'P'.repeat(120),
  per: per7, friends: F7, agreed: {}, off: {}, settled: {}, createdAt: serverTimestamp(), ended: null, ...extra,
})
const storedDealOf7 = (seq: number, extra: DocumentData = {}): DocumentData => ({ ...dealOf7(seq), createdAt: ts(Date.now() - 40 * DAY), ...extra })
const agreedBy = (uids: string[]): DocumentData => Object.fromEntries(uids.map((u, i) => [u, ts(Date.now() - (39 - i) * DAY)]))
const DEAL_STAMPS = { agreedAt: ts(Date.now() - 33 * DAY), start: '2026-11', track: [{ id: '2026-11', result: 'pass', score: 95.5, missed: 1 }] }
/** 8 members, a stale judges entry (so `judges` is read and subtracted), deals on. */
const dealSpace = (extra: DocumentData = {}) => space({ hasDeals: true, judges: ['x9'], ...extra })
const PAUSE_IN_PLAY = { pause: { weekId: '2026-11-23', by: 'm2', at: ts(Date.now() - DAY), oks: ['m2', 'm3'] }, paused: { '2026-10': '2026-10-19' } }
/** proposeDeal's Edit of a space that lacks the flag: re-read the space and m1's deals 1 and 2, withdraw the
 *  waiting deal 1, create deal 2 and set the flag, in one transaction. */
const editDeal = (fs: Firestore) => runTransaction(fs, async (tx) => {
  await tx.get(doc(fs, 'spaces/s1'))
  await tx.get(doc(fs, 'spaces/s1/deals/m1_1'))
  await tx.get(doc(fs, 'spaces/s1/deals/m1_2'))
  tx.update(doc(fs, 'spaces/s1/deals/m1_1'), { ended: { outcome: 'withdrawn', at: serverTimestamp(), by: 'm1' } })
  tx.set(doc(fs, 'spaces/s1/deals/m1_2'), dealOf7(2))
  tx.update(doc(fs, 'spaces/s1'), { hasDeals: true })
})
/** The Edit's worst case: no flag yet, a pause request in play, deal 1 waiting on the 7th friend. */
const editSeed = () => ({
  'spaces/s1': space({ judges: ['x9'], ...PAUSE_IN_PLAY }),
  'spaces/s1/weeks/2026-11-23': weekDoc('planning', M8),
  'spaces/s1/deals/m1_1': storedDealOf7(1, { agreed: agreedBy(F7.slice(0, 6)) }),
})
/** A together line of 7 (settleDeal): every pair in one update. */
const settle7 = (fs: Firestore) => {
  const [first, ...rest] = F7.flatMap((f) => [new FieldPath('settled', f), { settled: true, by: 'm1', at: serverTimestamp() }])
  return updateDoc(doc(fs, 'spaces/s1/deals/m1_1'), first as FieldPath, rest[0], ...rest.slice(1))
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
    name: 'week append after the lock: the 25th full task (old client: a set, no log)',
    ...APPEND,
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
    name: 'week append, the 25th full task, with a 120-entry log (an update)',
    ...APPEND,
    seed: () => ({
      'spaces/s1': space({ judges: ['m1'] }),
      'spaces/s1/weeks/W': { ...weekDoc('active', M8), judges: ['m1'] },
      'spaces/s1/weeks/W/plans/m8': listOf24WithLog(),
    }),
    run: (db) => appendUpdate(db('m8'), 'spaces/s1/weeks/W/plans/m8', full[24]!),
  },
  {
    name: 'week cross-out: the 5th change of the 25th task, 25 × 8, 124 entries, a 120-character reason',
    ...TOGGLE,
    seed: () => ({
      'spaces/s1': space({ judges: ['m1'] }),
      'spaces/s1/weeks/W': { ...weekDoc('active', M8), judges: ['m1'] },
      'spaces/s1/weeks/W/plans/m8': fullPlanWithLog(),
    }),
    run: (db) => crossOut(db('m8'), 'spaces/s1/weeks/W/plans/m8', `5:${ids[24]}`, 'Ж'.repeat(120)),
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
    name: 'monthly append, the 25th full task, with a 120-entry log',
    ...APPEND,
    seed: () => ({
      'spaces/s1': space({ judges: ['m1'] }),
      [`spaces/s1/monthly/${C}`]: monthlyDoc('active', M8, ['m1']),
      [`spaces/s1/monthly/${C}/plans/m8`]: listOf24WithLog(),
    }),
    run: (db) => appendUpdate(db('m8'), `spaces/s1/monthly/${C}/plans/m8`, full[24]!),
  },
  {
    name: 'monthly cross-out: the 5th change of the 25th task, 25 × 8, 124 entries, a 120-character reason',
    ...TOGGLE,
    seed: () => ({
      'spaces/s1': space({ judges: ['m1'] }),
      [`spaces/s1/monthly/${C}`]: monthlyDoc('active', M8, ['m1']),
      [`spaces/s1/monthly/${C}/plans/m8`]: fullPlanWithLog(),
    }),
    run: (db) => crossOut(db('m8'), `spaces/s1/monthly/${C}/plans/m8`, `5:${ids[24]}`, 'Ж'.repeat(120)),
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
    name: 'an owner who judges leaves 8 members, keeping the join time',
    ...atEnd('&& (uid == e.ownerId && d.memberIds.size() > 0 ? earliestJoined(d) : d.ownerId == e.ownerId);'),
    seed: () => ({ 'spaces/s1': space({ judges: ['m1'], leftAt: { x: ts(Date.now() - DAY) }, formerJoinedAt: { x: ts(Date.now() - 9 * DAY) } }) }),
    run: async (db) => {
      const ref = doc(db('m1'), 'spaces/s1')
      const joined = (await getDoc(ref)).get('joinedAt.m1')
      return updateDoc(ref, {
        memberIds: arrayRemove('m1'), 'joinedAt.m1': deleteField(), 'leftAt.m1': serverTimestamp(), judges: arrayRemove('m1'),
        ownerId: 'm2', 'formerJoinedAt.m1': joined,
      })
    },
  },
  {
    name: 'the owner removes a judge of 8 members, keeping the join time',
    ...atEnd('&& keepsJoinTime(removed[0]);'),
    seed: () => ({ 'spaces/s1': space({ judges: ['m8'], leftAt: { x: ts(Date.now() - DAY) }, formerJoinedAt: { x: ts(Date.now() - 9 * DAY) } }) }),
    run: async (db) => {
      const ref = doc(db('m1'), 'spaces/s1')
      const joined = (await getDoc(ref)).get('joinedAt.m8')
      return updateDoc(ref, {
        memberIds: arrayRemove('m8'), 'joinedAt.m8': deleteField(), 'leftAt.m8': serverTimestamp(), judges: arrayRemove('m8'),
        'formerJoinedAt.m8': joined,
      })
    },
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
    name: 'weekly review, 25 marks (one fair), in a 7-review submit',
    ...WEEK_REVIEW,
    seed: () => ({ 'spaces/s1': space(), 'spaces/s1/weeks/W': weekDoc('review', M8) }),
    run: (db) => {
      const fs = db('m1')
      const b = writeBatch(fs)
      for (const r of M8.slice(1)) b.set(doc(fs, `spaces/s1/weeks/W/reviews/m1_${r}`), { reviewerId: 'm1', revieweeId: r, marks: marks25, submittedAt: serverTimestamp() })
      b.update(doc(fs, 'spaces/s1/weeks/W'), { submittedBy: arrayUnion('m1') })
      return b.commit()
    },
  },
  {
    name: 'monthly review, 25 marks (one fair), in a 7-review submit',
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
  // ---------- batch 3 (SPEC §11.5) ----------
  {
    name: 'b3: friend request (create)',
    ...FRIEND_ASK,
    seed: () => profiles(['m1', 'm2']),
    run: (db) => setDoc(doc(db('m2'), pairPath), { users: ['m1', 'm2'], by: 'm2', state: 'asked', at: serverTimestamp() }),
  },
  {
    name: 'b3: friend accept (of a declined request)',
    ...FRIEND_ACCEPT,
    seed: () => ({ ...profiles(['m1', 'm2']), ...pairs(pairEntry('m1', 'm2', 'declined', 'm1', 1)) }),
    run: (db) => updateDoc(doc(db('m2'), pairPath), { state: 'friends', at: serverTimestamp() }),
  },
  {
    name: 'b3: friend decline',
    ...FRIEND_DECLINE,
    seed: () => ({ ...profiles(['m1', 'm2']), ...pairs(pairEntry('m1', 'm2', 'asked', 'm1', 1)) }),
    run: (db) => updateDoc(doc(db('m2'), pairPath), { state: 'declined' }),
  },
  {
    name: 'b3: friend withdraw (cancel)',
    ...FRIEND_WITHDRAW,
    seed: () => ({ ...profiles(['m1', 'm2']), ...pairs(pairEntry('m1', 'm2', 'declined', 'm1', 1)) }),
    run: (db) => updateDoc(doc(db('m1'), pairPath), { state: 'withdrawn', at: serverTimestamp() }),
  },
  {
    name: 'b3: friend re-ask after 31 days',
    ...FRIEND_REASK,
    seed: () => ({ ...profiles(['m1', 'm2']), ...pairs(pairEntry('m1', 'm2', 'withdrawn', 'm1', 31)) }),
    run: (db) => updateDoc(doc(db('m1'), pairPath), { state: 'asked', at: serverTimestamp() }),
  },
  {
    name: 'b3: friend take over (the last of five)',
    ...FRIEND_TAKEOVER,
    seed: () => ({ ...profiles(['m1', 'm2']), ...pairs(pairEntry('m1', 'm2', 'withdrawn', 'm1', 1)) }),
    run: (db) => updateDoc(doc(db('m2'), pairPath), { by: 'm2', state: 'asked', at: serverTimestamp() }),
  },
  {
    name: 'b3: pair delete by the asker after deleting their profile',
    ...FRIEND_DELETE,
    seed: () => ({ ...profiles(['m2']), ...pairs(pairEntry('m1', 'm2', 'withdrawn', 'm1', 1)) }),
    run: (db) => deleteDoc(doc(db('m1'), pairPath)),
  },
  {
    name: 'b3: showcase with 12 achieved, 8 goals, earnings (all three new)',
    ...SHOWCASE,
    seed: () => ({}),
    run: (db) => setDoc(doc(db('m1'), 'showcases/m1'), showAll()),
  },
  {
    name: 'b3: showcase sync, 12 achieved changed, 8 goals and earnings as stored',
    ...SHOWCASE_UPDATE,
    seed: () => ({ 'showcases/m1': { ...showAll(), achieved: [], updatedAt: ts(Date.now() - DAY) } }),
    run: (db) => updateDoc(doc(db('m1'), 'showcases/m1'), { achieved: showAll().achieved, updatedAt: serverTimestamp() }),
  },
  {
    name: 'b3: showcase switch (stats off) with every list stored',
    ...SHOWCASE_UPDATE,
    seed: () => ({ 'showcases/m1': { ...showAll(), updatedAt: ts(Date.now() - DAY) } }),
    run: (db) => setDoc(doc(db('m1'), 'showcases/m1'), { ...showAll(), show: { stats: false, achieved: true, goals: true, earnings: true } }),
  },
  {
    name: 'b3: ring get by a friend',
    ...RING,
    seed: () => ({ ...pairs(pairEntry('m1', 'm2')), 'rings/m1': { monthId: '2026-10', score: 92.5, final: false, spaces: 2, updatedAt: ts(Date.now() - HOUR) } }),
    run: (db) => getDoc(doc(db('m2'), 'rings/m1')),
  },
  {
    name: 'b3: stats get (shown)',
    ...STATS,
    seed: () => ({
      'showcases/m1': { show: { stats: true, achieved: false, goals: false, earnings: false }, updatedAt: ts(Date.now() - HOUR) },
      'stats/m1': { monthsCleared: 1, currentStreak: 1, bestStreak: 1, weeksPlayed: 7, finishedMonths: 1, since: '2026-10', updatedAt: ts(Date.now() - HOUR) },
    }),
    run: (db) => getDoc(doc(db('zz'), 'stats/m1')),
  },
  {
    name: 'b3: shared goal create with 7 invitees',
    ...GOAL_CREATE,
    seed: () => pairs(...M8.slice(1).map((u) => pairEntry('m1', u))),
    run: (db) => setDoc(doc(db('m1'), 'sharedGoals/Xk3p9QmZ2aBcD4eF5gH6aBcD4eF5gH6Xk3p9QmZA'), newGoalDoc('m1', M8.slice(1), {
      name: 'Ж'.repeat(60), unit: 'U'.repeat(16), endsOn: '2099-12-31', timezone: 'America/Argentina/Buenos_Aires', zones: { m1: 'America/Argentina/Buenos_Aires' },
    })),
  },
  {
    name: 'b3: check-in batch, the check-in op (an edit that reaches the target)',
    ...CHECKIN_UPDATE,
    seed: goal8WithCheckin,
    run: (db) => editCheckin(db('m8')),
  },
  {
    name: 'b3: check-in batch, the check-in op (a first check-in)',
    ...CHECKIN_CREATE,
    seed: () => ({ 'sharedGoals/g1': goal8() }),
    run: (db) => {
      const fs = db('m8')
      const b = writeBatch(fs)
      b.set(doc(fs, `sharedGoals/g1/checkins/${B3W}_m8`), { uid: 'm8', weekId: B3W, amount100: 300, note: 'Ж'.repeat(80), at: serverTimestamp() })
      b.update(doc(fs, 'sharedGoals/g1'), { 'totals100.m8': 1600, total100: 10_000, reachedAt: serverTimestamp(), last: { by: 'm8', weekId: B3W, at: serverTimestamp() } })
      return b.commit()
    },
  },
  {
    name: 'b3: check-in batch, the goal op (checksIn, an edit that reaches the target)',
    ...CHECKS_IN,
    seed: goal8WithCheckin,
    run: (db) => editCheckin(db('m8')),
  },
  {
    name: 'b3: join, the 8th member (2nd branch)',
    ...JOIN,
    seed: () => ({ 'sharedGoals/g1': goal8({ memberIds: M8.slice(0, 7), invited: ['m8'], zones: { m1: GOAL_ZONE }, joinedAt: Object.fromEntries(M8.slice(0, 7).map((u) => [u, ts(Date.now() - DAY)])) }) }),
    run: (db) => updateDoc(doc(db('m8'), 'sharedGoals/g1'), { invited: arrayRemove('m8'), memberIds: arrayUnion('m8'), 'joinedAt.m8': serverTimestamp(), 'zones.m8': 'America/Argentina/Buenos_Aires' }),
  },
  {
    name: 'b3: invite 7 friends (4th branch)',
    ...INVITE,
    seed: () => ({ ...pairs(...M8.slice(1).map((u) => pairEntry('m1', u))), 'sharedGoals/g1': goal8({ memberIds: ['m1'], joinedAt: { m1: ts(Date.now() - DAY) } }) }),
    run: (db) => updateDoc(doc(db('m1'), 'sharedGoals/g1'), { invited: M8.slice(1) }),
  },
  {
    name: 'b3: the owner leaves a goal of 8 (5th branch)',
    ...LEAVE,
    seed: () => ({ 'sharedGoals/g1': goal8() }),
    run: (db) => updateDoc(doc(db('m1'), 'sharedGoals/g1'), { memberIds: arrayRemove('m1'), 'joinedAt.m1': deleteField(), 'leftAt.m1': serverTimestamp(), 'zones.m1': deleteField(), ownerId: 'm2' }),
  },
  {
    name: 'b3: the last member deletes the goal with a year of check-ins, the goal op',
    ...GOAL_DELETE,
    seed: lastMemberWithAYear,
    run: (db) => deleteLastGoal(db('m1')),
  },
  {
    name: 'b3: the last member deletes the goal with a year of check-ins, a check-in op',
    ...CHECKIN_DELETE,
    seed: lastMemberWithAYear,
    run: (db) => deleteLastGoal(db('m1')),
  },
  {
    name: 'b3: a former member deletes a check-in after leaving',
    ...CHECKIN_DELETE,
    seed: () => ({ 'sharedGoals/g1': goal8({ memberIds: M8.slice(1), leftAt: { m1: ts(Date.now() - HOUR) } }), ...yearOfCheckins('m1') }),
    run: (db) => deleteDoc(doc(db('m1'), `sharedGoals/g1/checkins/${B3W}_m1`)),
  },
  {
    name: 'b3: the owner edits, reaching the target (6th branch)',
    ...EDIT,
    seed: () => ({ 'sharedGoals/g1': goal8() }),
    run: (db) => updateDoc(doc(db('m1'), 'sharedGoals/g1'), { name: 'Ж'.repeat(59) + 'x', unit: 'V'.repeat(16), target100: 9700, endsOn: '2099-12-30', reachedAt: serverTimestamp() }),
  },
  {
    name: 'b3: the owner finishes a goal (the last branch)',
    ...FINISH,
    seed: () => ({ 'sharedGoals/g1': goal8({ memberIds: M8.slice(0, 1), invited: M8.slice(1) }) }),
    run: (db) => updateDoc(doc(db('m1'), 'sharedGoals/g1'), { archivedAt: serverTimestamp(), invited: [] }),
  },
  {
    name: 'b3: a week\'s check-ins query (8 docs)',
    ...CHECKINS_READ,
    seed: () => ({
      'sharedGoals/g1': goal8(),
      ...Object.fromEntries(M8.map((u) => [`sharedGoals/g1/checkins/${B3W}_${u}`, { uid: u, weekId: B3W, amount100: 100, note: 'N'.repeat(80), at: ts(Date.now() - HOUR) }])),
    }),
    run: async (db) => {
      const snap = await getDocs(query(collection(db('m1'), 'sharedGoals/g1/checkins'), where('weekId', '==', B3W)))
      if (snap.size !== 8) throw new Error(`expected 8 check-ins, got ${snap.size}`)
    },
  },
  // ---------- deals (SPEC §12.7) ----------
  {
    name: 'deals: create, 7 friends, both lines per friend, after an ended deal (getAfter)',
    ...DEAL_CREATE,
    seed: () => ({ 'spaces/s1': dealSpace(), 'spaces/s1/deals/m1_1': storedDealOf7(1, { agreed: agreedBy(F7), ...DEAL_STAMPS, ended: { outcome: 'lost', at: ts(Date.now() - DAY), period: '2026-11', score: 88 } }) }),
    run: (db) => setDoc(doc(db('m1'), 'spaces/s1/deals/m1_2'), dealOf7(2)),
  },
  {
    name: 'deals: Edit (withdraw + create + flag in one transaction), the create op',
    ...DEAL_CREATE,
    seed: editSeed,
    run: (db) => editDeal(db('m1')),
  },
  {
    name: 'deals: Edit (withdraw + create + flag in one transaction), the withdraw op',
    ...DEAL_UPDATE,
    seed: editSeed,
    run: (db) => editDeal(db('m1')),
  },
  {
    name: 'deals: Edit (withdraw + create + flag in one transaction), the flag op',
    ...SPACE,
    seed: editSeed,
    run: (db) => editDeal(db('m1')),
  },
  {
    name: 'deals: marksDeals, the owner, 8 members, a pause request in play (last in the space chain)',
    ...SPACE,
    seed: () => ({
      'spaces/s1': space({ judges: ['m8'], leftAt: { x: ts(Date.now() - DAY) }, formerJoinedAt: { x: ts(Date.now() - 9 * DAY) }, ...PAUSE_IN_PLAY }),
      'spaces/s1/weeks/2026-11-23': weekDoc('planning', M8),
    }),
    run: (db) => updateDoc(doc(db('m1'), 'spaces/s1'), { hasDeals: true }),
  },
  {
    name: 'deals: Agree, the 7th friend, 8 members (1st branch)',
    ...DEAL_UPDATE,
    seed: () => ({ 'spaces/s1': dealSpace(), 'spaces/s1/deals/m1_1': storedDealOf7(1, { agreed: agreedBy(F7.slice(0, 6)) }) }),
    run: (db) => updateDoc(doc(db('m8'), 'spaces/s1/deals/m1_1'), new FieldPath('agreed', 'm8'), serverTimestamp()),
  },
  {
    name: 'deals: Withdraw, 6 of 7 agreed, 8 members (2nd branch)',
    ...DEAL_UPDATE,
    seed: () => ({ 'spaces/s1': dealSpace(), 'spaces/s1/deals/m1_1': storedDealOf7(1, { agreed: agreedBy(F7.slice(0, 6)) }) }),
    run: (db) => updateDoc(doc(db('m1'), 'spaces/s1/deals/m1_1'), { ended: { outcome: 'withdrawn', at: serverTimestamp(), by: 'm1' } }),
  },
  {
    name: 'deals: Call Off, the 8th tap, 8 members (3rd branch)',
    ...DEAL_UPDATE,
    seed: () => ({
      'spaces/s1': dealSpace(),
      'spaces/s1/deals/m1_1': storedDealOf7(1, { agreed: agreedBy(F7), ...DEAL_STAMPS, off: agreedBy(['m1', ...F7.slice(0, 6)]) }),
    }),
    run: (db) => updateDoc(doc(db('m8'), 'spaces/s1/deals/m1_1'), new FieldPath('off', 'm8'), serverTimestamp()),
  },
  {
    name: 'deals: settle a together line of 7 in one write (4th branch)',
    ...DEAL_UPDATE,
    seed: () => ({
      'spaces/s1': dealSpace(),
      'spaces/s1/deals/m1_1': storedDealOf7(1, { agreed: agreedBy(F7), ...DEAL_STAMPS, ended: { outcome: 'won', at: ts(Date.now() - DAY), period: '2026-12' } }),
    }),
    run: (db) => settle7(db('m1')),
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

/** `steps` + 1 `true`s: each step is about 3 expressions, a finer unit than a term (the guard below). */
const fpadFn = (steps: number) => `function fpad() { return ${Array.from({ length: steps + 1 }, () => 'true').join(' && ')}; }`

/** The published rules with the pads in `c`'s condition: `terms` terms, `reads` reads and, when
 *  `steps` is given, `&& fpad()` with that many steps too. */
function padded(c: Pick<Case, 'point' | 'padded' | 'movedClock'>, terms: number, reads: number, steps?: number): string {
  const base = c.movedClock ? movedClock(PUBLISHED_RULES) : PUBLISHED_RULES
  if (base.split(c.point).length !== 2) throw new Error(`injection point not unique: ${c.point}`)
  const fine = steps === undefined ? '' : `\n${fpadFn(steps)}`
  return base
    .replace('match /databases/{database}/documents {', `match /databases/{database}/documents {\n${padFns(terms)}\n${apadFn(reads)}${fine}\nmatch /zzcal/{id} { allow write: if pad(1); }`)
    .replace(c.point, steps === undefined ? c.padded : c.padded.replace('&& apad()', '&& apad() && fpad()'))
}

async function passes(c: Case, terms: number, reads: number, steps?: number): Promise<boolean> {
  if (!(await loadRules(padded(c, terms, reads, steps)))) return false
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
    // MEASURE_ONLY: a regular expression over the case names (e.g. 'plan|cross-out').
    const only = process.env.MEASURE_ONLY ? new RegExp(process.env.MEASURE_ONLY) : null
    for (const c of CASES.filter((x) => !only || only.test(x.name))) {
      expect(await passes(c, 0, 0), `${c.name} fails unpadded`).toBe(true)
      const terms = await largest((k) => passes(c, k, 0), 200)
      const reads = await largest((k) => passes(c, 0, k), 11)
      rows.push({ case: c.name, headroom: Math.round(terms * perTerm), used: 1000 - Math.round(terms * perTerm), extraReads: reads })
    }
    await loadRules(PUBLISHED_RULES)
    writeFileSync(process.env.MEASURE!, JSON.stringify(rows, null, 2))
  })
})

// SPEC §10.7: the whole-list saves must cost what they did before appends kept the cross-out log and
// cross-outs existed (895, so the 20 pad terms of their measured 105 of headroom still fit). Terms are
// coarse (5.24 expressions), so the finer check pads with 17 terms and 4 steps (about 3 expressions
// each): that is the most a 25 × 8 week plan took under the batch-2 rules, measured on 2026-10-17
// (firebase-tools 15.33) with 17 terms and 5 steps failing, and a monthly plan with the third branch
// now costs the same (one `||` more than its batch-2 rule had). One expression more on the whole-list
// branch, e.g. a flat A || B || C instead of A || (B || C), fails the finer check. If one of these
// fails, a change made every plan save more expensive: put new checks in the later branches (append,
// cross-out), never in front of the whole-list branch. (After an emulator upgrade, re-measure first.)
describe('the whole-list saves keep their measured headroom', () => {
  const MEASURED_TERMS = 20
  const FINE = { terms: 17, steps: 4 }
  for (const name of ['week plan, 25 × 8, batched with the week fill', 'monthly plan, 25 × 8, batched with syncsPeriod']) {
    test(name, async () => {
      const c = CASES.find((x) => x.name === name)!
      try {
        expect(await passes(c, MEASURED_TERMS, 0), `${name} with ${MEASURED_TERMS} pad terms`).toBe(true)
        expect(await passes(c, FINE.terms, 0, FINE.steps), `${name} with ${FINE.terms} pad terms and ${FINE.steps} steps`).toBe(true)
      } finally {
        await loadRules(PUBLISHED_RULES)
      }
    })
  }
})
