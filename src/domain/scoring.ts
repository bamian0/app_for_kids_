// Weekly and monthly scoring. See docs/SPEC.md §1 for the rules, §9.6 for judges, pauses and monthly lists.
import { isWeekPaused } from './pause.ts'
import { boundsFor } from './schedule.ts'
import type { Mark, MonthId, MonthlyData, MonthlyList, Plan, Progress, Review, Space, Task, UID, Week, WeekData, WeekId } from './types.ts'
import type { WeekBounds, WeekPhase } from './time.ts'
import { monthlyBounds, weekIdsInMonth, weekPhase } from './time.ts'

export interface TaskResult {
  taskId: string
  title: string
  /** 0..1, the value that counts toward the score. */
  mark: number
  /** Where `mark` came from: friends' reviews, or the member's own check-off (nobody reviewed). */
  source: 'reviews' | 'self'
  reviewerMarks: Record<UID, Mark>
  /** Every step is ticked (a task without steps: its own check-off). */
  selfDone: boolean
  /** The task's steps with their check-offs; [] for a task without steps. */
  subtasks: { id: string; title: string; done: boolean }[]
  /** 0..1, the self mark: share of steps ticked, or 1/0 for a task without steps. */
  selfFraction: number
  /** Copied from Task.addedAt: set on a task added after the lock. */
  addedAt?: number
}

export interface MemberWeekResult {
  uid: UID
  participating: boolean
  taskCount: number
  tasks: TaskResult[]
  /** 0..100 from self check-offs; shown before reveal, labelled provisional. null if not participating. */
  provisionalScore: number | null
  /** 0..100 once revealed; null before reveal or if not participating. */
  score: number | null
  /** Reviewers who submitted a review of this member (visible to the current user). */
  reviewedBy: UID[]
  /** After deadlineAt: members with ≥1 task this member failed to review. Empty before. */
  missedReviewsOf: UID[]
  hasSubmitted: boolean
  /** Batch 2 (§9.4): rates only this period: no tasks, no score (score and provisionalScore are null), never a
   *  review target; `missedReviewsOf` still lists whom they didn't review ("Didn't review"), never a penalty.
   *  Optional in the type (absent = false); the domain always sets it. */
  judge?: boolean
}

export interface WeekResult {
  /** The week's id; for a monthly list (computeMonthly), its MonthId. */
  weekId: WeekId
  phase: WeekPhase
  revealed: boolean
  members: Record<UID, MemberWeekResult>
  /** Batch 2 (§9.3): the week is paused: every score is null and nobody misses a review. Screens check it first.
   *  Optional in the type (absent = false); the domain always sets it. */
  paused?: boolean
  /** Batch 2 (§9.4): who judges the period (judgesOf). Optional in the type (absent = []); always set. */
  judges?: UID[]
}

/** One week of a member's month: a week they played (or a paused one, flagged). */
export interface MonthWeekEntry {
  weekId: WeekId
  score: number | null
  closed: boolean
  /** The week was paused: listed, never averaged (§9.3). */
  paused?: true
}

/** A member's monthly list in their month (§9.5): only when they had ≥ 1 task at its lock. */
export interface MonthlyEntry {
  score: number | null
  closed: boolean
  taskCount: number
}

export interface MemberMonthResult {
  uid: UID
  monthId: MonthId
  /** Took part in a week of this month but is no longer a space member. */
  former: boolean
  /** Everyone else who took part in a week of this month (current or former members): who owes
   *  this member the reward, or whom this member owes the penalty. */
  others: UID[]
  /** The weeks they played, plus paused weeks they were in (flagged `paused`). Weeks they judged are in `judged`. */
  weeks: MonthWeekEntry[]
  /** Mean of closed participating weeks (and the closed monthly list, and 0 per closed judged week in a month
   *  they also played); null if none. */
  average: number | null
  missedReviews: number
  penaltyPoints: number
  /** max(0, average − penaltyPoints); null if average is null. */
  finalScore: number | null
  /** now ≥ monthEndsAt (the last week's stored deadline, or the monthly list's if later). */
  complete: boolean
  /** finalScore ≥ threshold once complete; null until complete or if finalScore is null. */
  passed: boolean | null
  // Batch 2 (§9.6): optional in the type (absent = [] / null / false / 0); the domain always sets them.
  /** Weeks they judged (not paused), in order. In a month they also play, each closed one averages as 0. */
  judged?: WeekId[]
  /** Their monthly list when they had ≥ 1 task at its lock; else null. */
  monthly?: MonthlyEntry | null
  /** They judged the month's lists. */
  monthlyJudge?: boolean
  /** Reviews they skipped while judging (weeks and the monthly list): shown as "Didn't review", never subtracted. */
  skippedAsJudge?: number
}

/** Self marks add up in 840ths (every step count up to 8 divides it), so sums of step fractions stay
 *  exact and a week without steps scores the very same float as before. */
const SELF_UNITS = 840

/** Keeps the ≥ threshold check from failing on float error in means of thirds, sevenths, etc. */
const SCORE_EPSILON = 1e-9

/** Rounds away float error (means of thirds, sevenths…) so a score that is 90 reads as exactly 90 everywhere. */
function normalise(score: number): number {
  return Math.round(score * 1e9) / 1e9
}

type RevealWeek = { members: UID[]; submittedBy: UID[]; deadlineAt: number }

/**
 * Revealed when every week member has submitted, or at deadlineAt, as in the rules. Everyone in
 * `members` counts, including anyone who left the space after lock: the lock is a commitment, so
 * leaving can't reveal the week early, and since a leaver can't submit any more the deadline reveals
 * it. Leaving before lock already took them out of `members`.
 */
export function isRevealed(week: RevealWeek, nowMs: number): boolean
/** @deprecated The third argument is ignored: every week member counts (see above). Drop it. */
export function isRevealed(week: RevealWeek, nowMs: number, memberIds: UID[]): boolean
export function isRevealed(week: RevealWeek, nowMs: number): boolean {
  if (nowMs >= week.deadlineAt) return true
  return week.members.every((uid) => week.submittedBy.includes(uid))
}

/**
 * The participants who count for a week that locks at `lockAt`: everyone who was in the space when
 * the week locked, whether or not they have left since. That is the current members, except anyone
 * who left before lockAt and rejoined after it, plus anyone who left at or after lockAt. Leaving or
 * being removed after lock changes nothing: they stay a review target, their score counts toward the
 * month, and others who skip reviewing them lose points. Someone who left before lock and came back
 * after it is nobody's review target, so rejoining never rewrites a week that has locked. Pass the
 * week's stored lockAt.
 */
export function membersAt(space: Pick<Space, 'memberIds' | 'leftAt'> & Partial<Pick<Space, 'joinedAt'>>, lockAt: number): UID[] {
  const leftAt = space.leftAt ?? {}
  const joinedAt = space.joinedAt ?? {}
  // Only someone who left before the lock and came back after it doesn't count. A member who never
  // left counts whatever their joinedAt says (being in the week means they were in when it locked).
  const current = space.memberIds.filter((uid) => !(leftAt[uid] < lockAt && joinedAt[uid] >= lockAt))
  const leftLater = Object.entries(leftAt).flatMap(([uid, at]) => (at >= lockAt && !space.memberIds.includes(uid) ? [uid] : []))
  return [...current, ...leftLater]
}

/** True when `uid` joined the space at or after the week's lockAt, so the week started without them
 *  (as opposed to a member who simply has no tasks). */
export function joinedAfterLock(space: Pick<Space, 'joinedAt'>, uid: UID, lockAt: number): boolean {
  const joined = space.joinedAt[uid]
  return joined !== undefined && joined >= lockAt
}

/** How many of the task's check-offs are ticked: its steps, or the task itself when it has none. */
function checkOffs(task: Task, done: Record<string, boolean>): { ticked: number; of: number } {
  const steps = task.subtasks ?? []
  if (steps.length === 0) return { ticked: done[task.id] === true ? 1 : 0, of: 1 }
  return { ticked: steps.filter((step) => done[step.id] === true).length, of: steps.length }
}

/**
 * The member's own check-off as a fraction: the share of steps ticked for a task with steps (its own
 * `done` key is ignored then), else 1 if ticked and 0 if not.
 */
export function taskSelfFraction(task: Task, done: Record<string, boolean>): number {
  const c = checkOffs(task, done)
  return c.ticked / c.of
}

/** Done by the member's own check-off: ticked, or every step ticked. */
export function isTaskDone(task: Task, done: Record<string, boolean>): boolean {
  return taskSelfFraction(task, done) === 1
}

/** True for a task appended after the week locked (SPEC §6.2). Pass the week's stored lockAt. */
export function addedAfterLock(task: Pick<Task, 'addedAt'>, lockAt: number): boolean {
  return task.addedAt !== undefined && task.addedAt >= lockAt
}

/** Who judges a period (a week or a monthly list): its snapshot, restricted to its members. A doc from before
 *  batch 2 (no `judges`) has none. */
export function judgesOf(period: Pick<Week, 'members' | 'judges'>): UID[] {
  const members = new Set(period.members)
  return [...new Set(period.judges ?? [])].filter((uid) => members.has(uid))
}

/** The space's judges as each chose for themselves; entries of people who left are ignored. */
export function spaceJudges(space: Pick<Space, 'memberIds' | 'judges'>): UID[] {
  return [...new Set(space.judges ?? [])].filter((uid) => space.memberIds.includes(uid))
}

/** A week's or a monthly list's data, seen the same way. */
interface PeriodData {
  id: string
  period: Week | null
  plans: Record<UID, Plan>
  progress: Record<UID, Progress>
  reviews: Review[]
}

function periodOf(data: WeekData | MonthlyData): PeriodData {
  if ('monthly' in data) return { id: data.monthId, period: data.monthly, plans: data.plans, progress: data.progress, reviews: data.reviews }
  return { id: data.weekId, period: data.week, plans: data.plans, progress: data.progress, reviews: data.reviews }
}

function participantsOf(p: PeriodData): UID[] {
  return p.period ? [...new Set(p.period.members)] : []
}

function judgesIn(p: PeriodData): UID[] {
  return p.period ? judgesOf(p.period) : []
}

/** A member's list; a judge's plan (left from before they switched) is ignored. */
function tasksOf(p: PeriodData, uid: UID, judges: UID[]): Task[] {
  return judges.includes(uid) ? [] : (p.plans[uid]?.tasks ?? [])
}

function targetsOf(p: PeriodData, judges: UID[], uid: UID, memberIds?: UID[]): UID[] {
  const members = participantsOf(p)
  if (!members.includes(uid)) return []
  return members.filter((m) => m !== uid && tasksOf(p, m, judges).length > 0 && (memberIds === undefined || memberIds.includes(m)))
}

/** Members `uid` must review in a week or a monthly list: other participants with ≥1 task who, given
 *  `memberIds` (`membersAt(space, period.lockAt)`), still count for it. Someone who left after lock does. Never
 *  the period's judges (a judge's leftover plan is ignored, so nobody is charged for not reviewing a judge);
 *  a judge reviews like anyone. */
export function reviewTargets(data: WeekData | MonthlyData, uid: UID, memberIds?: UID[]): UID[] {
  const p = periodOf(data)
  return targetsOf(p, judgesIn(p), uid, memberIds)
}

function isMark(value: unknown): value is Mark {
  return value === 0 || value === 0.5 || value === 1
}

/** Reviews between two distinct participants, at most one per reviewer→reviewee pair, never of a judge. */
function validReviews(p: PeriodData, members: UID[], judges: UID[]): Review[] {
  const seen = new Set<string>()
  return p.reviews.filter((r) => {
    const key = `${r.reviewerId}_${r.revieweeId}`
    const ok =
      r.reviewerId !== r.revieweeId && members.includes(r.reviewerId) && members.includes(r.revieweeId) && !judges.includes(r.revieweeId) && !seen.has(key)
    seen.add(key)
    return ok
  })
}

function emptyResult(uid: UID): MemberWeekResult {
  return {
    uid,
    participating: false,
    taskCount: 0,
    tasks: [],
    provisionalScore: null,
    score: null,
    reviewedBy: [],
    missedReviewsOf: [],
    hasSubmitted: false,
    judge: false,
  }
}

/**
 * Scores one period. `emptyList`: what a member with no tasks scores ('zero': a week, "you committed to
 * nothing"; 'none': a monthly list, which simply doesn't exist for them). In a paused week every score is null
 * and nobody misses a review; tasks, provisional scores, submissions and the reveal are as usual.
 */
function scorePeriod(p: PeriodData, space: Space, nowMs: number, bounds: WeekBounds, paused: boolean, emptyList: 'zero' | 'none'): WeekResult {
  const period = p.period
  const counted = membersAt(space, bounds.lockAt)
  const revealed = period ? isRevealed(period, nowMs) : nowMs >= bounds.deadlineAt
  const pastDeadline = nowMs >= bounds.deadlineAt
  const members = participantsOf(p)
  const judges = judgesIn(p)
  const reviews = validReviews(p, members, judges)
  const missedBy = (uid: UID): UID[] =>
    pastDeadline && !paused
      ? targetsOf(p, judges, uid, counted).filter((target) => !reviews.some((r) => r.reviewerId === uid && r.revieweeId === target))
      : []

  const results: Record<UID, MemberWeekResult> = {}
  for (const uid of space.memberIds) results[uid] = emptyResult(uid)

  for (const uid of members) {
    const hasSubmitted = period?.submittedBy.includes(uid) ?? false
    if (judges.includes(uid)) {
      results[uid] = {
        uid,
        participating: true,
        taskCount: 0,
        tasks: [],
        provisionalScore: null,
        score: null,
        reviewedBy: [],
        missedReviewsOf: missedBy(uid),
        hasSubmitted,
        judge: true,
      }
      continue
    }
    const plan = tasksOf(p, uid, judges)
    const done = p.progress[uid]?.done ?? {}
    const received = reviews.filter((r) => r.revieweeId === uid)
    const reviewedBy = received.map((r) => r.reviewerId)
    const fromReviews = received.length > 0

    let selfUnits = 0
    let reviewMarkSum = 0
    const tasks: TaskResult[] = plan.map((task) => {
      const c = checkOffs(task, done)
      const selfMark = c.ticked / c.of
      const reviewerMarks: Record<UID, Mark> = {}
      let reviewSum = 0
      for (const r of received) {
        // A submitted review that skips a task gives it 0.
        const mark = isMark(r.marks[task.id]) ? r.marks[task.id] : 0
        reviewerMarks[r.reviewerId] = mark
        reviewSum += mark
      }
      selfUnits += (SELF_UNITS * c.ticked) / c.of
      reviewMarkSum += reviewSum
      const result: TaskResult = {
        taskId: task.id,
        title: task.title,
        mark: fromReviews ? reviewSum / received.length : selfMark,
        source: fromReviews ? 'reviews' : 'self',
        reviewerMarks,
        selfDone: selfMark === 1,
        subtasks: (task.subtasks ?? []).map((step) => ({ id: step.id, title: step.title, done: done[step.id] === true })),
        selfFraction: selfMark,
      }
      if (task.addedAt !== undefined) result.addedAt = task.addedAt
      return result
    })

    const n = plan.length
    const noList = n === 0 && emptyList === 'none'
    // Divide once (sums of half-point marks and of self units are exact) to keep float error minimal.
    const provisional = n === 0 ? 0 : (100 * selfUnits) / (n * SELF_UNITS)
    const score = n === 0 ? 0 : fromReviews ? (100 * reviewMarkSum) / (n * received.length) : provisional

    results[uid] = {
      uid,
      participating: true,
      taskCount: n,
      tasks,
      provisionalScore: noList ? null : provisional,
      score: revealed && !paused && !noList ? score : null,
      reviewedBy,
      missedReviewsOf: missedBy(uid),
      hasSubmitted,
      judge: false,
    }
  }

  return { weekId: p.id, phase: weekPhase(bounds, nowMs), revealed, members: results, paused, judges }
}

/**
 * Results for every week participant (including any who have since left the space), plus a
 * non-participating entry for each space member who is not in the week (joined after lock, or the
 * week never started). Before reveal `score` is null; `tasks[].mark` always reflects the reviews
 * visible to the caller, falling back to self check-offs. Participants who left after lock still
 * count: reviews are owed to them and they hold the reveal until the deadline (see membersAt).
 * Batch 2 (§9.6): bounds are the stored doc's, else computed on the space's schedule (boundsFor); a judge
 * (judgesOf) has no list and no score, is nobody's review target, and their skipped reviews are listed but cost
 * nothing in the month; in a paused week (isWeekPaused) every score is null and nobody misses a review.
 */
export function computeWeek(data: WeekData, space: Space, nowMs: number): WeekResult {
  return scorePeriod(periodOf(data), space, nowMs, boundsFor(space, data.weekId, data.week), isWeekPaused(space, data.weekId), 'zero')
}

/**
 * A month's list scored like a week (§9.5): `weekId` holds the monthId; who counts is
 * `membersAt(space, monthly.lockAt)`, judges are the list's snapshot; a member with no tasks has no list
 * (`taskCount: 0`, `score: null`, `provisionalScore: null`) but still reviews the others. Never paused. Without a
 * doc: no participants, phase from the computed bounds.
 */
export function computeMonthly(data: MonthlyData, space: Space, nowMs: number): WeekResult {
  const bounds = data.monthly ? boundsFor(space, data.monthId, data.monthly) : monthlyBounds(data.monthId, (w) => boundsFor(space, w))
  return scorePeriod(periodOf(data), space, nowMs, bounds, false, 'none')
}

function lastWeekOf(monthId: MonthId): WeekId {
  const weeks = weekIdsInMonth(monthId)
  return weeks[weeks.length - 1]
}

/**
 * When a month is complete (§9.6), from its last week's doc and its list when known: the later of the last
 * week's stored deadline (computed on the space's schedule without a doc) and the list's deadline. A doc or list
 * of another period is ignored.
 */
export function monthEndsAtFor(space: Pick<Space, 'timezone' | 'schedule'>, monthId: MonthId, lastWeek?: Week | null, list?: MonthlyList | null): number {
  const last = lastWeekOf(monthId)
  const deadline = boundsFor(space, last, lastWeek && lastWeek.id === last ? lastWeek : null).deadlineAt
  return list && list.id === monthId ? Math.max(deadline, list.deadlineAt) : deadline
}

/** When a month is complete: the later of its last week's stored deadline (computed without a doc) and its
 *  monthly list's deadline. */
export function monthEndsAt(space: Pick<Space, 'timezone' | 'schedule'>, monthId: MonthId, weeks: WeekData[], monthly?: MonthlyData | null): number {
  const last = lastWeekOf(monthId)
  const lastWeek = weeks.find((w) => w.weekId === last && w.week)?.week ?? null
  return monthEndsAtFor(space, monthId, lastWeek, monthly && monthly.monthId === monthId ? monthly.monthly : null)
}

/**
 * Month results for every current space member and everyone who took part in a week or the list of the month
 * (so people who left still owe or are owed for it; `former` marks them). `weeks` lists only the
 * weeks in which the member participated (weeks without a doc, or outside the month, are ignored);
 * `score` there is the revealed score, so it can be non-null before the week closes when everyone
 * submitted early. Batch 2 (§9.6): paused weeks are listed (`paused`) and never averaged; judged weeks are in
 * `judged` (their skips in `skippedAsJudge`) and, in a month the member also plays, each closed one averages as
 * 0; a closed monthly list with ≥ 1 task is one more averaged score, and missed monthly reviews cost points
 * unless the month's last week is paused; `others` = the players (a non-paused played week, or a list).
 */
export function computeMonth(space: Space, monthId: MonthId, weeks: WeekData[], nowMs: number, monthly?: MonthlyData): Record<UID, MemberMonthResult> {
  const inMonth = new Set(weekIdsInMonth(monthId))
  const computed = weeks
    .flatMap((d) => (d.week && inMonth.has(d.weekId) ? [{ weekId: d.weekId, closed: nowMs >= d.week.deadlineAt, result: computeWeek(d, space, nowMs) }] : []))
    .sort((a, b) => (a.weekId < b.weekId ? -1 : a.weekId > b.weekId ? 1 : 0))
  const list = monthly && monthly.monthId === monthId && monthly.monthly ? { data: monthly, doc: monthly.monthly } : null
  const listResult = list ? computeMonthly(list.data, space, nowMs) : null
  const listClosed = list !== null && nowMs >= list.doc.deadlineAt
  const lastWeekPaused = isWeekPaused(space, lastWeekOf(monthId))
  const complete = nowMs >= monthEndsAt(space, monthId, weeks, monthly)
  const roster = [
    ...new Set([...space.memberIds, ...computed.flatMap(({ result }) => Object.keys(result.members)), ...Object.keys(listResult?.members ?? {})]),
  ]

  const out: Record<UID, MemberMonthResult> = {}
  for (const uid of roster) {
    const entries: MonthWeekEntry[] = []
    const judged: WeekId[] = []
    const closedScores: number[] = []
    let judgedClosed = 0
    let missedReviews = 0
    let skippedAsJudge = 0
    for (const { weekId, closed, result } of computed) {
      const member = result.members[uid]
      if (!member?.participating) continue
      if (result.paused) {
        entries.push({ weekId, score: null, closed, paused: true })
        continue
      }
      if (member.judge) {
        judged.push(weekId)
        if (closed) {
          judgedClosed += 1
          skippedAsJudge += member.missedReviewsOf.length
        }
        continue
      }
      entries.push({ weekId, score: member.score, closed })
      if (closed && member.score !== null) {
        closedScores.push(member.score)
        missedReviews += member.missedReviewsOf.length
      }
    }
    let monthlyEntry: MonthlyEntry | null = null
    let monthlyJudge = false
    const inList = listResult?.members[uid]
    if (inList?.participating) {
      if (inList.judge) {
        monthlyJudge = true
        if (listClosed) skippedAsJudge += inList.missedReviewsOf.length
      } else {
        if (inList.taskCount > 0) {
          monthlyEntry = { score: inList.score, closed: listClosed, taskCount: inList.taskCount }
          // The extra week counts once the list is closed, like a week.
          if (listClosed && inList.score !== null) closedScores.push(inList.score)
        }
        // Missed monthly reviews cost points, list or not, unless the month's last week is paused.
        if (listClosed && !lastWeekPaused) missedReviews += inList.missedReviewsOf.length
      }
    }
    // Judged weeks in a month they also play count as 0%, so switching to judge can't hide bad weeks.
    const plays = entries.some((e) => !e.paused) || monthlyEntry !== null
    if (plays) for (let i = 0; i < judgedClosed; i++) closedScores.push(0)
    const average = closedScores.length > 0 ? normalise(closedScores.reduce((a, b) => a + b, 0) / closedScores.length) : null
    const penaltyPoints = space.latePenalty * missedReviews
    const finalScore = average === null ? null : normalise(Math.max(0, average - penaltyPoints))
    out[uid] = {
      uid,
      monthId,
      former: !space.memberIds.includes(uid),
      others: [],
      weeks: entries,
      average,
      missedReviews,
      penaltyPoints,
      finalScore,
      complete,
      passed: complete && finalScore !== null ? finalScore >= space.threshold - SCORE_EPSILON : null,
      judged,
      monthly: monthlyEntry,
      monthlyJudge,
      skippedAsJudge,
    }
  }
  const players = roster.filter((uid) => out[uid].weeks.some((e) => !e.paused) || out[uid].monthly)
  for (const uid of roster) out[uid].others = players.filter((id) => id !== uid)
  return out
}
