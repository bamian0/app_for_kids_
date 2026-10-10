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
  /** IANA timezone, fixed at creation. All deadlines use it. */
  timezone: string
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
  /** Participants: space members who joined the week before lockAt. */
  members: UID[]
  /** Participants who submitted their Friday reviews. */
  submittedBy: UID[]
}

export interface Task {
  id: string
  title: string
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
  /** null until someone opens the week (the doc is created lazily). */
  week: Week | null
  plans: Record<UID, Plan>
  progress: Record<UID, Progress>
  /** Only the reviews the current user is allowed to read (own reviews before reveal, all after). */
  reviews: Review[]
}
