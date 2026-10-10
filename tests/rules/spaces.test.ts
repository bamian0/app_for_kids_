// spaces/{id}, spaces/{id}/joins/{uid}, invites/{code}.
import { describe, test } from 'vitest'
import {
  arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, getDocs, query, serverTimestamp,
  setDoc, Timestamp, updateDoc, where, writeBatch, type DocumentData, type Firestore,
} from 'firebase/firestore'
import { allDenied, allowed, CODE, denied, inviteDoc, newSpace, OTHER_CODE, spaceDoc, useRulesEnv } from './helpers.ts'

const { db, seed } = useRulesEnv()

/** joinSpace as the data layer does it: one batch with the proof doc and the space update. */
function join(fs: Firestore, uid: string, spaceId: string, code: string, spacePatch: DocumentData = {}) {
  const batch = writeBatch(fs)
  batch.set(doc(fs, `spaces/${spaceId}/joins/${uid}`), { code, createdAt: serverTimestamp() })
  batch.update(doc(fs, `spaces/${spaceId}`), {
    memberIds: arrayUnion(uid),
    [`joinedAt.${uid}`]: serverTimestamp(),
    ...spacePatch,
  })
  return batch.commit()
}

function leave(fs: Firestore, uid: string, spaceId: string) {
  return updateDoc(doc(fs, `spaces/${spaceId}`), { memberIds: arrayRemove(uid), [`joinedAt.${uid}`]: deleteField() })
}

const twoSpaces = () =>
  seed({
    'spaces/s1': spaceDoc(['alice', 'bob']),
    'spaces/s2': spaceDoc(['zoe'], { inviteCode: OTHER_CODE }),
    [`invites/${CODE}`]: inviteDoc('s1', 'alice'),
    [`invites/${OTHER_CODE}`]: inviteDoc('s2', 'zoe'),
  })

describe('spaces: create', () => {
  test('createSpace writes the space, then its invite', async () => {
    const alice = db('alice')
    await allowed(setDoc(doc(alice, 'spaces/s1'), newSpace('alice')))
    await allowed(
      setDoc(doc(alice, `invites/${CODE}`), {
        spaceId: 's1', spaceName: 'Film crew', inviterName: 'Alex', createdBy: 'alice', createdAt: serverTimestamp(),
      }),
    )
    await allowed(getDoc(doc(alice, 'spaces/s1')))
  })

  test('invalid spaces are rejected', async () => {
    const ref = doc(db('alice'), 'spaces/s1')
    await allDenied({
      'signed out': () => setDoc(doc(db(), 'spaces/s1'), newSpace('alice')),
      'owner is someone else': () => setDoc(ref, newSpace('alice', { ownerId: 'bob' })),
      'extra members': () => setDoc(ref, newSpace('alice', { memberIds: ['alice', 'bob'] })),
      'members without self': () => setDoc(ref, newSpace('alice', { memberIds: ['bob'] })),
      'joinedAt client time': () => setDoc(ref, newSpace('alice', { joinedAt: { alice: Timestamp.now() } })),
      'joinedAt extra uid': () => setDoc(ref, newSpace('alice', { joinedAt: { alice: serverTimestamp(), bob: serverTimestamp() } })),
      'threshold 80': () => setDoc(ref, newSpace('alice', { threshold: 80 })),
      'latePenalty 0': () => setDoc(ref, newSpace('alice', { latePenalty: 0 })),
      'empty name': () => setDoc(ref, newSpace('alice', { name: '' })),
      'name 41 chars': () => setDoc(ref, newSpace('alice', { name: 'x'.repeat(41) })),
      'reward 121 chars': () => setDoc(ref, newSpace('alice', { reward: 'x'.repeat(121) })),
      'blank penalty': () => setDoc(ref, newSpace('alice', { penalty: ' ' })),
      'bad timezone': () => setDoc(ref, newSpace('alice', { timezone: 'Europe/Berlin; drop' })),
      'bad invite code': () => setDoc(ref, newSpace('alice', { inviteCode: 'abcd1234' })),
      'client createdAt': () => setDoc(ref, newSpace('alice', { createdAt: Timestamp.now() })),
      'extra key': () => setDoc(ref, newSpace('alice', { premium: true })),
    })
  })

  test('nobody can delete a space', async () => {
    await twoSpaces()
    await denied(deleteDoc(doc(db('alice'), 'spaces/s1')))
  })
})

describe('spaces: read', () => {
  test('members read; non-members and signed-out users cannot', async () => {
    await twoSpaces()
    await allowed(getDoc(doc(db('bob'), 'spaces/s1')))
    await denied(getDoc(doc(db('zoe'), 'spaces/s1')))
    await denied(getDoc(doc(db(), 'spaces/s1')))
  })

  test('my spaces query (array-contains) works; listing all spaces does not', async () => {
    await twoSpaces()
    const bob = db('bob')
    await allowed(getDocs(query(collection(bob, 'spaces'), where('memberIds', 'array-contains', 'bob'))))
    await denied(getDocs(collection(bob, 'spaces')))
    await denied(getDocs(query(collection(bob, 'spaces'), where('memberIds', 'array-contains', 'zoe'))))
  })
})

describe('spaces: update', () => {
  test('a member edits name, reward and penalty', async () => {
    await twoSpaces()
    await allowed(updateDoc(doc(db('bob'), 'spaces/s1'), { name: 'Crew 2', reward: 'Sushi', penalty: 'Dishes' }))
  })

  test('other edits are rejected', async () => {
    await twoSpaces()
    const ref = doc(db('bob'), 'spaces/s1')
    await allDenied({
      'non-member edits name': () => updateDoc(doc(db('zoe'), 'spaces/s1'), { name: 'Mine now' }),
      'name too long': () => updateDoc(ref, { name: 'x'.repeat(41) }),
      'blank reward': () => updateDoc(ref, { reward: '' }),
      'threshold': () => updateDoc(ref, { threshold: 50 }),
      'latePenalty': () => updateDoc(ref, { latePenalty: 0 }),
      'ownerId': () => updateDoc(ref, { ownerId: 'bob' }),
      'timezone': () => updateDoc(ref, { timezone: 'UTC' }),
      'inviteCode': () => updateDoc(ref, { inviteCode: OTHER_CODE }),
      'createdAt': () => updateDoc(ref, { createdAt: serverTimestamp() }),
      'add another member': () => updateDoc(ref, { memberIds: arrayUnion('zoe'), 'joinedAt.zoe': serverTimestamp() }),
      'extra key': () => updateDoc(ref, { theme: 'dark' }),
    })
  })

  test('a member leaves by removing self from memberIds and joinedAt', async () => {
    await twoSpaces()
    await allowed(leave(db('bob'), 'bob', 's1'))
    await denied(getDoc(doc(db('bob'), 'spaces/s1')))
  })

  test('leaving cannot remove others or leave traces behind', async () => {
    await twoSpaces()
    const bob = db('bob')
    await allDenied({
      'remove someone else': () => leave(bob, 'alice', 's1'),
      'keep joinedAt': () => updateDoc(doc(bob, 'spaces/s1'), { memberIds: arrayRemove('bob') }),
      'remove self and another': () =>
        updateDoc(doc(bob, 'spaces/s1'), {
          memberIds: arrayRemove('bob', 'alice'), 'joinedAt.bob': deleteField(), 'joinedAt.alice': deleteField(),
        }),
      'leave and rename': () =>
        updateDoc(doc(bob, 'spaces/s1'), { memberIds: arrayRemove('bob'), 'joinedAt.bob': deleteField(), name: 'Bye' }),
    })
  })
})

describe('spaces: join', () => {
  test('a non-member joins with the invite code in one batch', async () => {
    await twoSpaces()
    const carol = db('carol')
    await allowed(getDoc(doc(carol, `invites/${CODE}`)))
    await allowed(join(carol, 'carol', 's1', CODE))
    const snap = await getDoc(doc(carol, 'spaces/s1'))
    if (JSON.stringify(snap.data()?.memberIds) !== JSON.stringify(['alice', 'bob', 'carol'])) throw new Error('memberIds not appended')
  })

  test('a member who left can rejoin (updates their joins doc)', async () => {
    await twoSpaces()
    const carol = db('carol')
    await allowed(join(carol, 'carol', 's1', CODE))
    await allowed(leave(carol, 'carol', 's1'))
    await allowed(join(carol, 'carol', 's1', CODE))
  })

  test('joining needs a valid proof written in the same batch', async () => {
    await twoSpaces()
    const carol = db('carol')
    await allDenied({
      'no joins doc': () =>
        updateDoc(doc(carol, 'spaces/s1'), { memberIds: arrayUnion('carol'), 'joinedAt.carol': serverTimestamp() }),
      'code of another space': () => join(carol, 'carol', 's1', OTHER_CODE),
      'unknown code': () => join(carol, 'carol', 's1', 'QQQQ2222'),
      'malformed code': () => join(carol, 'carol', 's1', 'abc'),
      'joinedAt client time': () => join(carol, 'carol', 's1', CODE, { 'joinedAt.carol': Timestamp.now() }),
      'also adds a friend': () => join(carol, 'carol', 's1', CODE, { memberIds: arrayUnion('carol', 'dave'), 'joinedAt.dave': serverTimestamp() }),
      'also renames': () => join(carol, 'carol', 's1', CODE, { name: 'Taken over' }),
      'joins as someone else': () => join(carol, 'dave', 's1', CODE),
    })
  })

  test('a stale proof from an earlier join does not let a former member back in', async () => {
    await twoSpaces()
    await seed({ 'spaces/s1/joins/carol': { code: CODE, createdAt: Timestamp.fromMillis(Date.now() - 86_400_000) } })
    await denied(
      updateDoc(doc(db('carol'), 'spaces/s1'), { memberIds: arrayUnion('carol'), 'joinedAt.carol': serverTimestamp() }),
    )
  })

  test('a space is full at 8 members', async () => {
    const seven = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']
    await seed({ 'spaces/s1': spaceDoc(seven), [`invites/${CODE}`]: inviteDoc('s1', 'm1') })
    await allowed(join(db('m8'), 'm8', 's1', CODE))
    await denied(join(db('m9'), 'm9', 's1', CODE))
  })

  test('a member cannot join twice', async () => {
    await twoSpaces()
    await denied(join(db('bob'), 'bob', 's1', CODE))
  })
})

describe('spaces/{id}/joins/{uid}', () => {
  test('own proof with a valid code; readable by self only', async () => {
    await twoSpaces()
    const carol = db('carol')
    await allowed(setDoc(doc(carol, 'spaces/s1/joins/carol'), { code: CODE, createdAt: serverTimestamp() }))
    await allowed(getDoc(doc(carol, 'spaces/s1/joins/carol')))
    await denied(getDoc(doc(db('alice'), 'spaces/s1/joins/carol')))
    await denied(getDocs(collection(carol, 'spaces/s1/joins')))
  })

  test('invalid proofs are rejected', async () => {
    await twoSpaces()
    const carol = db('carol')
    const ref = doc(carol, 'spaces/s1/joins/carol')
    await allDenied({
      'for someone else': () => setDoc(doc(carol, 'spaces/s1/joins/dave'), { code: CODE, createdAt: serverTimestamp() }),
      'wrong space code': () => setDoc(ref, { code: OTHER_CODE, createdAt: serverTimestamp() }),
      'unknown code': () => setDoc(ref, { code: 'QQQQ2222', createdAt: serverTimestamp() }),
      'client createdAt': () => setDoc(ref, { code: CODE, createdAt: Timestamp.now() }),
      'extra key': () => setDoc(ref, { code: CODE, createdAt: serverTimestamp(), note: 'hi' }),
      'delete': () => deleteDoc(ref),
    })
  })
})

describe('invites/{code}', () => {
  test('signed-in users can get an invite; nobody can list them', async () => {
    await twoSpaces()
    await allowed(getDoc(doc(db('carol'), `invites/${CODE}`)))
    await denied(getDoc(doc(db(), `invites/${CODE}`)))
    await denied(getDocs(collection(db('carol'), 'invites')))
    await denied(getDocs(query(collection(db('alice'), 'invites'), where('spaceId', '==', 's1'))))
  })

  test('only a member creates the invite for their space code', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']) })
    const invite = (by: string, extra: DocumentData = {}) => ({
      spaceId: 's1', spaceName: 'Film crew', inviterName: 'Bob', createdBy: by, createdAt: serverTimestamp(), ...extra,
    })
    await allDenied({
      'non-member': () => setDoc(doc(db('zoe'), `invites/${CODE}`), invite('zoe')),
      'createdBy someone else': () => setDoc(doc(db('bob'), `invites/${CODE}`), invite('alice')),
      'code is not the space code': () => setDoc(doc(db('bob'), `invites/${OTHER_CODE}`), invite('bob')),
      'malformed code': () => setDoc(doc(db('bob'), 'invites/abcd1234'), invite('bob')),
      'unknown space': () => setDoc(doc(db('bob'), `invites/${CODE}`), invite('bob', { spaceId: 'nope' })),
      'client createdAt': () => setDoc(doc(db('bob'), `invites/${CODE}`), invite('bob', { createdAt: Timestamp.now() })),
      'spaceName too long': () => setDoc(doc(db('bob'), `invites/${CODE}`), invite('bob', { spaceName: 'x'.repeat(41) })),
      'extra key': () => setDoc(doc(db('bob'), `invites/${CODE}`), invite('bob', { uses: 0 })),
    })
    await allowed(setDoc(doc(db('bob'), `invites/${CODE}`), invite('bob')))
  })

  test('invites cannot be updated', async () => {
    await twoSpaces()
    await denied(updateDoc(doc(db('alice'), `invites/${CODE}`), { spaceId: 's2' }))
    await denied(setDoc(doc(db('alice'), `invites/${CODE}`), { ...inviteDoc('s1', 'alice'), createdAt: serverTimestamp() }))
  })

  test('the creator or a member can delete; others cannot', async () => {
    await twoSpaces()
    await denied(deleteDoc(doc(db('zoe'), `invites/${CODE}`)))
    await denied(deleteDoc(doc(db(), `invites/${CODE}`)))
    await allowed(deleteDoc(doc(db('bob'), `invites/${CODE}`)))
    await seed({ [`invites/${CODE}`]: inviteDoc('s1', 'alice'), 'spaces/s1': spaceDoc(['bob']) })
    await allowed(deleteDoc(doc(db('alice'), `invites/${CODE}`)))
  })
})
