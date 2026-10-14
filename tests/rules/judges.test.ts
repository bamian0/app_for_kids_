// Judges (SPEC §9.4): each member's own Only Rate Friends choice on the space, the snapshot on each
// period, syncsPeriod, and judges having no list.
import { describe, expect, test } from 'vitest'
import {
  arrayRemove, arrayUnion, collection, deleteField, doc, getDoc, getDocs, runTransaction, serverTimestamp, setDoc,
  Timestamp, updateDoc, writeBatch, type DocumentData, type Firestore,
} from 'firebase/firestore'
import {
  allDenied, allowed, CODE, denied, inviteDoc, mondayOf, monthlyDoc, newSpace, spaceDoc, useRulesEnv, weekDoc, weekOn,
} from './helpers.ts'

const { db, seed } = useRulesEnv()

const ZONE = 'Europe/Berlin'
const ABC = ['alice', 'bob', 'carol']
const spaceRef = (fs: Firestore, id = 's1') => doc(fs, `spaces/${id}`)
const periodRef = (fs: Firestore, coll: 'weeks' | 'monthly', id: string) => doc(fs, `spaces/s1/${coll}/${id}`)
const judgesOf = async () => (await getDoc(spaceRef(db('alice')))).data()!.judges

describe('judges on the space', () => {
  test('the creator may start as a judge', async () => {
    const alice = db('alice')
    await allowed(setDoc(spaceRef(alice, 's1'), newSpace('alice', { judges: [] })))
    await allowed(setDoc(spaceRef(alice, 's2'), newSpace('alice', { judges: ['alice'] })))
    // The 12 keys of an older client.
    await allowed(setDoc(spaceRef(alice, 's3'), newSpace('alice')))
    await allDenied({
      'someone else': () => setDoc(spaceRef(alice, 's4'), newSpace('alice', { judges: ['bob'] })),
      'self twice': () => setDoc(spaceRef(alice, 's4'), newSpace('alice', { judges: ['alice', 'alice'] })),
      'a string': () => setDoc(spaceRef(alice, 's4'), newSpace('alice', { judges: 'alice' })),
      'a map': () => setDoc(spaceRef(alice, 's4'), newSpace('alice', { judges: { alice: true } })),
    })
  })

  test('a member switches Only Rate Friends for themselves only', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC, { judges: ['carol'] }), 'spaces/s2': spaceDoc(ABC), 'spaces/s3': spaceDoc(ABC, { judges: ['bob', 'carol'] }) })
    const bob = db('bob')
    await allowed(updateDoc(spaceRef(bob), { judges: arrayUnion('bob') }))
    expect(await judgesOf()).toEqual(['carol', 'bob'])
    await allowed(updateDoc(spaceRef(bob), { judges: arrayRemove('bob') }))
    // The first judge in a space with no list yet.
    await allowed(updateDoc(spaceRef(bob, 's2'), { judges: arrayUnion('bob') }))
    await allDenied({
      'add someone else': () => updateDoc(spaceRef(bob), { judges: arrayUnion('alice') }),
      'remove someone else': () => updateDoc(spaceRef(bob), { judges: arrayRemove('carol') }),
      'self twice': () => updateDoc(spaceRef(bob), { judges: ['carol', 'bob', 'bob'] }),
      'join and reorder the others': () => updateDoc(spaceRef(db('alice'), 's3'), { judges: ['carol', 'bob', 'alice'] }),
      'delete the list': () => updateDoc(spaceRef(bob), { judges: deleteField() }),
      'not a list': () => updateDoc(spaceRef(bob), { judges: 'bob' }),
      'with a rename': () => updateDoc(spaceRef(bob), { judges: arrayUnion('bob'), name: 'Judges' }),
      'a non-member': () => updateDoc(spaceRef(db('zoe')), { judges: arrayUnion('zoe') }),
      'signed out': () => updateDoc(spaceRef(db()), { judges: arrayUnion('bob') }),
    })
  })

  test('joining, leaving and removal touch only that person\'s entry', async () => {
    await seed({
      'spaces/s1': spaceDoc(ABC, { judges: ['carol', 'dave'] }),
      [`invites/${CODE}`]: inviteDoc('s1', 'alice'),
    })
    const join = (uid: string, judges?: unknown) => {
      const fs = db(uid)
      const batch = writeBatch(fs)
      batch.set(doc(fs, `spaces/s1/joins/${uid}`), { code: CODE, createdAt: serverTimestamp() })
      batch.update(spaceRef(fs), { memberIds: arrayUnion(uid), [`joinedAt.${uid}`]: serverTimestamp(), ...(judges ? { judges } : {}) })
      return batch.commit()
    }
    const leave = (fs: Firestore, uid: string, judges?: unknown) =>
      updateDoc(spaceRef(fs), {
        memberIds: arrayRemove(uid), [`joinedAt.${uid}`]: deleteField(), [`leftAt.${uid}`]: serverTimestamp(), ...(judges ? { judges } : {}),
      })
    await allDenied({
      'join adding someone else': () => join('erin', arrayUnion('erin', 'bob')),
      'join dropping someone else': () => join('erin', arrayRemove('carol')),
      'leave dropping someone else': () => leave(db('bob'), 'bob', arrayRemove('carol')),
      'remove dropping a third member': () => leave(db('alice'), 'carol', arrayRemove('carol', 'dave')),
    })
    // dave left earlier from an older client, leaving a stale entry: rejoining as a player clears it.
    await allowed(join('dave', arrayRemove('dave')))
    await allowed(join('erin', arrayUnion('erin')))
    // An older client's join leaves judges alone.
    await allowed(join('fred'))
    expect(await judgesOf()).toEqual(['carol', 'erin'])
    await allowed(leave(db('carol'), 'carol', arrayRemove('carol')))
    await allowed(leave(db('fred'), 'fred'))
    await allowed(leave(db('alice'), 'erin', arrayRemove('erin')))
    expect(await judgesOf()).toEqual([])
  })
})

describe('the snapshot on weeks', () => {
  const next = mondayOf(ZONE, 1)

  test('a week stores the space\'s judges, or nothing when nobody judges', async () => {
    await seed({ 'spaces/s1': spaceDoc(ABC), 'spaces/s2': spaceDoc(ABC, { judges: ['carol'] }), 'spaces/s3': spaceDoc(ABC, { judges: [] }) })
    const alice = db('alice')
    const create = (space: string, extra: DocumentData = {}) => setDoc(doc(alice, `spaces/${space}/weeks/${next}`), weekOn(ABC, next, ZONE, undefined, extra))
    await allowed(create('s1'))
    await allowed(create('s3'))
    await allDenied({
      // An older client's 6-key doc would make carol play with an empty list (0%).
      'no snapshot while someone judges': () => create('s2'),
      'a different list': () => create('s2', { judges: ['bob'] }),
      'an empty list': () => create('s2', { judges: [] }),
      'a judge where nobody judges': () => create('s1', { judges: ['carol'] }),
    })
    await allowed(create('s2', { judges: ['carol'] }))
  })
})

describe('syncsPeriod', () => {
  for (const coll of ['weeks', 'monthly'] as const) {
    const period = (phase: 'planning' | 'active', members: string[], judges: string[] = []) =>
      coll === 'weeks' ? { ...weekDoc(phase, members), judges } : monthlyDoc(phase, members, judges)

    test(`${coll}: before the lock, members join and judges follow the space`, async () => {
      await seed({
        'spaces/s1': spaceDoc([...ABC, 'dave'], { judges: ['carol', 'dave'] }),
        [`spaces/s1/${coll}/P`]: period('planning', ABC, ['carol']),
        [`spaces/s1/${coll}/L`]: period('active', ABC, ['carol']),
      })
      const bob = db('bob')
      await allDenied({
        'after the lock': () => updateDoc(periodRef(bob, coll, 'L'), { judges: ['carol', 'dave'] }),
        'judges not the space\'s': () => updateDoc(periodRef(bob, coll, 'P'), { judges: ['dave'], members: arrayUnion('dave') }),
        'judges reordered': () => updateDoc(periodRef(bob, coll, 'P'), { judges: ['dave', 'carol'] }),
        'adds a non-member': () => updateDoc(periodRef(bob, coll, 'P'), { members: arrayUnion('zoe'), judges: ['carol', 'dave'] }),
        'drops a member': () => updateDoc(periodRef(bob, coll, 'P'), { members: ['alice', 'bob'], judges: ['carol', 'dave'] }),
        'adds twice': () => updateDoc(periodRef(bob, coll, 'P'), { members: [...ABC, 'dave', 'dave'], judges: ['carol', 'dave'] }),
        'also moves the lock': () => updateDoc(periodRef(bob, coll, 'P'), { judges: ['carol', 'dave'], lockAt: Timestamp.now() }),
        'a non-member writes': () => updateDoc(periodRef(db('zoe'), coll, 'P'), { judges: ['carol', 'dave'] }),
      })
      await allowed(updateDoc(periodRef(bob, coll, 'P'), { judges: ['carol', 'dave'] }))
      await allowed(updateDoc(periodRef(bob, coll, 'P'), { members: arrayUnion('dave'), judges: ['carol', 'dave'] }))
      expect((await getDoc(periodRef(bob, coll, 'P'))).data()?.members).toEqual([...ABC, 'dave'])
    })

    test(`${coll}: a judge switch and its periods go in one transaction`, async () => {
      await seed({
        'spaces/s1': spaceDoc(ABC),
        [`spaces/s1/${coll}/P`]: period('planning', ABC),
        // Locked while carol judged.
        [`spaces/s1/${coll}/L`]: period('active', ABC, ['carol']),
      })
      const bob = db('bob')
      await allowed(runTransaction(bob, async (tx) => {
        await tx.get(spaceRef(bob))
        tx.update(spaceRef(bob), { judges: arrayUnion('bob') })
        tx.update(periodRef(bob, coll, 'P'), { judges: ['bob'] })
      }))
      expect((await getDoc(periodRef(bob, coll, 'P'))).data()?.judges).toEqual(['bob'])
      // A locked period keeps the role it locked with.
      await denied(runTransaction(bob, async (tx) => {
        await tx.get(spaceRef(bob))
        tx.update(spaceRef(bob), { judges: arrayRemove('bob') })
        tx.update(periodRef(bob, coll, 'L'), { judges: [] })
      }))
    })
  }
})

describe('judges have no list', () => {
  const tasks = [{ id: 't1', title: 'Edit the reel' }]
  const plan = (extra: DocumentData = {}) => ({ tasks, updatedAt: serverTimestamp(), ...extra })

  test('a judge can\'t plan a week or a monthly list; a player can', async () => {
    await seed({
      'spaces/s1': spaceDoc(ABC, { judges: ['carol'] }),
      'spaces/s1/weeks/W': { ...weekDoc('planning', ABC), judges: ['carol'] },
      'spaces/s1/monthly/2026-11': monthlyDoc('planning', ABC, ['carol']),
    })
    await allDenied({
      'week': () => setDoc(doc(db('carol'), 'spaces/s1/weeks/W/plans/carol'), plan()),
      'monthly list': () => setDoc(doc(db('carol'), 'spaces/s1/monthly/2026-11/plans/carol'), plan()),
    })
    await allowed(setDoc(doc(db('bob'), 'spaces/s1/weeks/W/plans/bob'), plan()))
    await allowed(setDoc(doc(db('bob'), 'spaces/s1/monthly/2026-11/plans/bob'), plan()))
  })

  test('after the lock a judge can\'t append; someone who became a judge after the lock still can', async () => {
    // carol judged when the week locked; bob turned judge afterwards, so the week still has him playing.
    await seed({
      'spaces/s1': spaceDoc(ABC, { judges: ['carol', 'bob'] }),
      'spaces/s1/weeks/W': { ...weekDoc('active', ABC), judges: ['carol'] },
    })
    const append = (uid: string) => setDoc(doc(db(uid), `spaces/s1/weeks/W/plans/${uid}`), {
      tasks: [{ id: 'late', title: 'Late' }], added: { late: serverTimestamp() }, updatedAt: serverTimestamp(),
    })
    await denied(append('carol'))
    await allowed(append('bob'))
  })
})

describe('judges review', () => {
  test('a judge reviews and submits; the reveal waits for them', async () => {
    await seed({
      'spaces/s1': spaceDoc(ABC, { judges: ['carol'] }),
      'spaces/s1/weeks/W': { ...weekDoc('review', ABC, ['alice', 'bob']), judges: ['carol'] },
      'spaces/s1/weeks/W/reviews/alice_bob': { reviewerId: 'alice', revieweeId: 'bob', marks: { t1: 1 }, submittedAt: Timestamp.now() },
    })
    // alice and bob are in; carol, a judge, isn't yet: nothing is revealed.
    await denied(getDocs(collection(db('alice'), 'spaces/s1/weeks/W/reviews')))
    const carol = db('carol')
    const batch = writeBatch(carol)
    batch.set(doc(carol, 'spaces/s1/weeks/W/reviews/carol_alice'), { reviewerId: 'carol', revieweeId: 'alice', marks: { t1: 1 }, submittedAt: serverTimestamp() })
    batch.set(doc(carol, 'spaces/s1/weeks/W/reviews/carol_bob'), { reviewerId: 'carol', revieweeId: 'bob', marks: { t1: 0.5 }, submittedAt: serverTimestamp() })
    batch.update(doc(carol, 'spaces/s1/weeks/W'), { submittedBy: arrayUnion('carol') })
    await allowed(batch.commit())
    expect((await getDocs(collection(db('alice'), 'spaces/s1/weeks/W/reviews'))).size).toBe(3)
  })
})
