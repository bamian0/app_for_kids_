// Monthly lists (SPEC §9.5): spaces/{id}/monthly/{monthId} and its plans, progress and reviews.
// Creating one, and moving one on fixed dates, run on a moved clock in calendar.test.ts (a list can
// only be created in the 8 days before its month's first week, so real time can't reach most months).
import { describe, expect, test } from 'vitest'
import {
  arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, getDocs, query, serverTimestamp, setDoc,
  Timestamp, updateDoc, where, writeBatch, type DocumentData, type Firestore,
} from 'firebase/firestore'
import {
  addMonths, allDenied, allowed, CUSTOM, denied, HOUR, monthlyDoc, monthlyOn, monthStr, monthWeeks, spaceDoc, ts,
  useRulesEnv, USUAL, weekOn, type Phase,
} from './helpers.ts'

const { db, seed } = useRulesEnv()

const M = '2026-11'
const ZONE = 'Europe/Berlin'
const ABC = ['alice', 'bob', 'carol']
const listRef = (fs: Firestore, monthId = M) => doc(fs, `spaces/s1/monthly/${monthId}`)
const planRef = (fs: Firestore, uid: string) => doc(fs, `spaces/s1/monthly/${M}/plans/${uid}`)
const progressRef = (fs: Firestore, uid: string) => doc(fs, `spaces/s1/monthly/${M}/progress/${uid}`)
const reviewsPath = `spaces/s1/monthly/${M}/reviews`
const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Task ${i + 1}` }))
const plan = (extra: DocumentData = {}): DocumentData => ({ tasks: tasks(3), updatedAt: serverTimestamp(), ...extra })

/** Space s1 = alice, bob, carol, erin; the list in `phase` holds alice, bob and dave (who left). */
const setup = (phase: Phase, submittedBy: string[] = []) =>
  seed({ 'spaces/s1': spaceDoc([...ABC, 'erin']), [`spaces/s1/monthly/${M}`]: monthlyDoc(phase, ['alice', 'bob', 'dave'], [], submittedBy) })

describe('monthly plans', () => {
  test('a participant plans before the lock, with steps, and may delete it', async () => {
    await setup('planning')
    const alice = db('alice')
    await allowed(setDoc(planRef(alice, 'alice'), plan()))
    await allowed(setDoc(planRef(alice, 'alice'), plan({ tasks: [{ id: 't1', title: 'Learn the chords', subs: ['s1|Week one', 's2|Week two'] }] })))
    await allowed(deleteDoc(planRef(alice, 'alice')))
  })

  test('after the lock it can\'t change, grow or go', async () => {
    await setup('active')
    await seed({ [`spaces/s1/monthly/${M}/plans/alice`]: { tasks: tasks(2), updatedAt: Timestamp.now() } })
    const alice = db('alice')
    await allDenied({
      'rewrite': () => setDoc(planRef(alice, 'alice'), plan()),
      'append like a week': () => updateDoc(planRef(alice, 'alice'), {
        tasks: arrayUnion({ id: 'late', title: 'Late' }), 'added.late': serverTimestamp(), updatedAt: serverTimestamp(),
      }),
      'a first task like a week': () => setDoc(planRef(db('bob'), 'bob'), {
        tasks: [{ id: 'late', title: 'Late' }], added: { late: serverTimestamp() }, updatedAt: serverTimestamp(),
      }),
      'delete': () => deleteDoc(planRef(alice, 'alice')),
    })
  })

  test('only the participant, still in the space, writes a valid list', async () => {
    await setup('planning')
    await allDenied({
      'someone else\'s': () => setDoc(planRef(db('bob'), 'alice'), plan()),
      'not in the list': () => setDoc(planRef(db('erin'), 'erin'), plan()),
      'left the space': () => setDoc(planRef(db('dave'), 'dave'), plan()),
      'with added times': () => setDoc(planRef(db('alice'), 'alice'), plan({ added: {} })),
      '26 tasks': () => setDoc(planRef(db('alice'), 'alice'), plan({ tasks: tasks(26) })),
      'a client updatedAt': () => setDoc(planRef(db('alice'), 'alice'), plan({ updatedAt: Timestamp.now() })),
      'signed out': () => setDoc(planRef(db(), 'alice'), plan()),
    })
  })

  test('members read lists; others don\'t', async () => {
    await setup('active')
    await seed({ [`spaces/s1/monthly/${M}/plans/alice`]: { tasks: tasks(2), updatedAt: Timestamp.now() } })
    await allowed(getDoc(planRef(db('erin'), 'alice')))
    await allowed(getDocs(collection(db('bob'), `spaces/s1/monthly/${M}/plans`)))
    await allowed(getDoc(listRef(db('erin'))))
    await denied(getDoc(planRef(db('zoe'), 'alice')))
    await denied(getDoc(listRef(db('zoe'))))
  })
})

describe('monthly progress', () => {
  const tick = (fs: Firestore, uid: string, id: string, done: boolean) =>
    setDoc(progressRef(fs, uid), { done: { [id]: done }, updatedAt: serverTimestamp() }, { merge: true })

  test('ticked until the deadline', async () => {
    for (const phase of ['planning', 'active', 'review'] as const) {
      await setup(phase)
      await allowed(tick(db('alice'), 'alice', 't1', true))
    }
    await setup('closed')
    await denied(tick(db('alice'), 'alice', 't1', true))
    await setup('active')
    await allDenied({
      'someone else\'s': () => tick(db('bob'), 'alice', 't1', true),
      'not in the list': () => tick(db('erin'), 'erin', 't1', true),
      'two keys at once': () => setDoc(progressRef(db('bob'), 'bob'), { done: { t1: true, t2: true }, updatedAt: serverTimestamp() }, { merge: true }),
    })
  })
})

describe('the list doc', () => {
  test('members leave it before the lock, in the same batch as the space; never after', async () => {
    const leave = (uid: string, lists: string[]) => {
      const fs = db(uid)
      const batch = writeBatch(fs)
      for (const m of lists) batch.update(listRef(fs, m), { members: arrayRemove(uid) })
      batch.update(doc(fs, 'spaces/s1'), { memberIds: arrayRemove(uid), [`joinedAt.${uid}`]: deleteField(), [`leftAt.${uid}`]: serverTimestamp() })
      return batch.commit()
    }
    await seed({
      'spaces/s1': spaceDoc(ABC),
      'spaces/s1/monthly/2026-11': monthlyDoc('planning', ABC),
      'spaces/s1/monthly/2026-10': monthlyDoc('active', ABC),
    })
    await denied(leave('carol', ['2026-11', '2026-10']))
    await allowed(leave('carol', ['2026-11']))
    expect((await getDoc(listRef(db('alice'), '2026-11'))).data()?.members).toEqual(['alice', 'bob'])
    expect((await getDoc(listRef(db('alice'), '2026-10'))).data()?.members).toEqual(ABC)
  })

  test('members submit inside the review window only', async () => {
    await setup('review')
    await allowed(updateDoc(listRef(db('alice')), { submittedBy: arrayUnion('alice') }))
    for (const phase of ['active', 'closed'] as const) {
      await setup(phase)
      await denied(updateDoc(listRef(db('alice')), { submittedBy: arrayUnion('alice') }))
    }
  })

  test('lists can\'t be deleted or rewritten', async () => {
    await setup('planning')
    await denied(deleteDoc(listRef(db('alice'))))
    await denied(setDoc(listRef(db('alice')), monthlyDoc('planning', ['alice', 'bob', 'dave'])))
    await denied(updateDoc(listRef(db('alice')), { submittedBy: [] , judges: ['alice'] }))
  })
})

describe('monthly reviews', () => {
  const review = (r: string, e: string, extra: DocumentData = {}) => ({ reviewerId: r, revieweeId: e, marks: { t1: 1, t2: 0.5 }, submittedAt: serverTimestamp(), ...extra })
  const submit = (uid: string, docs: Record<string, DocumentData>, markSubmitted = true) => {
    const fs = db(uid)
    const batch = writeBatch(fs)
    for (const [id, d] of Object.entries(docs)) batch.set(doc(fs, `${reviewsPath}/${id}`), d)
    if (markSubmitted) batch.update(listRef(fs), { submittedBy: arrayUnion(uid) })
    return batch.commit()
  }

  test('reviews go in with the submit, inside the window', async () => {
    await setup('review')
    await allDenied({
      'not in the submit batch': () => submit('alice', { alice_bob: review('alice', 'bob') }, false),
      'reviewee not in the list': () => submit('alice', { alice_erin: review('alice', 'erin') }),
      'self': () => submit('alice', { alice_alice: review('alice', 'alice') }),
      'a mark of 2': () => submit('alice', { alice_bob: review('alice', 'bob', { marks: { t1: 2 } }) }),
    })
    // dave left after the lock: still reviewed.
    await allowed(submit('alice', { alice_bob: review('alice', 'bob'), alice_dave: review('alice', 'dave') }))
    for (const phase of ['active', 'closed'] as const) {
      await setup(phase)
      await denied(submit('alice', { alice_bob: review('alice', 'bob') }))
    }
  })

  test('blind until everyone in the list submitted or the deadline', async () => {
    const at = Timestamp.now()
    const seedReviews = async (phase: Phase, submittedBy: string[]) => {
      await seed({
        'spaces/s1': spaceDoc([...ABC, 'erin']),
        [`spaces/s1/monthly/${M}`]: monthlyDoc(phase, ABC, [], submittedBy),
        [`${reviewsPath}/alice_bob`]: { reviewerId: 'alice', revieweeId: 'bob', marks: { t1: 1 }, submittedAt: at },
        [`${reviewsPath}/bob_alice`]: { reviewerId: 'bob', revieweeId: 'alice', marks: { t1: 0 }, submittedAt: at },
      })
    }
    await seedReviews('review', ['alice', 'bob'])
    await allowed(getDoc(doc(db('alice'), `${reviewsPath}/alice_bob`)))
    await allowed(getDocs(query(collection(db('alice'), reviewsPath), where('reviewerId', '==', 'alice'))))
    await allDenied({
      'a review about me': () => getDoc(doc(db('alice'), `${reviewsPath}/bob_alice`)),
      'the whole collection': () => getDocs(collection(db('erin'), reviewsPath)),
    })
    await seedReviews('review', ABC)
    expect((await getDocs(collection(db('erin'), reviewsPath))).size).toBe(2)
    await seedReviews('closed', ['alice'])
    expect((await getDocs(collection(db('carol'), reviewsPath))).size).toBe(2)
    await denied(getDocs(collection(db('zoe'), reviewsPath)))
  })
})

describe('retimesMonthly', () => {
  // A month whose weeks are all ahead, so both parts of its list can still move.
  const M2 = addMonths(monthStr(Date.now()), 2)
  const M3 = addMonths(M2, 1)
  const W = monthWeeks(M2)
  const usual = monthlyOn(M2, ZONE, USUAL, ABC)
  const custom = monthlyOn(M2, ZONE, CUSTOM, ABC)
  const lockPart = (d: DocumentData) => ({ lockAt: d.lockAt })
  const reviewPart = (d: DocumentData) => ({ reviewOpenAt: d.reviewOpenAt, deadlineAt: d.deadlineAt })
  const plus = (t: Timestamp, ms: number) => ts(t.toMillis() + ms)
  const move = (fs: Firestore, data: DocumentData, monthId = M2) => updateDoc(listRef(fs, monthId), data)

  test('after a change of times, the list moves with its weeks', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC, { schedule: CUSTOM }), [`spaces/s1/monthly/${M2}`]: usual })
    await allDenied({
      'the lock off its anchor': () => move(db('bob'), { lockAt: plus(custom.lockAt, 2 * HOUR) }),
      'the review window off its anchors': () => move(db('bob'), { ...reviewPart(custom), deadlineAt: plus(custom.deadlineAt, 2 * HOUR) }),
      'with members': () => move(db('bob'), { ...lockPart(custom), members: arrayUnion('zoe') }),
      'with startAt': () => move(db('bob'), { ...lockPart(custom), startAt: plus(usual.startAt, HOUR) }),
      'with submittedBy': () => move(db('bob'), { ...lockPart(custom), submittedBy: ['bob'] }),
      'a non-member': () => move(db('zoe'), lockPart(custom)),
    })
    // No week docs yet: each part goes to its anchor on the new times (an hour of slack, for DST).
    await allowed(move(db('bob'), { ...lockPart(custom), ...reviewPart(custom) }))
    // The space's times went back to the usual ones.
    await seed({ 'spaces/s1': spaceDoc(ABC) })
    await allowed(move(db('carol'), { ...lockPart(usual), ...reviewPart(usual) }))
  })

  test('once its weeks exist, it takes their stored times exactly', async () => {
    // The lock week and the last week were stored half an hour off their anchors (allowed for weeks).
    const lockWeek = weekOn(ABC, W.lock, ZONE, CUSTOM)
    const lastWeek = weekOn(ABC, W.last, ZONE, CUSTOM)
    lockWeek.lockAt = plus(lockWeek.lockAt, 30 * 60_000)
    lastWeek.reviewOpenAt = plus(lastWeek.reviewOpenAt, 30 * 60_000)
    lastWeek.deadlineAt = plus(lastWeek.deadlineAt, 30 * 60_000)
    await seed({
      'spaces/s1': spaceDoc(ABC, { schedule: CUSTOM }),
      [`spaces/s1/monthly/${M2}`]: usual,
      [`spaces/s1/weeks/${W.lock}`]: lockWeek,
      [`spaces/s1/weeks/${W.last}`]: lastWeek,
    })
    await allDenied({
      'the lock on its anchor': () => move(db('bob'), lockPart(custom)),
      'the review window on its anchors': () => move(db('bob'), reviewPart(custom)),
    })
    await allowed(move(db('bob'), { lockAt: lockWeek.lockAt }))
    await allowed(move(db('bob'), { reviewOpenAt: lastWeek.reviewOpenAt, deadlineAt: lastWeek.deadlineAt }))
  })

  test('a locked list keeps its lock; an opened review window stays', async () => {
    // Bounds seeded relative to now; the review part's anchors are M2's.
    await seed({
      'spaces/s1': spaceDoc(ABC, { schedule: CUSTOM }),
      [`spaces/s1/monthly/${M2}`]: monthlyDoc('active', ABC),
      [`spaces/s1/monthly/${M3}`]: monthlyDoc('review', ABC),
    })
    await denied(move(db('bob'), lockPart(custom)))
    // Its review window is still days away, so it moves.
    await allowed(move(db('bob'), reviewPart(custom)))
    await denied(move(db('bob'), reviewPart(monthlyOn(M3, ZONE, CUSTOM, ABC)), M3))
  })
})

describe('no other paths', () => {
  test('stakes, settlements and frozen months have no plans', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC), [`spaces/s1/monthly/${M}`]: monthlyDoc('planning', ABC) })
    const alice = db('alice')
    for (const path of [`spaces/s1/months/${M}/plans/alice`, `spaces/s1/settlements/${M}_alice/plans/alice`, 'spaces/s1/stakes/alice/plans/alice', `spaces/s1/results/${M}/plans/alice`]) {
      await denied(setDoc(doc(alice, path), plan()))
      await denied(getDoc(doc(alice, path)))
    }
  })
})
