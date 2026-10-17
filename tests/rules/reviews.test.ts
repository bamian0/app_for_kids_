// weeks/{weekId}/reviews/{reviewerId}_{revieweeId}: the submit batch, windows, finality, blind reads.
import { describe, expect, test } from 'vitest'
import {
  arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc,
  where, writeBatch, type DocumentData, type Firestore,
} from 'firebase/firestore'
import { allDenied, allowed, denied, spaceDoc, useRulesEnv, weekDoc, type Phase } from './helpers.ts'

const { db, seed } = useRulesEnv()

const marks = (n = 3): Record<string, number> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}abcdefg`, [1, 0.5, 0][i % 3]!]))
const review = (reviewerId: string, revieweeId: string, extra: DocumentData = {}): DocumentData => ({
  reviewerId, revieweeId, marks: marks(), submittedAt: serverTimestamp(), ...extra,
})
const reviewsPath = (week = 'W') => `spaces/s1/weeks/${week}/reviews`

/** submitReviews as the data layer does it: every review plus submittedBy in one batch. */
function submit(fs: Firestore, uid: string, docs: Record<string, DocumentData>, opts: { week?: string; markSubmitted?: boolean } = {}) {
  const week = opts.week ?? 'W'
  const batch = writeBatch(fs)
  for (const [id, data] of Object.entries(docs)) batch.set(doc(fs, `${reviewsPath(week)}/${id}`), data)
  if (opts.markSubmitted !== false) batch.update(doc(fs, `spaces/s1/weeks/${week}`), { submittedBy: arrayUnion(uid) })
  return batch.commit()
}

const setup = (phase: Phase, members = ['alice', 'bob', 'carol'], submittedBy: string[] = []) =>
  seed({ 'spaces/s1': spaceDoc([...members, 'erin']), 'spaces/s1/weeks/W': weekDoc(phase, members, submittedBy) })

describe('reviews: create', () => {
  test('an 8-member space: 7 reviews + submittedBy in one batch stays within rule limits', async () => {
    const members = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8']
    await setup('review', members)
    const u1 = db('u1')
    // 25 marks each, one of them a fair vote on a crossed-out task.
    const docs = Object.fromEntries(
      members.slice(1).map((r) => [`u1_${r}`, review('u1', r, { marks: { ...marks(25), t0abcdefg: 'fair' } })]),
    )
    await allowed(submit(u1, 'u1', docs))
    expect((await getDocs(query(collection(u1, reviewsPath()), where('reviewerId', '==', 'u1')))).size).toBe(7)
  })

  test('a crossed-out task gets \'fair\' (Fair, Skip It) or 0 (Not Done); old clients\' marks still pass', async () => {
    await setup('review')
    // SPEC §10.4: the rules can't tell which tasks are crossed out; the domain counts 'fair' as 0 elsewhere.
    await allowed(submit(db('alice'), 'alice', {
      alice_bob: review('alice', 'bob', { marks: { t0abcdefg: 'fair', t1abcdefg: 0, t2abcdefg: 1, t3abcdefg: 0.5 } }),
      alice_carol: review('alice', 'carol', { marks: { t0abcdefg: 'fair' } }),
    }))
    // An old client's batch: only 0, 0.5 and 1 (also on a crossed-out task, where they count as Not Done).
    await allowed(submit(db('bob'), 'bob', { bob_alice: review('bob', 'alice'), bob_carol: review('bob', 'carol', { marks: { t0abcdefg: 1.0, t1abcdefg: 0.0 } }) }))
    const one = (mark: unknown) => () => submit(db('carol'), 'carol', { carol_alice: review('carol', 'alice', { marks: { t0abcdefg: mark } }) })
    await allDenied({
      '\'Fair\'': one('Fair'),
      '\'skip\'': one('skip'),
      '\'fair \'': one('fair '),
      '\'not done\'': one('not done'),
      '-1': one(-1),
      '2': one(2),
      'null': one(null),
      'a map': one({ fair: true }),
    })
  })

  test('someone who left after lock is still reviewed by those who remain, and can no longer submit', async () => {
    // carol is in the week (it locked before she left) but no longer in the space.
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob', 'erin'], { leftAt: { carol: Timestamp.now() } }), 'spaces/s1/weeks/W': weekDoc('review', ['alice', 'bob', 'carol']) })
    await allowed(submit(db('alice'), 'alice', { alice_bob: review('alice', 'bob'), alice_carol: review('alice', 'carol') }))
    await denied(submit(db('carol'), 'carol', { carol_alice: review('carol', 'alice') }))
  })

  test('submitting with nobody to review (only the week update) is allowed', async () => {
    await setup('review')
    await allowed(submit(db('alice'), 'alice', {}))
  })

  test('reviews are only accepted inside the review window', async () => {
    for (const phase of ['planning', 'active', 'closed'] as const) {
      await setup(phase)
      await denied(submit(db('alice'), 'alice', { alice_bob: review('alice', 'bob') }))
    }
  })

  test('reviews must be part of the submit batch', async () => {
    await setup('review')
    const alice = db('alice')
    await denied(setDoc(doc(alice, `${reviewsPath()}/alice_bob`), review('alice', 'bob')))
    await denied(submit(alice, 'alice', { alice_bob: review('alice', 'bob') }, { markSubmitted: false }))
  })

  test('reviews are final: no second submit, no edits, no deletes', async () => {
    await setup('review')
    const alice = db('alice')
    await allowed(submit(alice, 'alice', { alice_bob: review('alice', 'bob') }))
    const ref = doc(alice, `${reviewsPath()}/alice_bob`)
    await allDenied({
      'review someone else after submitting': () =>
        submit(alice, 'alice', { alice_carol: review('alice', 'carol') }, { markSubmitted: false }),
      'second submit batch': () => submit(alice, 'alice', { alice_carol: review('alice', 'carol') }),
      'overwrite the same review': () => setDoc(ref, review('alice', 'bob', { marks: { t0abcdefg: 0 } })),
      'update marks': () => updateDoc(ref, { 'marks.t0abcdefg': 0 }),
      'delete': () => deleteDoc(ref),
    })
  })

  test('two writes of the same review in one batch collapse into a single create', async () => {
    await setup('review')
    const alice = db('alice')
    const batch = writeBatch(alice)
    batch.set(doc(alice, `${reviewsPath()}/alice_bob`), review('alice', 'bob'))
    batch.set(doc(alice, `${reviewsPath()}/alice_bob`), review('alice', 'bob', { marks: { t0abcdefg: 0 } }))
    batch.update(doc(alice, 'spaces/s1/weeks/W'), { submittedBy: arrayUnion('alice') })
    // Both sets collapse into one create of the final value, which is still a valid single review.
    await allowed(batch.commit())
  })

  test('invalid reviews are rejected', async () => {
    await setup('review')
    const alice = db('alice')
    const one = (id: string, data: DocumentData) => () => submit(alice, 'alice', { [id]: data })
    await allDenied({
      'self review': one('alice_alice', review('alice', 'alice')),
      'reviewee not a participant': one('alice_erin', review('alice', 'erin')),
      'reviewee unknown': one('alice_zoe', review('alice', 'zoe')),
      'id does not match': one('alice_carol', review('alice', 'bob')),
      'reviewer spoofed': one('bob_carol', review('bob', 'carol')),
      'mark 0.7': one('alice_bob', review('alice', 'bob', { marks: { t1: 0.7 } })),
      'mark 2': one('alice_bob', review('alice', 'bob', { marks: { t1: 2 } })),
      'mark "1"': one('alice_bob', review('alice', 'bob', { marks: { t1: '1' } })),
      'mark true': one('alice_bob', review('alice', 'bob', { marks: { t1: true } })),
      'marks a list': one('alice_bob', review('alice', 'bob', { marks: [1, 1] })),
      '26 marks': one('alice_bob', review('alice', 'bob', { marks: marks(26) })),
      'mark key not a task id': one('alice_bob', review('alice', 'bob', { marks: { 'not a task id!': 1 } })),
      'mark key 65 chars': one('alice_bob', review('alice', 'bob', { marks: { ['k'.repeat(65)]: 1 } })),
      'last of 25 keys oversized': one('alice_bob', review('alice', 'bob', { marks: { ...marks(24), ['z'.repeat(1400)]: 1 } })),
      'client submittedAt': one('alice_bob', review('alice', 'bob', { submittedAt: Timestamp.now() })),
      'extra key': one('alice_bob', review('alice', 'bob', { comment: 'lazy' })),
      'missing marks': one('alice_bob', { reviewerId: 'alice', revieweeId: 'bob', submittedAt: serverTimestamp() }),
    })
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob', 'erin']) })
    await allDenied({
      'reviewer left the space': () => submit(db('carol'), 'carol', { carol_bob: review('carol', 'bob') }),
      'reviewer not a participant': () => submit(db('erin'), 'erin', { erin_bob: review('erin', 'bob') }),
      'signed out': () => submit(db(), 'alice', { alice_bob: review('alice', 'bob') }),
    })
  })
})

describe('reviews: blind reads', () => {
  /** alice and bob submitted, carol has not: not revealed until the deadline. */
  async function seedReviews(phase: Phase, submittedBy: string[]) {
    await setup(phase, ['alice', 'bob', 'carol'], submittedBy)
    const at = Timestamp.now()
    await seed({
      [`${reviewsPath()}/alice_bob`]: { reviewerId: 'alice', revieweeId: 'bob', marks: { t1: 1 }, submittedAt: at },
      [`${reviewsPath()}/alice_carol`]: { reviewerId: 'alice', revieweeId: 'carol', marks: { t1: 0 }, submittedAt: at },
      [`${reviewsPath()}/bob_alice`]: { reviewerId: 'bob', revieweeId: 'alice', marks: { t1: 0.5 }, submittedAt: at },
      [`${reviewsPath()}/bob_carol`]: { reviewerId: 'bob', revieweeId: 'carol', marks: { t1: 1 }, submittedAt: at },
    })
  }
  const all = (fs: Firestore) => getDocs(collection(fs, reviewsPath()))
  const byReviewer = (fs: Firestore, uid: string) => getDocs(query(collection(fs, reviewsPath()), where('reviewerId', '==', uid)))
  const byReviewee = (fs: Firestore, uid: string) => getDocs(query(collection(fs, reviewsPath()), where('revieweeId', '==', uid)))

  test('before reveal: only your own reviews (get and query)', async () => {
    await seedReviews('review', ['alice', 'bob'])
    const alice = db('alice')
    await allowed(getDoc(doc(alice, `${reviewsPath()}/alice_bob`)))
    expect((await byReviewer(alice, 'alice')).size).toBe(2)
    await allDenied({
      'get a review about me': () => getDoc(doc(alice, `${reviewsPath()}/bob_alice`)),
      'get a review between others': () => getDoc(doc(db('carol'), `${reviewsPath()}/alice_bob`)),
      'get a missing review': () => getDoc(doc(alice, `${reviewsPath()}/carol_alice`)),
      'list all': () => all(alice),
      'query reviews about me': () => byReviewee(alice, 'alice'),
      'query another reviewer': () => byReviewer(alice, 'bob'),
    })
  })

  test('after everyone submitted: members read everything', async () => {
    await seedReviews('review', ['alice', 'bob', 'carol'])
    expect((await all(db('carol'))).size).toBe(4)
    await allowed(getDoc(doc(db('carol'), `${reviewsPath()}/alice_bob`)))
    await allowed(byReviewee(db('alice'), 'alice'))
    await allowed(all(db('erin')))
  })

  test('a participant who left after lock holds the reveal until the deadline: leaving reveals nothing', async () => {
    // alice and bob submitted; carol hadn't, then left on Friday and can't submit any more.
    await seedReviews('review', ['alice', 'bob'])
    await denied(all(db('bob')))
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob', 'erin'], { leftAt: { carol: Timestamp.now() } }) })
    await allDenied({
      'list all': () => all(db('bob')),
      'get a review about me': () => getDoc(doc(db('alice'), `${reviewsPath()}/bob_alice`)),
      'the leaver': () => all(db('carol')),
    })
    // The deadline always reveals.
    await seedReviews('closed', ['alice', 'bob'])
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob', 'erin'], { leftAt: { carol: Timestamp.now() } }) })
    expect((await all(db('bob'))).size).toBe(4)
    await allowed(getDoc(doc(db('erin'), `${reviewsPath()}/bob_alice`)))
    await denied(all(db('carol')))
  })

  test('a leaver who had already submitted does not hold the reveal', async () => {
    await seedReviews('review', ['alice', 'bob', 'carol'])
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob', 'erin'], { leftAt: { carol: Timestamp.now() } }) })
    expect((await all(db('alice'))).size).toBe(4)
  })

  test('after the deadline: members read everything even if someone missed it', async () => {
    await seedReviews('closed', ['alice'])
    expect((await all(db('bob'))).size).toBe(4)
    await allowed(getDoc(doc(db('carol'), `${reviewsPath()}/bob_alice`)))
  })

  test('non-members never read reviews of the space', async () => {
    await seedReviews('closed', ['alice', 'bob', 'carol'])
    const zoe = db('zoe')
    await allDenied({
      'get': () => getDoc(doc(zoe, `${reviewsPath()}/alice_bob`)),
      'list': () => all(zoe),
      'signed out list': () => all(db()),
    })
  })
})
