// spaces/{id}, spaces/{id}/joins/{uid}, invites/{code}.
import { describe, expect, test } from 'vitest'
import {
  arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, getDocs, query, serverTimestamp,
  setDoc, Timestamp, updateDoc, where, writeBatch, type DocumentData, type Firestore,
} from 'firebase/firestore'
import {
  addMonths, allDenied, allowed, CODE, DAY, denied, HOUR, inviteDoc, monthStr, monthWeeks, newSpace, OTHER_CODE, spaceDoc, ts,
  useRulesEnv, USUAL,
} from './helpers.ts'

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

/** leaveSpace/removeMember as the data layer does it: leftAt[uid] = now, unless the patch says otherwise. */
function leave(fs: Firestore, uid: string, spaceId: string, spacePatch: DocumentData = {}) {
  const ownLeftAt = Object.keys(spacePatch).some((k) => k === 'leftAt' || k.startsWith('leftAt.')) ? {} : { [`leftAt.${uid}`]: serverTimestamp() }
  return updateDoc(doc(fs, `spaces/${spaceId}`), { memberIds: arrayRemove(uid), [`joinedAt.${uid}`]: deleteField(), ...ownLeftAt, ...spacePatch })
}

/** An older client's leave: memberIds and joinedAt only. */
function leaveUnrecorded(fs: Firestore, uid: string, spaceId: string, spacePatch: DocumentData = {}) {
  return updateDoc(doc(fs, `spaces/${spaceId}`), { memberIds: arrayRemove(uid), [`joinedAt.${uid}`]: deleteField(), ...spacePatch })
}

/** resetInviteCode as the data layer does it: the space's new code, its invite, the old invite gone. */
function rotate(fs: Firestore, uid: string, next: string, invitePatch: DocumentData = {}) {
  const batch = writeBatch(fs)
  batch.update(doc(fs, 'spaces/s1'), { inviteCode: next })
  batch.set(doc(fs, `invites/${next}`), {
    spaceId: 's1', spaceName: 'Film crew', reward: 'Dinner on me', penalty: 'You buy coffee for a week',
    inviterName: 'Alex', createdBy: uid, createdAt: serverTimestamp(), ...invitePatch,
  })
  batch.delete(doc(fs, `invites/${CODE}`))
  return batch.commit()
}

/** Members joined a day apart, in this order. */
function staggered(memberIds: string[], extra: DocumentData = {}): DocumentData {
  const t0 = Date.now() - 30 * DAY
  return spaceDoc(memberIds, { joinedAt: Object.fromEntries(memberIds.map((uid, i) => [uid, ts(t0 + i * DAY)])), ...extra })
}

const twoSpaces = () =>
  seed({
    'spaces/s1': spaceDoc(['alice', 'bob']),
    'spaces/s2': spaceDoc(['zoe'], { inviteCode: OTHER_CODE }),
    [`invites/${CODE}`]: inviteDoc('s1', 'alice'),
    [`invites/${OTHER_CODE}`]: inviteDoc('s2', 'zoe'),
  })

/** Freezes for this and last UTC month (the months the rules check on a house-stakes edit), made
 *  after either could complete, so a stakes edit finds nothing to freeze first. */
const frozenRecently = (spaceId = 's1') => {
  const later = ts(Date.now() + DAY)
  const stakes = { reward: 'Dinner on me', penalty: 'You buy coffee for a week', createdAt: later }
  return seed({ [`spaces/${spaceId}/months/${monthStr(Date.now())}`]: stakes, [`spaces/${spaceId}/months/${addMonths(monthStr(Date.now()), -1)}`]: stakes })
}

describe('spaces: create', () => {
  test('createSpace writes the space and its invite in one batch', async () => {
    const alice = db('alice')
    const batch = writeBatch(alice)
    batch.set(doc(alice, 'spaces/s1'), newSpace('alice'))
    batch.set(doc(alice, `invites/${CODE}`), {
      spaceId: 's1', spaceName: 'Film crew', reward: 'Dinner on me', penalty: 'You buy coffee for a week',
      inviterName: 'Alex', createdBy: 'alice', createdAt: serverTimestamp(),
    })
    await allowed(batch.commit())
    await allowed(getDoc(doc(alice, 'spaces/s1')))
  })

  test('utcOffsetMin is a whole number of minutes from UTC−12 to UTC+14', async () => {
    const alice = db('alice')
    await allowed(setDoc(doc(alice, 'spaces/s1'), newSpace('alice', { timezone: 'Pacific/Kiritimati', utcOffsetMin: 840 })))
    await allowed(setDoc(doc(alice, 'spaces/s2'), newSpace('alice', { timezone: 'Etc/GMT+12', utcOffsetMin: -720 })))
    await allowed(setDoc(doc(alice, 'spaces/s3'), newSpace('alice', { timezone: 'Asia/Kathmandu', utcOffsetMin: 345 })))
    const ref = doc(alice, 'spaces/s4')
    const { utcOffsetMin: _, ...without } = newSpace('alice')
    await allDenied({
      'missing': () => setDoc(ref, without),
      'a float': () => setDoc(ref, newSpace('alice', { utcOffsetMin: 60.5 })),
      'a string': () => setDoc(ref, newSpace('alice', { utcOffsetMin: '-420' })),
      'UTC+15': () => setDoc(ref, newSpace('alice', { utcOffsetMin: 900 })),
      'UTC−13': () => setDoc(ref, newSpace('alice', { utcOffsetMin: -780 })),
    })
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
  test('anyone renames; only the owner changes the house stakes (SPEC §9.7)', async () => {
    await twoSpaces()
    await frozenRecently()
    await allowed(updateDoc(doc(db('bob'), 'spaces/s1'), { name: 'Crew 2' }))
    // An older client sends all three; unchanged stakes aren't a change.
    await allowed(updateDoc(doc(db('bob'), 'spaces/s1'), { name: 'Crew 3', reward: 'Dinner on me', penalty: 'You buy coffee for a week' }))
    await allDenied({
      'a member changes the reward': () => updateDoc(doc(db('bob'), 'spaces/s1'), { reward: 'Sushi' }),
      'a member changes both, with a rename': () => updateDoc(doc(db('bob'), 'spaces/s1'), { name: 'Crew 4', reward: 'Sushi', penalty: 'Dishes' }),
    })
    await allowed(updateDoc(doc(db('alice'), 'spaces/s1'), { name: 'Crew 5', reward: 'Sushi', penalty: 'Dishes' }))
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
      'utcOffsetMin': () => updateDoc(ref, { utcOffsetMin: -600 }),
      'leftAt alone': () => updateDoc(ref, { 'leftAt.zoe': serverTimestamp() }),
      'inviteCode': () => updateDoc(ref, { inviteCode: OTHER_CODE }),
      'createdAt': () => updateDoc(ref, { createdAt: serverTimestamp() }),
      'add another member': () => updateDoc(ref, { memberIds: arrayUnion('zoe'), 'joinedAt.zoe': serverTimestamp() }),
      'extra key': () => updateDoc(ref, { theme: 'dark' }),
    })
  })

  test('a member leaves by removing self from memberIds and joinedAt, recording when', async () => {
    await twoSpaces()
    await allowed(leave(db('bob'), 'bob', 's1', { 'leftAt.bob': serverTimestamp() }))
    await denied(getDoc(doc(db('bob'), 'spaces/s1')))
  })

  test('leaving or being removed must record leftAt', async () => {
    // Without it, closed weeks forget the leaver: whoever owed them a review stops being charged for it
    // (the owner could erase their own penalty that way), and nobody can settle up with them.
    await seed({ 'spaces/s1': staggered(['alice', 'bob', 'carol']) })
    await allDenied({
      'a member leaves': () => leaveUnrecorded(db('carol'), 'carol', 's1'),
      'the owner removes someone': () => leaveUnrecorded(db('alice'), 'carol', 's1'),
      'the owner leaves and hands over': () => leaveUnrecorded(db('alice'), 'alice', 's1', { ownerId: 'bob' }),
      'leftAt deleted instead': () => leave(db('carol'), 'carol', 's1', { 'leftAt.carol': deleteField() }),
    })
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob', 'carol'], { leftAt: { carol: ts(Date.now() - DAY) } }) })
    // A member who left before and rejoined records the new departure.
    await allowed(leave(db('carol'), 'carol', 's1'))
  })

  test('an owner who leaves hands the space to the earliest-joined member', async () => {
    await seed({ 'spaces/s1': staggered(['alice', 'bob', 'carol', 'dave']) })
    const alice = db('alice')
    await allDenied({
      'keeps the ownership': () => leave(alice, 'alice', 's1'),
      'to a later joiner': () => leave(alice, 'alice', 's1', { ownerId: 'carol' }),
      'to someone outside': () => leave(alice, 'alice', 's1', { ownerId: 'zoe' }),
      'a member hands it over': () => leave(db('carol'), 'carol', 's1', { ownerId: 'bob' }),
    })
    await allowed(leave(alice, 'alice', 's1', { ownerId: 'bob', 'leftAt.alice': serverTimestamp() }))
    // The last one out keeps the (now empty) space's owner as is.
    await seed({ 'spaces/s2': spaceDoc(['zoe']) })
    await allowed(leave(db('zoe'), 'zoe', 's2'))
  })

  test('the owner removes another member', async () => {
    await seed({ 'spaces/s1': staggered(['alice', 'bob', 'carol', 'dave']) })
    await allowed(leave(db('alice'), 'bob', 's1', { 'leftAt.bob': serverTimestamp() }))
    expect((await getDoc(doc(db('alice'), 'spaces/s1'))).data()?.memberIds).toEqual(['alice', 'carol', 'dave'])
    await allDenied({
      'a member removes another': () => leave(db('carol'), 'alice', 's1'),
      'two at once': () =>
        updateDoc(doc(db('alice'), 'spaces/s1'), { memberIds: ['alice'], 'joinedAt.carol': deleteField(), 'joinedAt.dave': deleteField() }),
      'keeps their joinedAt': () => updateDoc(doc(db('alice'), 'spaces/s1'), { memberIds: arrayRemove('carol') }),
      'and renames': () => leave(db('alice'), 'carol', 's1', { name: 'Mine' }),
      'and takes over leftAt of another': () => leave(db('alice'), 'carol', 's1', { 'leftAt.zoe': serverTimestamp() }),
      'with a backdated leftAt': () => leave(db('alice'), 'carol', 's1', { 'leftAt.carol': Timestamp.now() }),
    })
  })

  test('a space whose owner already left goes to its earliest-joined member', async () => {
    await seed({ 'spaces/s1': staggered(['bob', 'carol'], { ownerId: 'gone' }), 'spaces/s2': staggered(['bob', 'carol']) })
    await allDenied({
      'to a later joiner': () => updateDoc(doc(db('carol'), 'spaces/s1'), { ownerId: 'carol' }),
      'while the owner is here': () => updateDoc(doc(db('bob'), 'spaces/s2'), { ownerId: 'carol' }),
      'a stranger': () => updateDoc(doc(db('zoe'), 'spaces/s1'), { ownerId: 'bob' }),
    })
    await allowed(updateDoc(doc(db('carol'), 'spaces/s1'), { ownerId: 'bob' }))
  })

  test('the owner rotates the invite code; the old code stops working', async () => {
    await twoSpaces()
    await allDenied({
      'a member rotates': () => rotate(db('bob'), 'bob', OTHER_CODE),
      'invite of another space name': () => rotate(db('alice'), 'alice', 'QQQQ2222', { spaceName: 'Other' }),
      'malformed code': () => updateDoc(doc(db('alice'), 'spaces/s1'), { inviteCode: 'abc' }),
      'with a rename': () => updateDoc(doc(db('alice'), 'spaces/s1'), { inviteCode: 'QQQQ2222', name: 'New' }),
    })
    await allowed(rotate(db('alice'), 'alice', 'QQQQ2222'))
    expect((await getDoc(doc(db(), `invites/${CODE}`))).exists()).toBe(false)
    await denied(setDoc(doc(db('alice'), `invites/${CODE}`), { ...inviteDoc('s1', 'alice'), createdAt: serverTimestamp() }))
    // Even if the old invite doc came back, its code no longer gets anyone in.
    await seed({ [`invites/${CODE}`]: inviteDoc('s1', 'alice') })
    await denied(join(db('carol'), 'carol', 's1', CODE))
    await allowed(join(db('dave'), 'dave', 's1', 'QQQQ2222'))
  })

  test('leaving cannot remove others or leave traces behind', async () => {
    // (bob is not the owner here; the owner removing someone is tested above.)
    await twoSpaces()
    const bob = db('bob')
    await allDenied({
      'remove someone else': () => leave(bob, 'alice', 's1'),
      'keep joinedAt': () => updateDoc(doc(bob, 'spaces/s1'), { memberIds: arrayRemove('bob') }),
      'remove self and another': () =>
        updateDoc(doc(bob, 'spaces/s1'), {
          memberIds: arrayRemove('bob', 'alice'), 'joinedAt.bob': deleteField(), 'joinedAt.alice': deleteField(),
        }),
      'leave and rename': () => leave(bob, 'bob', 's1', { name: 'Bye' }),
      'leftAt in the past': () => leave(bob, 'bob', 's1', { 'leftAt.bob': Timestamp.fromMillis(Date.now() - DAY) }),
      'leftAt for someone else': () => leave(bob, 'bob', 's1', { 'leftAt.alice': serverTimestamp() }),
      'leftAt not a map': () => leave(bob, 'bob', 's1', { leftAt: 'today' }),
      'take the ownership': () => leave(bob, 'bob', 's1', { ownerId: 'bob' }),
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
  test('anyone with the code can get an invite, signed in or not; nobody can list them', async () => {
    await twoSpaces()
    await allowed(getDoc(doc(db('carol'), `invites/${CODE}`)))
    await allowed(getDoc(doc(db(), `invites/${CODE}`)))
    await allowed(getDoc(doc(db(), 'invites/QQQQ2222')))
    await denied(getDocs(collection(db(), 'invites')))
    await denied(getDocs(collection(db('carol'), 'invites')))
    await denied(getDocs(query(collection(db('alice'), 'invites'), where('spaceId', '==', 's1'))))
  })

  test('only a member creates the invite for their space code', async () => {
    await seed({ 'spaces/s1': spaceDoc(['alice', 'bob']) })
    const invite = (by: string, extra: DocumentData = {}) => ({
      spaceId: 's1', spaceName: 'Film crew', reward: 'Dinner on me', penalty: 'You buy coffee for a week',
      inviterName: 'Bob', createdBy: by, createdAt: serverTimestamp(), ...extra,
    })
    await allDenied({
      'non-member': () => setDoc(doc(db('zoe'), `invites/${CODE}`), invite('zoe')),
      'createdBy someone else': () => setDoc(doc(db('bob'), `invites/${CODE}`), invite('alice')),
      'code is not the space code': () => setDoc(doc(db('bob'), `invites/${OTHER_CODE}`), invite('bob')),
      'malformed code': () => setDoc(doc(db('bob'), 'invites/abcd1234'), invite('bob')),
      'unknown space': () => setDoc(doc(db('bob'), `invites/${CODE}`), invite('bob', { spaceId: 'nope' })),
      'client createdAt': () => setDoc(doc(db('bob'), `invites/${CODE}`), invite('bob', { createdAt: Timestamp.now() })),
      'spaceName not the space\'s': () => setDoc(doc(db('bob'), `invites/${CODE}`), invite('bob', { spaceName: 'Other' })),
      'reward not the space\'s': () => setDoc(doc(db('bob'), `invites/${CODE}`), invite('bob', { reward: 'A high five' })),
      'penalty not the space\'s': () => setDoc(doc(db('bob'), `invites/${CODE}`), invite('bob', { penalty: 'Nothing' })),
      'no stakes (older client)': () =>
        setDoc(doc(db('bob'), `invites/${CODE}`), (({ reward: _r, penalty: _p, ...rest }) => rest)(invite('bob'))),
      'extra key': () => setDoc(doc(db('bob'), `invites/${CODE}`), invite('bob', { uses: 0 })),
    })
    await allowed(setDoc(doc(db('bob'), `invites/${CODE}`), invite('bob')))
  })

  test('a member refreshes the invite to mirror the space\'s name and stakes', async () => {
    await twoSpaces()
    await frozenRecently()
    await updateDoc(doc(db('alice'), 'spaces/s1'), { name: 'Film crew II', reward: 'Sushi' })
    await allowed(updateDoc(doc(db('bob'), `invites/${CODE}`), { spaceName: 'Film crew II', reward: 'Sushi' }))
    // An invite from before the stakes were mirrored gains them.
    await seed({ [`invites/${CODE}`]: (({ reward: _r, penalty: _p, ...rest }) => rest)(inviteDoc('s1', 'alice')) })
    await allowed(updateDoc(doc(db('alice'), `invites/${CODE}`), { spaceName: 'Film crew II', reward: 'Sushi', penalty: 'You buy coffee for a week' }))
    await allDenied({
      'a name the space doesn\'t have': () => updateDoc(doc(db('alice'), `invites/${CODE}`), { spaceName: 'X' }),
      'a reward the space doesn\'t have': () => updateDoc(doc(db('alice'), `invites/${CODE}`), { reward: 'A high five' }),
      'other field': () => updateDoc(doc(db('alice'), `invites/${CODE}`), { spaceId: 's2' }),
      'name and other field': () => updateDoc(doc(db('alice'), `invites/${CODE}`), { spaceName: 'Film crew II', inviterName: 'Y' }),
      'replace with new createdAt': () => setDoc(doc(db('alice'), `invites/${CODE}`), { ...inviteDoc('s1', 'alice'), createdAt: serverTimestamp() }),
      'non-member': () => updateDoc(doc(db('zoe'), `invites/${CODE}`), { spaceName: 'Film crew II' }),
      'signed out': () => updateDoc(doc(db(), `invites/${CODE}`), { spaceName: 'Film crew II' }),
    })
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

describe('house stakes (SPEC §9.7)', () => {
  const C = monthStr(Date.now())
  const P = addMonths(C, -1)
  const OLD = { reward: 'Dinner on me', penalty: 'You buy coffee for a week' }
  const lastWeek = (m: string) => `spaces/s1/weeks/${monthWeeks(m).last}`
  /** The month's last week as stored, ending at `deadlineMs` (the rules read its deadline). */
  const weekEnding = (deadlineMs: number): DocumentData => ({
    startAt: ts(deadlineMs - 5 * DAY), lockAt: ts(deadlineMs - 4 * DAY), reviewOpenAt: ts(deadlineMs - DAY), deadlineAt: ts(deadlineMs),
    members: ['alice', 'bob'], submittedBy: [],
  })
  const note = (by = 'alice', extra: DocumentData = {}) => ({ stakesNote: { by, at: serverTimestamp(), ...extra } })
  const change = (fs: Firestore, extra: DocumentData = {}) => updateDoc(doc(fs, 'spaces/s1'), { reward: 'Sushi', penalty: 'Dishes', ...extra })
  const freezeIn = (batch: ReturnType<typeof writeBatch>, fs: Firestore, m: string) =>
    batch.set(doc(fs, `spaces/s1/months/${m}`), { ...OLD, createdAt: serverTimestamp() })
  /** The owner's edit as updateSpace writes it: freezes first, then the space with its note, then the invite. */
  function ownerEdit(freezes: string[] = [], withNote = true) {
    const alice = db('alice')
    const batch = writeBatch(alice)
    for (const m of freezes) freezeIn(batch, alice, m)
    batch.update(doc(alice, 'spaces/s1'), { reward: 'Sushi', penalty: 'Dishes', ...(withNote ? note() : {}) })
    batch.update(doc(alice, `invites/${CODE}`), { reward: 'Sushi', penalty: 'Dishes' })
    return batch.commit()
  }
  /** Mid-month: last month complete (its last week ended 2 days ago), this month in progress. */
  async function setup(space: DocumentData = {}, docs: Record<string, DocumentData> = {}) {
    await seed({
      'spaces/s1': spaceDoc(['alice', 'bob'], { createdAt: ts(Date.now() - 90 * DAY), ...space }),
      [`invites/${CODE}`]: inviteDoc('s1', 'alice'),
      [lastWeek(P)]: weekEnding(Date.now() - 2 * DAY),
      [lastWeek(C)]: weekEnding(Date.now() + 3 * DAY),
      ...docs,
    })
  }
  const frozenAt = (createdAtMs: number) => ({ ...OLD, createdAt: ts(createdAtMs) })

  test('the owner\'s change carries a note saying who and when; an older client\'s carries none', async () => {
    await setup({}, { [`spaces/s1/months/${P}`]: frozenAt(Date.now() - DAY) })
    await allowed(change(db('alice'), note()))
    await allowed(change(db('alice'), { reward: 'Tacos' }))
    await allDenied({
      'a note without a stakes change': () => updateDoc(doc(db('alice'), 'spaces/s1'), note()),
      'a note with a rename only': () => updateDoc(doc(db('alice'), 'spaces/s1'), { name: 'Crew', ...note() }),
      'a note by someone else': () => change(db('alice'), { reward: 'Ramen', ...note('bob') }),
      'a note at a client time': () => change(db('alice'), { reward: 'Ramen', stakesNote: { by: 'alice', at: Timestamp.now() } }),
      'a note with an extra key': () => change(db('alice'), { reward: 'Ramen', ...note('alice', { why: 'cheaper' }) }),
      'the note deleted': () => change(db('alice'), { reward: 'Ramen', stakesNote: deleteField() }),
      'a member\'s change with a note': () => change(db('bob'), { reward: 'Ramen', ...note('bob') }),
      'a member\'s note alone': () => updateDoc(doc(db('bob'), 'spaces/s1'), note('bob')),
    })
  })

  test('the owner\'s change and the invite\'s copy in one batch', async () => {
    await setup({}, { [`spaces/s1/months/${P}`]: frozenAt(Date.now() - DAY) })
    await allowed(ownerEdit())
    expect((await getDoc(doc(db('bob'), `invites/${CODE}`))).data()).toMatchObject({ reward: 'Sushi', penalty: 'Dishes' })
  })

  test('a finished month is frozen first: in the same batch, or before', async () => {
    await setup()
    await denied(ownerEdit())
    await denied(ownerEdit([C]))
    await allowed(ownerEdit([P]))
    expect((await getDoc(doc(db('bob'), `spaces/s1/months/${P}`))).data()).toMatchObject(OLD)
    // Already frozen at its completion.
    await setup({}, { [`spaces/s1/months/${P}`]: frozenAt(Date.now() - DAY) })
    await allowed(ownerEdit())
    // A rename never needs a freeze.
    await setup()
    await allowed(updateDoc(doc(db('bob'), 'spaces/s1'), { name: 'Crew' }))
  })

  test('the previous app\'s early freeze of this month doesn\'t count; re-freezing it in the batch does', async () => {
    // This month ('2026-10' or later) has just completed; the previous app froze it at its first lock.
    await setup({}, {
      [`spaces/s1/months/${P}`]: frozenAt(Date.now() - 20 * DAY),
      [lastWeek(C)]: weekEnding(Date.now() - HOUR),
      [`spaces/s1/months/${C}`]: { reward: 'Old dinner', penalty: 'Old coffee', createdAt: ts(Date.now() - 20 * DAY) },
    })
    await denied(ownerEdit())
    await allowed(ownerEdit([C]))
    expect((await getDoc(doc(db('bob'), `spaces/s1/months/${C}`))).data()).toMatchObject(OLD)
  })

  test.runIf(P < '2026-10')('an early freeze of a month before 2026-10 counts', async () => {
    await setup({}, { [`spaces/s1/months/${P}`]: frozenAt(Date.now() - 40 * DAY) })
    await allowed(ownerEdit())
  })

  test('without a week doc, the computed deadline plus an hour decides', async () => {
    // Last month has no week docs; its deadline, computed from the space's offset, is moved around now.
    const lastMonday = Date.parse(`${monthWeeks(P).last}T00:00:00Z`)
    const offsetFor = (completeAtMs: number) => Math.round((lastMonday - completeAtMs) / 60_000) + USUAL.deadline
    const noLastWeek = (completeAtMs: number) =>
      seed({
        'spaces/s1': spaceDoc(['alice', 'bob'], { createdAt: ts(Date.now() - 90 * DAY), utcOffsetMin: offsetFor(completeAtMs) }),
        [`invites/${CODE}`]: inviteDoc('s1', 'alice'),
        [lastWeek(C)]: weekEnding(Date.now() + 3 * DAY),
      })
    // Complete half an hour ago: within the hour of slack, the freeze isn't required yet (months.test.ts
    // shows it is already allowed).
    await noLastWeek(Date.now() - 30 * 60_000)
    await allowed(ownerEdit())
    // Complete for more than an hour: it is.
    await noLastWeek(Date.now() - 2 * HOUR)
    await denied(ownerEdit())
    await allowed(ownerEdit([P]))
  })

  test('a space created this month has no last month to freeze', async () => {
    const startOfMonth = Date.parse(`${C}-01T00:00:00Z`)
    await setup({ createdAt: ts(Math.max(startOfMonth + 60_000, Date.now() - HOUR)) })
    await allowed(ownerEdit())
  })

  test('mid-month, nothing needs freezing', async () => {
    await setup({}, { [`spaces/s1/months/${P}`]: frozenAt(Date.now() - DAY) })
    await allowed(ownerEdit([], false))
  })
})
