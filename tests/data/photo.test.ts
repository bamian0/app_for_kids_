// Profile photos (SPEC §7.3) against the emulators and the real rules, through the same functions the
// screens call.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signOut, updateMyName, updateMyPhoto } from '../../src/data/api.ts'
import { startProfile } from '../../src/data/auth.ts'
import { MAX_PHOTO_CHARS } from '../../src/data/convert.ts'
import { authState } from '../../src/data/session.ts'
import type { UserProfile } from '../../src/domain/types.ts'
import { adminGet, as, createUser, eventually, loadRules, observe, rejectsWith, RULES, seed, setupEmulators, teardownEmulators, ts, type TestUser } from './helpers.ts'

const NO_ACCESS = "You don't have access to this."
const BAD_PHOTO = 'Try a different photo.'
const JPEG = 'data:image/jpeg;base64,'
const PHOTO = `${JPEG}/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2Q==`
const OTHER = `${JPEG}/9j/4AAQSkZJRgABAgAAAQABAAD/2Q==`

let alex: TestUser
let sam: TestUser

beforeAll(async () => {
  await setupEmulators()
  alex = await createUser('Alex')
  sam = await createUser('Sam')
})
afterAll(teardownEmulators)

describe('profile photo', () => {
  it('sets, replaces and removes your photo; friends see it live', async () => {
    await as(sam)
    const friend = observe<UserProfile | null>(startProfile(alex.uid))
    await friend.until((l) => l.data?.name === 'Alex')
    expect(friend.current().data?.photo).toBeUndefined()

    await as(alex)
    await updateMyPhoto(PHOTO)
    expect((await adminGet(`users/${alex.uid}`))?.photo).toBe(PHOTO)
    await eventually(() => authState.get().profile?.photo === PHOTO)

    await updateMyPhoto(OTHER)
    expect((await adminGet(`users/${alex.uid}`))?.photo).toBe(OTHER)

    await updateMyPhoto(null)
    const stored = await adminGet(`users/${alex.uid}`)
    expect(stored).not.toHaveProperty('photo')
    expect(stored).toMatchObject({ name: 'Alex' })
    await eventually(() => authState.get().profile !== null && authState.get().profile?.photo === undefined)
    friend.stop()
  })

  it('the largest photo the rules take fits', async () => {
    await as(alex)
    const largest = JPEG + 'A'.repeat(MAX_PHOTO_CHARS - JPEG.length)
    await updateMyPhoto(largest)
    expect((await adminGet(`users/${alex.uid}`))?.photo).toHaveLength(MAX_PHOTO_CHARS)
    await updateMyPhoto(null)
  })

  it('refuses anything but an inline JPEG before writing, so it never shows', async () => {
    await as(alex)
    await updateMyPhoto(PHOTO)
    for (const bad of [
      'https://example.com/me.jpg',
      'data:image/png;base64,iVBORw0KGgo=',
      'data:image/svg+xml;base64,PHN2Zy8+',
      JPEG,
      `${PHOTO}"`,
      JPEG + 'A'.repeat(MAX_PHOTO_CHARS),
    ]) {
      await rejectsWith(updateMyPhoto(bad), BAD_PHOTO)
    }
    expect((await adminGet(`users/${alex.uid}`))?.photo).toBe(PHOTO)
    expect(authState.get().profile?.photo).toBe(PHOTO)
  })

  it('renaming keeps the photo', async () => {
    await as(alex)
    await updateMyPhoto(PHOTO)
    await updateMyName('Alex R.')
    expect(await adminGet(`users/${alex.uid}`)).toMatchObject({ name: 'Alex R.', photo: PHOTO })
    await updateMyName('Alex')
  })

  it('a stored photo the rules would not take never reaches the app', async () => {
    // Written with rules disabled, like a doc from before the rules checked photos.
    await seed({ 'users/old': { name: 'Old', color: '#636366', createdAt: ts(Date.UTC(2026, 0, 1)), photo: 'https://example.com/track.gif' } })
    await as(sam)
    const live = observe<UserProfile | null>(startProfile('old'))
    const state = await live.until((l) => !l.loading)
    expect(state.data).toMatchObject({ uid: 'old', name: 'Old' })
    expect(state.data).not.toHaveProperty('photo')
    live.stop()
  })

  it('says so when the rules from before photos are still live', async () => {
    await as(alex)
    await loadRules(withoutPhotos(RULES))
    try {
      await rejectsWith(updateMyPhoto(OTHER), NO_ACCESS)
    } finally {
      await loadRules(RULES)
    }
    // The refused write is rolled back locally too.
    await eventually(() => authState.get().profile?.photo === PHOTO)
  })

  it('needs you signed in', async () => {
    await signOut()
    await rejectsWith(updateMyPhoto(PHOTO), 'Please sign in first.')
  })
})

/** The rules as they were before photos: a profile has exactly name, color and createdAt. */
function withoutPhotos(rules: string): string {
  const optional = /\s*\|\| \(exactKeys\(d, \['name', 'color', 'createdAt', 'photo'\]\) && validPhoto\(d\.photo\)\)/
  if (!optional.test(rules)) throw new Error('firestore.rules changed: update withoutPhotos()')
  return rules.replace(optional, '')
}
