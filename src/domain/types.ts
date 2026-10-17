// Shared domain types. This file is the contract between modules (see docs/SPEC.md).
// Times are epoch milliseconds; the data layer converts Firestore Timestamps.

export type UID = string
/** Date of the week's Monday in the space timezone, 'YYYY-MM-DD'. */
export type WeekId = string
/** 'YYYY-MM' — the month a week belongs to is the month of its Friday. */
export type MonthId = string
export type Mark = 0 | 0.5 | 1

export interface UserProfile {
  uid: UID
  name: string
  /** CSS color used for the avatar. */
  color: string
  /** Profile photo: a small square JPEG as a data URL ("data:image/jpeg;base64,…", 256×256,
   *  ≤ 60,000 characters). Missing when the user has none; avatars fall back to initials. */
  photo?: string
  createdAt: number
}

export interface Space {
  id: string
  name: string
  /** What the others owe a member who reaches the threshold. */
  reward: string
  /** What a member who misses the threshold owes the others. */
  penalty: string
  ownerId: UID
  memberIds: UID[]
  joinedAt: Record<UID, number>
  /** When each former member left or was removed (the latest time, if they left more than once).
   *  Weeks that had locked by then still count them. Missing on spaces nobody has left since it existed. */
  leftAt?: Record<UID, number>
  /** A former member's join time, kept by their leave or removal (the latest stay; batch-2 apps only), so who was in
   *  the space when stakes were agreed stays known (SPEC §9.7). Absent for anyone who left before, or with an older app. */
  formerJoinedAt?: Record<UID, number>
  /** IANA timezone, fixed at creation. All deadlines use it. */
  timezone: string
  /** The zone's UTC offset in minutes when the space was created. Immutable; the rules anchor every
   *  week's timeline to it (±1h covers DST). Missing on spaces created before it existed. */
  utcOffsetMin?: number
  inviteCode: string
  /** Percent, always 90. */
  threshold: number
  /** Points subtracted from the monthly score per missed review, always 5. */
  latePenalty: number
  createdAt: number
  // ----- Batch 2 (SPEC §9); every field is optional, so spaces from before read as they always did. -----
  /** The space's own times (§9.2). Absent = the usual ones (DEFAULT_SCHEDULE in time.ts). Only the owner changes them. */
  schedule?: WeekSchedule
  /** The last change of the times, for the notice everyone else sees (§9.2). */
  scheduleNote?: ScheduleNote
  /** The one pause request in play, if any (§9.3). Its state is derived (pauseView in domain/pause.ts). */
  pause?: PauseRequest
  /** Completed pauses: the month of the week's Friday → the paused week. One per month, and final (§9.3). */
  paused?: Record<MonthId, WeekId>
  /** Members who only rate, as each chose for themselves (§9.4). Order = order of choosing. Entries of
   *  people who left are ignored (spaceJudges in scoring.ts). Absent = nobody judges. */
  judges?: UID[]
  /** The last change of the house stakes (`reward`, `penalty`), for the notice everyone else sees (§9.7).
   *  Absent until the owner changes them with a batch-2 app. */
  stakesNote?: StakesNote
}

export interface Invite {
  code: string
  spaceId: string
  spaceName: string
  /** The space's (house) stakes, mirrored so the join preview can show them before joining. Empty on old invites. */
  reward: string
  penalty: string
  inviterName: string
  createdBy: UID
  createdAt: number
}

export interface Week {
  id: WeekId
  spaceId: string
  /** Monday 00:00 local. */
  startAt: number
  /** Task lists lock. Usual times: Tuesday 00:00 local ("Monday at midnight"); else the week's `schedule`. */
  lockAt: number
  /** The review window opens. Usual times: Friday 00:00 local. */
  reviewOpenAt: number
  /** Reviews are due. Usual times: Saturday 00:00 local ("Friday at midnight"). */
  deadlineAt: number
  /** Participants: everyone who was a space member before lockAt (added whenever any member opens the
   *  app before then), minus anyone who left the space before lockAt. Leaving or being removed after
   *  lockAt keeps them in: the week still reviews and scores them. */
  members: UID[]
  /** Participants who submitted their Friday reviews. */
  submittedBy: UID[]
  /** Batch 2 (§9.2): the schedule these bounds follow. Absent = the usual one (every week from before batch 2). */
  schedule?: WeekSchedule
  /** Batch 2 (§9.4): the space's judges, kept equal to `space.judges` until lockAt, then fixed. Absent (docs
   *  from before batch 2) = nobody judges. Who judges is `judgesOf(week)` = judges ∩ members. */
  judges?: UID[]
}

/** One step of a task. Its check-off lives in Progress.done under the subtask's own id. */
export interface Subtask {
  id: string
  /** 1–120 characters, one line. */
  title: string
}

export interface Task {
  id: string
  title: string
  /** Steps that make up the task (max 8). When present, the task counts as done (self check-off) once
   *  every step is ticked; the task's own `done` key is ignored. Reviewers still mark the task itself. */
  subtasks?: Subtask[]
  /** Set only on a task added after the lock (lockAt ≤ addedAt < reviewOpenAt): server time of the
   *  append. Such a task can't be edited or removed; everyone sees when it was added. */
  addedAt?: number
}

export interface Plan {
  uid: UID
  tasks: Task[]
  updatedAt: number
}

export interface Progress {
  uid: UID
  done: Record<string, boolean>
  updatedAt: number
}

export interface Review {
  /** `${reviewerId}_${revieweeId}` */
  id: string
  reviewerId: UID
  revieweeId: UID
  marks: Record<string, Mark>
  submittedAt: number
}

/**
 * An honor-system "Settled" mark (§9.7). Three shapes, told apart by `other` and `tier`:
 * - `${monthId}_${uid}` (before batch 2, and old clients): every non-streak debt of `uid`'s month is settled;
 * - `${monthId}_${uid}_${other}`: the debt between `uid` (whose verdict made it) and `other`;
 * - `${monthId}_${uid}_${other}_s${tier}`: `other` owes `uid` the streak reward for `tier` months in a row.
 */
export interface Settlement {
  id: string
  monthId: MonthId
  /** Whose month (or streak) the debt comes from. */
  uid: UID
  /** The friend on the other side. Missing on per-member settlements from before batch 2. */
  other?: UID
  /** A streak reward: its length in months (2–36). */
  tier?: number
  settled: boolean
  settledBy: UID
  settledAt: number
}

/** One pair a "Settled" tap marks (§9.7). Doc id: settlementDocId(monthId, uid, other, tier). */
export interface SettlementKey {
  uid: UID
  other: UID
  tier?: number
}

/** Everything the current user can see about one week of one space. */
export interface WeekData {
  spaceId: string
  weekId: WeekId
  /** null until a member opens the app before the week locks (the doc is created lazily). */
  week: Week | null
  plans: Record<UID, Plan>
  progress: Record<UID, Progress>
  /** Only the reviews the current user is allowed to read (own reviews before reveal, all after). */
  reviews: Review[]
  /** The stored timeline differs from the space timezone's by more than an hour: someone created
   *  the week with skewed bounds. Screens should warn; the stored times still rule. */
  boundsMismatch?: boolean
}

/** The house stakes of one month: frozen in spaces/{id}/months/{monthId} (frozen = true), else the space's
 *  current text (frozen = false). Since batch 2 a month is frozen once it is complete, so an owner's edit
 *  counts at once for the month in progress. Months before FIRST_RESULTS_MONTH that the previous app froze
 *  at their first lock keep what they froze; from FIRST_RESULTS_MONTH on such an early freeze doesn't bind
 *  and is replaced at completion (monthHouse / freezeBinds in domain/stakes.ts decide, from `createdAt`).
 *  They count between two people who haven't agreed on their own (§9.7). */
export interface MonthStakes {
  reward: string
  penalty: string
  frozen: boolean
  /** Server time of the freeze (frozen only; a pending write reads as the SDK's estimate). */
  createdAt?: number
}

// ---------- Batch 2: times, pause, periods (SPEC §9) ----------

/**
 * When a week's lists lock, its review window opens and reviews are due, in wall-clock minutes after
 * Monday 00:00 in the space's zone. 1440 is "Monday at midnight" (the end of Monday). Ints with
 * 0 ≤ lock < reviewOpen, reviewOpen + 180 ≤ deadline ≤ 10080. The usual times are DEFAULT_SCHEDULE
 * (time.ts): { lock: 1440, reviewOpen: 5760, deadline: 7200 }.
 */
export interface WeekSchedule {
  lock: number
  reviewOpen: number
  deadline: number
}

/** The last change of a space's times (§9.2): drives the notice and the `schedule` push. */
export interface ScheduleNote {
  /** The owner who changed them. */
  by: UID
  /** Server time of the change. */
  at: number
  /** The first week on the new times when they were saved: this week, next week or the week after (the first
   *  whose lists lock at least a day away on both the old and new times, §9.2). The rules only check it's a
   *  Monday near the change. */
  fromWeek: WeekId
  /** The effective times before the change. */
  before: WeekSchedule
}

/** A request to pause one week (§9.3). Pending, declined, withdrawn, recorded or lapsed: see pauseView
 *  (domain/pause.ts). It needs an OK from everyone in the week who is still in the space. */
export interface PauseRequest {
  /** This week (until its reviews open) or next week. */
  weekId: WeekId
  /** Who asked. */
  by: UID
  /** Server time of the ask. */
  at: number
  /** Who said OK, in order; starts as [by]. */
  oks: UID[]
  /** Someone said Not Now, or the asker cancelled (declinedBy === by, "withdrawn"): the request is over.
   *  A cancelled request is kept, so the asker's 12-hour wait still holds. */
  declinedBy?: UID
}

/** A planning period: a week, or a month's list (§9.5). */
export type Period = { kind: 'week'; id: WeekId } | { kind: 'month'; id: MonthId }

/**
 * spaces/{id}/monthly/{monthId}: a month's list (§9.5). The same shape as a week, with `id` the MonthId
 * and the month's timeline: its first week's startAt, its second week's lockAt, its last week's review
 * window. `judges` is always written on these docs; `schedule` never is.
 */
export type MonthlyList = Week

/** Everything the current user can see about one month's lists (like WeekData). */
export interface MonthlyData {
  spaceId: string
  monthId: MonthId
  /** null until a member opens the app in its creation window (see ensureMonthly). */
  monthly: MonthlyList | null
  plans: Record<UID, Plan>
  progress: Record<UID, Progress>
  /** Own reviews before the reveal, everyone's after (the blind rule, as for weeks). */
  reviews: Review[]
  /** The stored timeline is more than an hour off the expected one (as WeekData.boundsMismatch). */
  boundsMismatch?: boolean
}

/** What month scores need: the month's weeks, and its monthly list once it can count. */
export interface MonthData {
  monthId: MonthId
  /** Every week of the month (weekIdsInMonth), with or without a doc. */
  weeks: WeekData[]
  /** undefined: not loaded (before the month's last week starts it can't count yet); else loaded. */
  monthly?: MonthlyData
}

// ---------- Batch 2: per-person stakes and streaks (SPEC §9.7, §9.8) ----------

/** How one line (the reward, or the penalty) works: one thing for the whole group ('group', "Same for
 *  everyone"), or a separate thing per friend ('each', "Different per friend"). Each line has its own. */
export type StakesMode = 'group' | 'each'

/** A streak reward: hit the bar `months` months in a row (2–36) and the friends owe `reward`, together. */
export interface StreakTier {
  months: number
  /** 1–120 characters. */
  reward: string
}

/** One member's stakes as they apply between them and one friend: exactly what the friend agrees to. */
export interface PairTerms {
  rewardMode: StakesMode
  penaltyMode: StakesMode
  /** What the friend owes when the member hits the bar ('group': what the friends owe together). */
  reward: string
  /** What the member owes the friend when they miss ('group': what they give the group). */
  penalty: string
  /** The member's streak rewards, ascending by months; one list for the whole group. */
  tiers: StreakTier[]
}

/** One of a friend's agreements to a member's stakes, with the server time it was made. */
export interface AgreedTerms extends PairTerms {
  at: number
}

/**
 * A friend's agreements to one member's stakes (§9.7). The current one is `terms`, made at `at` (server
 * time; arrays can't hold server timestamps, so it lives outside `past`). Each new Agree moves the current
 * one into `past` with its `at`. What counts for a month is decided by the agreements made before the month
 * was complete (memberTerms in domain/stakes.ts), so a finished month never changes.
 */
export interface Agreement {
  at: number
  terms: PairTerms
  /** Earlier agreements, oldest first, `at` strictly ascending and before `at`; at most 5 (6 in all). */
  past: AgreedTerms[]
}

/** spaces/{id}/stakes/{uid}: a member's own stakes, and their friends' agreements to them. */
export interface MemberStakes {
  uid: UID
  rewardMode: StakesMode
  penaltyMode: StakesMode
  /** Reward for everyone ('group'). May be '' while the reward is per friend (kept for switching back). */
  reward: string
  /** Penalty for everyone ('group'). May be '' while the penalty is per friend. */
  penalty: string
  /** Per friend (current members other than uid). Each entry has both texts, 0–120 characters; the text of a
   *  line that is per friend is 1–120 and not blank. A friend without an entry has no terms ('missing') while
   *  either line is per friend. */
  per: Record<UID, { reward: string; penalty: string }>
  /** At most 5, months strictly ascending. */
  tiers: StreakTier[]
  /** Written only by each friend, for their own key. */
  agreed: Record<UID, Agreement>
  updatedAt: number
}

/** One line between a member and a friend in one month (§9.7). */
export interface LineInForce {
  text: string
  /** Owed together with everyone else on the same line: a Same-for-everyone line, or the house stakes. */
  together: boolean
  /** 'agreed': from the friend's agreement made at `at`; 'house': the month's house stakes. */
  source: 'agreed' | 'house'
  at?: number
}

/**
 * What counts between a member and a friend in one month (§9.7, memberTerms): each line on its own, from
 * the agreements made before the month was complete, else the month's house stakes. `tiers`: the member's
 * streak rewards in force for this friend (everyone agreed to them; [] otherwise and on house stakes).
 */
export interface TermsInForce {
  reward: LineInForce
  penalty: LineInForce
  tiers: StreakTier[]
}

/** The last change of a space's house stakes (§9.7): drives the notice and the `house` push. */
export interface StakesNote {
  /** The owner who changed them. */
  by: UID
  /** Server time of the change. */
  at: number
}

/** One member's line in a month's results doc. */
export interface MonthResultsEntry {
  /** The month's finalScore; null when they had none (sat out, judged, every week paused). */
  score: number | null
  passed: boolean | null
  /** Months in a row at or above the bar after this month (skipped months carry it). */
  streak: number
  /** Each streak reward's own run after this month, keyed by its length in months ("3" → 2): counted only
   *  while everyone has agreed to it (§9.8). A tier is owed in the month its run first equals its length.
   *  Absent = no streak reward in force (and every month before batch 2). */
  tierRuns?: Record<string, number>
}

/** spaces/{id}/results/{monthId}: written once by the reminders job when the month is complete. Read only. */
export interface MonthResults {
  monthId: MonthId
  /** When the month became final (its last stored deadline). */
  completeAt: number
  /** Everyone who was in the month's roster, plus everyone carried over from the previous month's doc. */
  members: Record<UID, MonthResultsEntry>
  /** The month's terms for good, subject → friend (monthTerms from the agreements made before `completeAt`,
   *  §9.7). Screens and the job use these instead of the stakes docs once present. Absent on docs without any
   *  player pair. */
  terms?: Record<UID, Record<UID, TermsInForce>>
  createdAt: number
}

// ---------- Money (private to each user: users/{uid}/...) ----------

/** ISO 4217 code, e.g. 'USD'. */
export type CurrencyCode = string

/** users/{uid}/money/state. Missing until the user sets a currency or a balance. */
export interface MoneyState {
  currency: CurrencyCode
  /** "I have this much now": the starting point of the balance. null until set. */
  baseline: number | null
  /** When the baseline was set. Earnings and moves at or before it are already in it. */
  baselineAt: number | null
  updatedAt: number
}

/** users/{uid}/earnings/{spaceId}_{weekId}_{taskId}: a task the user marked as generating revenue.
 *  The doc existing is the "generates revenue" switch. Private: friends never see amounts. */
export interface Earning {
  /** `${spaceId}_${weekId}_${taskId}` */
  id: string
  spaceId: string
  weekId: WeekId
  taskId: string
  /** Copy of the task title, kept in step by the data layer (so history survives leaving a space). */
  title: string
  /** ≥ 0, at most 2 decimals. 0 = revenue task without an amount yet. */
  amount: number
  /** When the task was completed (self check-off, or its last step ticked); null while not done. */
  earnedAt: number | null
  updatedAt: number
}

/** users/{uid}/moves/{id}: money added or spent by hand. */
export interface MoneyMove {
  id: string
  kind: 'add' | 'spend'
  /** > 0, at most 2 decimals. */
  amount: number
  /** 0–80 characters, e.g. "Rent". */
  note: string
  at: number
  /** A goal marked as bought (a spend of its cost): left out of the pace. Absent on other moves. */
  goal?: boolean
}

/** users/{uid}/goals/{id}: something to save for. The balance fills goals in `order` (lowest first). */
export interface Goal {
  id: string
  /** 1–60 characters, e.g. "Sony FX3". */
  name: string
  /** > 0, at most 2 decimals. */
  cost: number
  order: number
  createdAt: number
}
