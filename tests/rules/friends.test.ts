// friends/{pairId} and friendCodes/{code} (SPEC §11.3, §11.5, §11.6): one doc per pair, sorted uids,
// four states and five transitions; codes anyone can look up and only their owner writes.
import { describe, test } from 'vitest'
import {
  collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc, where,
  type DocumentData, type Firestore,
} from 'firebase/firestore'
import { allDenied, allowed, DAY, denied, HOUR, ts, useRulesEnv } from './helpers.ts'

const { db, seed } = useRulesEnv()

const now = () => serverTimestamp()
const PAST = ts(Date.now() - 400 * DAY)
const profile = (name: string): DocumentData => ({ name, color: '#636366', createdAt: PAST })
/** alice < bob < cleo (string order), all with profiles; zed has none. */
const people = () => ({ 'users/alice': profile('Alice'), 'users/bob': profile('Bob'), 'users/cleo': profile('Cleo') })

const pairRef = (fs: Firestore, id = 'alice_bob') => doc(fs, `friends/${id}`)
/** What askFriend writes for a new pair. */
const ask = (by: string, users: string[] = ['alice', 'bob'], extra: DocumentData = {}): DocumentData => ({ users, by, state: 'asked', at: now(), ...extra })
/** A stored pair `daysAgo` old. */
const pair = (by: string, state: string, daysAgo = 1, users = ['alice', 'bob']): DocumentData => ({ users, by, state, at: ts(Date.now() - daysAgo * DAY) })

describe('asking', () => {
  test('anyone asks someone with a profile; both read the pair, nobody else', async () => {
    await seed(people())
    // Before asking, each side reads the missing pair (the app's askFriend reads it in a transaction).
    await allowed(getDoc(pairRef(db('alice'))))
    await allowed(getDoc(pairRef(db('bob'))))
    await denied(getDoc(pairRef(db('cleo'))))
    await allowed(setDoc(pairRef(db('alice')), ask('alice')))
    await allowed(getDoc(pairRef(db('alice'))))
    await allowed(getDoc(pairRef(db('bob'))))
    await denied(getDoc(pairRef(db('cleo'))))
    await denied(getDoc(pairRef(db())))
    // The larger uid asks too (the pair's order is the ids', not the asker's).
    await allowed(setDoc(pairRef(db('cleo'), 'bob_cleo'), ask('cleo', ['bob', 'cleo'])))
  })

  test('each lists their own pairs, nobody lists others\' or everyone\'s', async () => {
    await seed({ ...people(), 'friends/alice_bob': pair('alice', 'friends'), 'friends/bob_cleo': pair('cleo', 'asked', 1, ['bob', 'cleo']) })
    await allowed(getDocs(query(collection(db('bob'), 'friends'), where('users', 'array-contains', 'bob'))))
    await allowed(getDocs(query(collection(db('alice'), 'friends'), where('users', 'array-contains', 'alice'))))
    await allDenied({
      'listing pairs without the users constraint': () => getDocs(collection(db('bob'), 'friends')),
      'listing someone else\'s pairs': () => getDocs(query(collection(db('alice'), 'friends'), where('users', 'array-contains', 'bob'))),
      'listing by state': () => getDocs(query(collection(db('alice'), 'friends'), where('state', '==', 'friends'))),
      'listing signed out': () => getDocs(query(collection(db(), 'friends'), where('users', 'array-contains', 'bob'))),
    })
  })

  test('requests that aren\'t one person asking another are refused', async () => {
    await seed(people())
    const alice = db('alice')
    await allDenied({
      'a request in someone else\'s name': () => setDoc(pairRef(alice), ask('bob')),
      'a request between two others': () => setDoc(pairRef(alice, 'bob_cleo'), ask('alice', ['bob', 'cleo'])),
      'unsorted users': () => setDoc(pairRef(alice, 'bob_alice'), ask('alice', ['bob', 'alice'])),
      'unsorted users under the sorted id': () => setDoc(pairRef(alice), ask('alice', ['bob', 'alice'])),
      'mismatched pair id': () => setDoc(pairRef(alice, 'alice_cleo'), ask('alice')),
      'an id with a third part': () => setDoc(pairRef(alice, 'alice_bob_x'), ask('alice')),
      'a self-request': () => setDoc(pairRef(alice, 'alice_alice'), ask('alice', ['alice', 'alice'])),
      'a request to a uid without a profile': () => setDoc(pairRef(alice, 'alice_zed'), ask('alice', ['alice', 'zed'])),
      'three users': () => setDoc(pairRef(alice), ask('alice', ['alice', 'bob', 'cleo'])),
      'a uid with an underscore': () => setDoc(pairRef(alice, 'a_b_alice'), ask('alice', ['a_b', 'alice'])),
      'a uid that is not a string': () => setDoc(pairRef(alice, '1_alice'), ask('alice', [1, 'alice'])),
      'already friends': () => setDoc(pairRef(alice), ask('alice', ['alice', 'bob'], { state: 'friends' })),
      'already declined': () => setDoc(pairRef(alice), ask('alice', ['alice', 'bob'], { state: 'declined' })),
      'a tombstone': () => setDoc(pairRef(alice), ask('alice', ['alice', 'bob'], { state: 'withdrawn' })),
      'a client time': () => setDoc(pairRef(alice), ask('alice', ['alice', 'bob'], { at: Timestamp.now() })),
      'an extra key': () => setDoc(pairRef(alice), ask('alice', ['alice', 'bob'], { note: 'hi' })),
      'a missing key': () => setDoc(pairRef(alice), { users: ['alice', 'bob'], by: 'alice', state: 'asked' }),
      'signed out': () => setDoc(pairRef(db()), ask('alice')),
    })
  })
})

describe('the five transitions', () => {
  test('the asked person accepts', async () => {
    await seed({ ...people(), 'friends/alice_bob': pair('alice', 'asked') })
    await allowed(updateDoc(pairRef(db('bob')), { state: 'friends', at: now() }))
  })

  test('the asked person declines silently (at stays), then accepts later', async () => {
    await seed({ ...people(), 'friends/alice_bob': pair('alice', 'asked') })
    await denied(updateDoc(pairRef(db('bob')), { state: 'declined', at: now() }))
    await allowed(updateDoc(pairRef(db('bob')), { state: 'declined' }))
    // Accepting a declined request is how someone who declined adds the asker later.
    await allowed(updateDoc(pairRef(db('bob')), { state: 'friends', at: now() }))
  })

  test('the asker cancels a pending or a silently declined request: a tombstone dated now', async () => {
    await seed({ ...people(), 'friends/alice_bob': pair('alice', 'asked'), 'friends/alice_cleo': pair('alice', 'declined', 1, ['alice', 'cleo']) })
    await denied(updateDoc(pairRef(db('alice')), { state: 'withdrawn' }))
    await allowed(updateDoc(pairRef(db('alice')), { state: 'withdrawn', at: now() }))
    await allowed(updateDoc(pairRef(db('alice'), 'alice_cleo'), { state: 'withdrawn', at: now() }))
  })

  test('the asker asks again 31 days after canceling (not 29)', async () => {
    await seed({ ...people(), 'friends/alice_bob': pair('alice', 'withdrawn', 31), 'friends/alice_cleo': pair('alice', 'withdrawn', 29, ['alice', 'cleo']) })
    await allowed(updateDoc(pairRef(db('alice')), { state: 'asked', at: now() }))
    await denied(updateDoc(pairRef(db('alice'), 'alice_cleo'), { state: 'asked', at: now() }))
    // The whole doc again (a set over the tombstone) is the same update.
    await denied(setDoc(pairRef(db('alice'), 'alice_cleo'), ask('alice', ['alice', 'cleo'])))
  })

  test('the other person takes over a tombstone at once', async () => {
    await seed({ ...people(), 'friends/alice_bob': pair('alice', 'withdrawn', 0) })
    await allowed(updateDoc(pairRef(db('bob')), { by: 'bob', state: 'asked', at: now() }))
    // Now it is Bob's request: Alice accepts.
    await allowed(updateDoc(pairRef(db('alice')), { state: 'friends', at: now() }))
  })

  test('the asker asks again (a set) after 31 days', async () => {
    await seed({ ...people(), 'friends/alice_bob': pair('alice', 'withdrawn', 31) })
    await allowed(setDoc(pairRef(db('alice')), ask('alice')))
  })

  test('transitions out of turn are refused', async () => {
    await seed({
      ...people(),
      'friends/alice_bob': pair('alice', 'asked'),
      'friends/alice_cleo': pair('alice', 'declined', 1, ['alice', 'cleo']),
      'friends/bob_cleo': pair('bob', 'friends', 1, ['bob', 'cleo']),
    })
    const [alice, bob, cleo] = [db('alice'), db('bob'), db('cleo')]
    await allDenied({
      'the asker accepting their own request': () => updateDoc(pairRef(alice), { state: 'friends', at: now() }),
      'the asker declining their own request': () => updateDoc(pairRef(alice), { state: 'declined' }),
      'declining a declined pair': () => updateDoc(pairRef(cleo, 'alice_cleo'), { state: 'declined' }),
      'declining an accepted pair': () => updateDoc(pairRef(cleo, 'bob_cleo'), { state: 'declined' }),
      'the asked person withdrawing': () => updateDoc(pairRef(bob), { state: 'withdrawn', at: now() }),
      'withdrawing an accepted pair': () => updateDoc(pairRef(bob, 'bob_cleo'), { state: 'withdrawn', at: now() }),
      'accepting an accepted pair again': () => updateDoc(pairRef(cleo, 'bob_cleo'), { state: 'friends', at: now() }),
      'accepting with a client time': () => updateDoc(pairRef(bob), { state: 'friends', at: Timestamp.now() }),
      'accepting and taking the request': () => updateDoc(pairRef(bob), { by: 'bob', state: 'friends', at: now() }),
      'the asker handing the request to the other': () => updateDoc(pairRef(alice), { by: 'bob' }),
      'the asked person taking over a pending pair': () => updateDoc(pairRef(bob), { by: 'bob', state: 'asked', at: now() }),
      'the asked person taking over a declined pair': () => updateDoc(pairRef(cleo, 'alice_cleo'), { by: 'cleo', state: 'asked', at: now() }),
      'taking over a friendship': () => updateDoc(pairRef(cleo, 'bob_cleo'), { by: 'cleo', state: 'asked', at: now() }),
      'a stranger accepting': () => updateDoc(pairRef(cleo), { state: 'friends', at: now() }),
      'a stranger reading a pair': () => getDoc(pairRef(cleo)),
      'changing the users': () => updateDoc(pairRef(bob), { users: ['bob', 'cleo'], state: 'friends', at: now() }),
      'an unknown state': () => updateDoc(pairRef(bob), { state: 'blocked' }),
      'an extra key': () => updateDoc(pairRef(bob), { state: 'friends', at: now(), note: 'hi' }),
      'signed out': () => updateDoc(pairRef(db()), { state: 'friends', at: now() }),
    })
  })

  test('changing `by` any other way, or re-asking or taking over at the wrong time, is refused', async () => {
    await seed({
      ...people(),
      'friends/alice_bob': pair('alice', 'withdrawn', 2),
      'friends/alice_cleo': pair('alice', 'withdrawn', 40, ['alice', 'cleo']),
    })
    await allDenied({
      're-asking 2 days after a cancel': () => updateDoc(pairRef(db('alice')), { state: 'asked', at: now() }),
      'the asker taking over their own tombstone': () => updateDoc(pairRef(db('alice')), { by: 'alice', state: 'asked', at: now() }),
      'the other person re-asking in the asker\'s name': () => updateDoc(pairRef(db('bob')), { state: 'asked', at: now() }),
      'taking over in someone else\'s name': () => updateDoc(pairRef(db('bob')), { by: 'alice', state: 'asked', at: now() }),
      'taking over straight into friends': () => updateDoc(pairRef(db('bob')), { by: 'bob', state: 'friends', at: now() }),
      'accepting a tombstone': () => updateDoc(pairRef(db('bob')), { state: 'friends', at: now() }),
      'taking over with an old time': () => updateDoc(pairRef(db('bob')), { by: 'bob', state: 'asked' }),
      're-asking with an old time': () => updateDoc(pairRef(db('alice'), 'alice_cleo'), { state: 'asked' }),
      're-asking handing the request over': () => updateDoc(pairRef(db('alice'), 'alice_cleo'), { by: 'cleo', state: 'asked', at: now() }),
    })
  })
})

describe('deleting a pair', () => {
  test('either friend removes a friendship', async () => {
    await seed({ ...people(), 'friends/alice_bob': pair('alice', 'friends'), 'friends/alice_cleo': pair('alice', 'friends', 1, ['alice', 'cleo']) })
    await allowed(deleteDoc(pairRef(db('alice'))))
    await allowed(deleteDoc(pairRef(db('cleo'), 'alice_cleo')))
  })

  test('the asked person deletes a request or a tombstone in any state', async () => {
    await seed({
      ...people(),
      'friends/alice_bob': pair('alice', 'asked', 0),
      'friends/alice_cleo': pair('alice', 'withdrawn', 0, ['alice', 'cleo']),
      'friends/bob_cleo': pair('bob', 'declined', 0, ['bob', 'cleo']),
    })
    await allowed(deleteDoc(pairRef(db('bob'))))
    await allowed(deleteDoc(pairRef(db('cleo'), 'alice_cleo')))
    await allowed(deleteDoc(pairRef(db('cleo'), 'bob_cleo')))
  })

  test('the asker deletes their own pending request or tombstone only after 30 days, or once their profile is gone', async () => {
    await seed({
      ...people(),
      'friends/alice_bob': pair('alice', 'asked', 29),
      'friends/alice_cleo': pair('alice', 'withdrawn', 29, ['alice', 'cleo']),
      'friends/bob_cleo': pair('bob', 'declined', 29, ['bob', 'cleo']),
    })
    await allDenied({
      'the asker deleting their own pending request within 30 days': () => deleteDoc(pairRef(db('alice'))),
      'the asker deleting their own tombstone within 30 days': () => deleteDoc(pairRef(db('alice'), 'alice_cleo')),
      'the asker deleting their own declined request within 30 days': () => deleteDoc(pairRef(db('bob'), 'bob_cleo')),
      'a stranger deleting a pair': () => deleteDoc(pairRef(db('cleo'))),
      'signed out': () => deleteDoc(pairRef(db())),
    })
    // After deleting their profile (account deletion, SPEC §11.12): allowed.
    await allowed(deleteDoc(doc(db('alice'), 'users/alice')))
    await allowed(deleteDoc(pairRef(db('alice'))))
    await allowed(deleteDoc(pairRef(db('alice'), 'alice_cleo')))
  })

  test('a stale request (over 30 days) is the asker\'s to delete', async () => {
    await seed({ ...people(), 'friends/alice_bob': pair('alice', 'asked', 31), 'friends/alice_cleo': pair('alice', 'withdrawn', 31, ['alice', 'cleo']) })
    await allowed(deleteDoc(pairRef(db('alice'))))
    await allowed(deleteDoc(pairRef(db('alice'), 'alice_cleo')))
  })

  test('a stranger can\'t delete a pair, even after 30 days', async () => {
    await seed({ ...people(), 'friends/alice_bob': pair('alice', 'friends', 40) })
    await denied(deleteDoc(pairRef(db('cleo'))))
  })
})

describe('friend codes', () => {
  const codeRef = (fs: Firestore, code = 'ABCD2345') => doc(fs, `friendCodes/${code}`)
  const code = (uid: string, extra: DocumentData = {}): DocumentData => ({ uid, createdAt: now(), ...extra })

  test('anyone signed in looks a code up; its owner creates, lists and deletes their own', async () => {
    await seed({ 'friendCodes/WXYZ6789': { uid: 'bob', createdAt: ts(Date.now() - HOUR) } })
    const alice = db('alice')
    await allowed(setDoc(codeRef(alice), code('alice')))
    await allowed(getDoc(codeRef(db('bob'))))
    await allowed(getDoc(codeRef(alice, 'NOPE2345')))
    await allowed(getDocs(query(collection(alice, 'friendCodes'), where('uid', '==', 'alice'))))
    await allowed(deleteDoc(codeRef(alice)))
    await denied(getDoc(codeRef(db(), 'WXYZ6789')))
  })

  test('codes can\'t be taken, faked or listed', async () => {
    await seed({ 'friendCodes/WXYZ6789': { uid: 'bob', createdAt: ts(Date.now() - HOUR) } })
    const alice = db('alice')
    await allDenied({
      'a friend code for another uid': () => setDoc(codeRef(alice), code('bob')),
      'overwriting an existing code': () => setDoc(codeRef(alice, 'WXYZ6789'), code('alice')),
      'the owner rewriting their code': () => setDoc(codeRef(db('bob'), 'WXYZ6789'), code('bob')),
      'listing others\' codes': () => getDocs(query(collection(alice, 'friendCodes'), where('uid', '==', 'bob'))),
      'listing every code': () => getDocs(collection(alice, 'friendCodes')),
      'deleting someone else\'s code': () => deleteDoc(codeRef(alice, 'WXYZ6789')),
      'a code outside the alphabet': () => setDoc(codeRef(alice, 'ABCD2341'), code('alice')),
      'a code of 9 characters': () => setDoc(codeRef(alice, 'ABCD23456'), code('alice')),
      'a lowercase code': () => setDoc(codeRef(alice, 'abcd2345'), code('alice')),
      'a client time': () => setDoc(codeRef(alice), code('alice', { createdAt: Timestamp.now() })),
      'an extra key': () => setDoc(codeRef(alice), code('alice', { name: 'Alice' })),
      'signed out': () => setDoc(codeRef(db()), code('alice')),
    })
  })
})
