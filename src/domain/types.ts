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
}

export interface Invite {
  code: string
  spaceId: string
  spaceName: string
  /** The space's stakes, mirrored so the join preview can show them before joining. Empty on old invites. */
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
  /** Tuesday 00:00 local — task lists lock ("Monday at midnight"). */
  lockAt: number
  /** Friday 00:00 local — review window opens. */
  reviewOpenAt: number
  /** Saturday 00:00 local — reviews due ("Friday at midnight"). */
  deadlineAt: number
  /** Participants: everyone who was a space member before lockAt (added whenever any member opens the
   *  app before then), minus anyone who left the space before lockAt. Leaving or being removed after
   *  lockAt keeps them in: the week still reviews and scores them. */
  members: UID[]
  /** Participants who submitted their Friday reviews. */
  submittedBy: UID[]
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

export interface Settlement {
  /** `${monthId}_${uid}` */
  id: string
  monthId: MonthId
  uid: UID
  settled: boolean
  settledBy: UID
  settledAt: number
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

/** The stakes that apply to one month: frozen in spaces/{id}/months/{monthId} once the month's first
 *  task lists have locked, else the space's current text (frozen = false). */
export interface MonthStakes {
  reward: string
  penalty: string
  frozen: boolean
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
