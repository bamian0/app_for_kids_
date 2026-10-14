// Pausing a week (SPEC §9.3). Everything lives on the space doc (`pause`, `paused`), so screens learn
// the state from useSpace with no extra reads. Every write is a transaction that fails at once offline.
import { doc, FieldPath, getDoc, getDocFromCache, runTransaction, serverTimestamp, type DocumentSnapshot } from 'firebase/firestore'
import { now } from '../domain/clock.ts'
import { isWeekPaused, pauseChoices, pauseCompletes, pauseNeedsFinalizing, type PauseChoice } from '../domain/pause.ts'
import { boundsFor } from '../domain/schedule.ts'
import { addWeeks, monthIdForWeek, weekIdFor } from '../domain/time.ts'
import type { MonthId, Space, UID, Week, WeekId } from '../domain/types.ts'
import { getFirebase } from '../firebase/app.ts'
import { toSpace, toWeek } from './convert.ts'
import { humanError, isDenied, MSG } from './errors.ts'
import { requireUser } from './session.ts'
import { requireServer } from './spaces.ts'
import { ensureWeek, weekRef } from './weeks.ts'

const FAILED = 'Couldn’t do that. Try again.'
const CANCELLED = 'This request was cancelled.'
const TOO_LATE = 'Too late: reviews for that week have opened.'

function spaceRef(spaceId: string) {
  return doc(getFirebase().db, 'spaces', spaceId)
}

/** "October", the month a week's pause would use (the month of its Friday). */
function monthName(monthId: MonthId): string {
  const [year, month] = monthId.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 15)))
}

/** Why asking isn't possible, in the words the screens show. */
function choiceMessage(choice: Exclude<PauseChoice, 'ok'>, weekId: WeekId): string {
  switch (choice) {
    case 'month-used':
      return `You can pause one week a month, and ${monthName(monthIdForWeek(weekId))} already has its pause.`
    case 'too-late':
      return 'Reviews for that week open too soon to ask. Friends need a day to answer.'
    case 'reviews-open':
      return 'Reviews for that week have opened, so it can’t be paused anymore.'
    case 'request-pending':
      return 'There’s already a request to pause a week. Answer it first.'
    case 'cooldown':
      return 'You asked not long ago. Try again later.'
  }
}

/** The request's `oks` exactly as stored (the rules compare the list as stored). */
function storedOks(snap: DocumentSnapshot): UID[] {
  const oks: unknown = snap.get('pause.oks')
  return Array.isArray(oks) ? oks.filter((uid): uid is UID => typeof uid === 'string') : []
}

/** Records the pause in the same write: `paused.{month}` = the week. */
function recording(weekId: WeekId): [FieldPath, WeekId] {
  return [new FieldPath('paused', monthIdForWeek(weekId)), weekId]
}

/**
 * Asks to pause `weekId`: this week while its reviews open more than a day from now, or next week. Makes
 * sure the week doc exists first. When nobody else in the week needs to say OK, the week is paused at once
 * ('paused'); else 'asked'. Refused with a plain message (month used, reviews too close or open, a request
 * pending, asked within 12 hours).
 */
export async function askToPause(space: Space, weekId: WeekId): Promise<'asked' | 'paused'> {
  const me = requireUser().uid
  await requireServer(me)
  await ensureWeek(space, weekId).catch(() => {})
  const { db } = getFirebase()
  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(spaceRef(space.id))
      if (!snap.exists()) throw new Error(MSG.noAccess)
      const fresh = toSpace(snap)
      if (!fresh.memberIds.includes(me)) throw new Error(MSG.noAccess)
      const at = now()
      const thisWeek = weekIdFor(at, fresh.timezone)
      const nextWeek = addWeeks(thisWeek, 1)
      if (weekId !== thisWeek && weekId !== nextWeek) throw new Error(FAILED)
      const weekSnap = await tx.get(weekRef(space.id, weekId))
      // The rules need the week's doc (who must say OK, when its reviews open).
      if (!weekSnap.exists()) throw new Error(FAILED)
      const week = toWeek(weekSnap, space.id)
      // A request still in play for another week is judged on that week's stored times too.
      let other: Week | null = null
      if (fresh.pause && fresh.pause.weekId !== weekId && (fresh.pause.weekId === thisWeek || fresh.pause.weekId === nextWeek)) {
        const otherSnap = await tx.get(weekRef(space.id, fresh.pause.weekId))
        other = otherSnap.exists() ? toWeek(otherSnap, space.id) : null
      }
      const reviewOpenAt = (id: WeekId) => (id === weekId ? week.reviewOpenAt : (other?.id === id ? other.reviewOpenAt : boundsFor(fresh, id).reviewOpenAt))
      const choices = pauseChoices(fresh, me, at, {
        thisWeek: { id: thisWeek, reviewOpenAt: reviewOpenAt(thisWeek) },
        nextWeek: { id: nextWeek, reviewOpenAt: reviewOpenAt(nextWeek) },
      })
      const choice = weekId === thisWeek ? choices.thisWeek : choices.nextWeek
      if (choice !== 'ok') throw new Error(choiceMessage(choice, weekId))
      const done = pauseCompletes([me], fresh.memberIds, week.members)
      const pause = { weekId, by: me, at: serverTimestamp(), oks: [me] }
      if (done) tx.update(spaceRef(space.id), 'pause', pause, ...recording(weekId))
      else tx.update(spaceRef(space.id), { pause })
      return done ? 'paused' : 'asked'
    })
  } catch (e) {
    throw humanError(e, FAILED)
  }
}

/** OK or Not Now to the pending request. Resolves with what the request became. */
export async function answerPause(space: Space, answer: 'ok' | 'not-now'): Promise<'waiting' | 'paused' | 'declined'> {
  const me = requireUser().uid
  await requireServer(me)
  try {
    return await answering(space, me, answer)
  } catch (e) {
    if (!isDenied(e)) throw humanError(e, FAILED)
  }
  try {
    // Someone answered at the same moment (the server judged this write by their answer): decide again.
    return await answering(space, me, answer)
  } catch (e) {
    throw humanError(e, FAILED)
  }
}

function answering(space: Space, me: UID, answer: 'ok' | 'not-now'): Promise<'waiting' | 'paused' | 'declined'> {
  return runTransaction(getFirebase().db, async (tx) => {
    const snap = await tx.get(spaceRef(space.id))
    if (!snap.exists()) throw new Error(MSG.noAccess)
    const fresh = toSpace(snap)
    if (!fresh.memberIds.includes(me)) throw new Error(MSG.noAccess)
    const request = fresh.pause
    if (!request || request.declinedBy === request.by) throw new Error(CANCELLED)
    if (isWeekPaused(fresh, request.weekId)) return 'paused'
    if (request.declinedBy) return 'declined'
    const weekSnap = await tx.get(weekRef(space.id, request.weekId))
    if (!weekSnap.exists()) throw new Error(FAILED)
    const week = toWeek(weekSnap, space.id)
    if (now() >= week.reviewOpenAt) throw new Error(TOO_LATE)
    const oks = storedOks(snap)
    if (answer === 'not-now') {
      // Someone who already said OK can't take it back (the asker cancels instead).
      if (oks.includes(me) && me !== request.by) throw new Error(FAILED)
      tx.update(spaceRef(space.id), new FieldPath('pause', 'declinedBy'), me)
      return 'declined'
    }
    if (oks.includes(me)) return pauseCompletes(oks, fresh.memberIds, week.members) ? 'paused' : 'waiting'
    const next = [...oks, me]
    const done = pauseCompletes(next, fresh.memberIds, week.members)
    if (done) tx.update(spaceRef(space.id), new FieldPath('pause', 'oks'), next, ...recording(request.weekId))
    else tx.update(spaceRef(space.id), new FieldPath('pause', 'oks'), next)
    return done ? 'paused' : 'waiting'
  })
}

/** The asker cancels the request (only while it isn't recorded): it stays with declinedBy = the asker. */
export async function withdrawPause(space: Space): Promise<void> {
  const me = requireUser().uid
  await requireServer(me)
  try {
    await runTransaction(getFirebase().db, async (tx) => {
      const snap = await tx.get(spaceRef(space.id))
      if (!snap.exists()) throw new Error(MSG.noAccess)
      const fresh = toSpace(snap)
      const request = fresh.pause
      if (!fresh.memberIds.includes(me) || !request || request.by !== me) throw new Error(FAILED)
      // Already cancelled, or someone said Not Now: nothing left to cancel.
      if (request.declinedBy) return
      if (isWeekPaused(fresh, request.weekId)) throw new Error(FAILED)
      tx.update(spaceRef(space.id), new FieldPath('pause', 'declinedBy'), me)
    })
  } catch (e) {
    throw humanError(e, FAILED)
  }
}

/**
 * ensureSpace: records a request that everyone still in the space has OK'd (the last holdout left).
 * Returns at once unless pauseNeedsFinalizing. Best effort.
 */
export async function finalizePause(space: Space): Promise<void> {
  const request = space.pause
  if (!request || request.declinedBy || isWeekPaused(space, request.weekId)) return
  const me = getFirebase().auth.currentUser?.uid
  if (!me || !space.memberIds.includes(me)) return
  const ref = weekRef(space.id, request.weekId)
  const cached = (await getDocFromCache(ref).catch(() => null)) ?? (await getDoc(ref).catch(() => null))
  if (!cached?.exists() || !pauseNeedsFinalizing(space, now(), toWeek(cached, space.id))) return
  await runTransaction(getFirebase().db, async (tx) => {
    const snap = await tx.get(spaceRef(space.id))
    const weekSnap = await tx.get(ref)
    if (!snap.exists() || !weekSnap.exists()) return
    const fresh = toSpace(snap)
    if (fresh.pause?.weekId !== request.weekId || !pauseNeedsFinalizing(fresh, now(), toWeek(weekSnap, space.id))) return
    tx.update(spaceRef(space.id), ...recording(request.weekId))
  }).catch(() => {})
}
