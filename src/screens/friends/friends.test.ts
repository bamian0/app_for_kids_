import { describe, expect, it } from 'vitest'
import { friendsView } from '../../domain/friends.ts'
import type { Friendship, Space, UserProfile } from '../../domain/types.ts'
import {
  addResultToast,
  acrossSpaces,
  askAgainText,
  badCodeText,
  byName,
  cancelConfirm,
  declinedToast,
  earnedIn,
  emptyMessage,
  formatFriendInput,
  friendsToast,
  longDay,
  nothingSharedText,
  peopleInSpaces,
  relationLine,
  removeConfirm,
  requestSubtitle,
  requestedText,
  shareLinkData,
  shortDay,
  showConfirm,
  spacesSubtitle,
  statsFooter,
  switchCopy,
  updatedFooter,
  whenText,
  youLine,
} from './copy.ts'
import { parseFriendParams } from './links.ts'

const BERLIN = 'Europe/Berlin'
const HOUR = 3_600_000
const DAY = 24 * HOUR
// Tuesday, October 20, 2026, 10:00 in Berlin.
const NOW = Date.UTC(2026, 9, 20, 8)

describe('dates on the device calendar', () => {
  it('says today, yesterday, then the date', () => {
    expect(whenText(NOW - HOUR, NOW, BERLIN)).toBe('today')
    // 00:30 in Berlin today is still today, though it is yesterday in UTC.
    expect(whenText(Date.UTC(2026, 9, 19, 22, 30), NOW, BERLIN)).toBe('today')
    expect(whenText(Date.UTC(2026, 9, 19, 21, 30), NOW, BERLIN)).toBe('yesterday')
    expect(whenText(NOW - 2 * DAY, NOW, BERLIN)).toBe('Oct 18')
    expect(whenText(Date.UTC(2025, 11, 30, 12), NOW, BERLIN)).toBe('Dec 30, 2025')
    // A clock running a little behind the server: still today.
    expect(whenText(NOW + 5 * 60_000, NOW, BERLIN)).toBe('today')
  })

  it('formats short and long days, with the year only when it isn’t this one', () => {
    expect(shortDay(Date.UTC(2026, 10, 19, 12), NOW, BERLIN)).toBe('Nov 19')
    expect(shortDay(Date.UTC(2027, 0, 4, 12), NOW, BERLIN)).toBe('Jan 4, 2027')
    expect(longDay(Date.UTC(2026, 9, 12, 12), NOW, BERLIN)).toBe('October 12')
    expect(longDay(Date.UTC(2025, 9, 12, 12), NOW, BERLIN)).toBe('October 12, 2025')
  })
})

describe('requests and relations', () => {
  it('words incoming and sent requests', () => {
    expect(requestSubtitle(NOW - HOUR, NOW, BERLIN)).toBe('Wants to be friends · today')
    expect(requestSubtitle(NOW - DAY, NOW, BERLIN)).toBe('Wants to be friends · yesterday')
    expect(requestSubtitle(NOW - 2 * DAY, NOW, BERLIN)).toBe('Wants to be friends · Oct 18')
    expect(requestedText(NOW - 2 * DAY, NOW, BERLIN)).toBe('Requested Oct 18')
    expect(requestedText(NOW, NOW, BERLIN)).toBe('Requested today')
  })

  it('says when a canceled request can be sent again', () => {
    const canceled = Date.UTC(2026, 9, 20, 8)
    expect(askAgainText(canceled + 30 * DAY, NOW, BERLIN)).toBe('Ask again Nov 19')
  })

  it('gives the showcase’s relation line', () => {
    expect(relationLine('me', null, NOW, BERLIN)).toBe('Your showcase')
    expect(relationLine('friend', Date.UTC(2026, 9, 12, 12), NOW, BERLIN)).toBe('Friends since October 12')
    expect(relationLine('incoming', NOW, NOW, BERLIN)).toBe('Wants to be friends')
    expect(relationLine('sent', NOW - 2 * DAY, NOW, BERLIN)).toBe('You asked Oct 18')
    expect(relationLine('none', null, NOW, BERLIN)).toBeNull()
  })

  it('puts you first with your ring', () => {
    expect(youLine('92% · October so far')).toBe('You · 92% · October so far')
    expect(youLine('No score yet this month')).toBe('You · No score yet this month')
  })

  it('confirms a cancel and a remove', () => {
    expect(cancelConfirm('Lena Fischer')).toEqual({
      title: 'Cancel your request?',
      message: 'Lena won’t see it anymore. You can ask again in 30 days.',
      confirmLabel: 'Cancel Request',
      cancelLabel: 'Keep',
    })
    expect(removeConfirm('Lena Fischer')).toEqual({
      title: 'Remove Lena?',
      message: 'You’ll stop seeing each other’s rings. Shared goals you’re both in stay as they are. Either of you can ask again later.',
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
    })
  })

  it('says what Add did', () => {
    expect(addResultToast('asked', 'Lena Fischer', null, NOW, BERLIN)).toEqual({ title: 'Request sent', message: 'Lena sees it next time they open Stakes.', icon: 'personPlus' })
    expect(addResultToast('friends', 'Lena Fischer', null, NOW, BERLIN)).toEqual({ title: 'You and Lena are friends', success: true })
    expect(addResultToast('too-soon', 'Lena', Date.UTC(2026, 10, 19, 12), NOW, BERLIN)).toEqual({ title: 'You can ask Lena again on Nov 19', icon: 'clock' })
    expect(addResultToast('already-asked', 'Lena', null, NOW, BERLIN)).toBeNull()
    expect(addResultToast('already-friends', 'Lena', null, NOW, BERLIN)).toBeNull()
    expect(friendsToast('Lena')).toEqual({ title: 'You and Lena are friends', success: true })
    expect(declinedToast('Lena Fischer')).toEqual({ title: 'Request declined', message: 'Lena won’t be told.', icon: 'xmark' })
  })

  it('has both empty states', () => {
    expect(emptyMessage(false)).toBe('Add friends with your link or code. You’ll see how their month is going, and you can fill shared goals together.')
    expect(emptyMessage(true)).toBe(
      'Add people from your spaces below, or anyone with your link or code. You’ll see how their month is going, and you can fill shared goals together.',
    )
  })

  it('shares the link with its title and text', () => {
    expect(shareLinkData('https://x.test/?friend=ABCD2345')).toEqual({
      title: 'Add me on Stakes',
      text: 'Add me as a friend on Stakes:',
      url: 'https://x.test/?friend=ABCD2345',
    })
  })
})

describe('People in Your Spaces', () => {
  const profile = (uid: string, name: string): UserProfile => ({ uid, name, color: '#6B7F9E', createdAt: 0 })
  const profiles = {
    me: profile('me', 'Me'),
    ana: profile('ana', 'Ana'),
    ben: profile('ben', 'Ben'),
    cleo: profile('cleo', 'Cleo'),
    dan: profile('dan', 'Dan'),
    eve: profile('eve', 'Eve'),
    fay: profile('fay', 'fay'),
  }
  const space = (id: string, name: string, memberIds: string[]) => ({ id, name, memberIds }) as unknown as Space
  const pair = (uid: string, by: string, state: Friendship['state'], at = NOW): Friendship => ({ id: `x_${uid}`, uid, by, state, at })

  it('lists members who aren’t friends or pending, by name, with their spaces', () => {
    const view = friendsView(
      [pair('ana', 'me', 'friends'), pair('ben', 'ben', 'asked'), pair('cleo', 'me', 'declined'), pair('dan', 'me', 'withdrawn'), pair('eve', 'eve', 'declined')],
      'me',
    )
    const spaces = [space('s1', 'Film Club', ['me', 'ana', 'ben', 'cleo', 'dan', 'eve', 'fay', 'gone']), space('s2', 'Runners', ['me', 'fay', 'dan']), space('s3', 'Book Club', ['fay', 'me'])]
    const people = peopleInSpaces(spaces, 'me', view, profiles)
    // Friends (ana), incoming (ben) and sent (cleo, silently declined) are out; your canceled request (dan) and a
    // request you declined (eve) stay; a member without a profile (gone) is hidden.
    expect(people).toEqual([
      { uid: 'dan', spaces: ['Film Club', 'Runners'] },
      { uid: 'eve', spaces: ['Film Club'] },
      { uid: 'fay', spaces: ['Film Club', 'Runners', 'Book Club'] },
    ])
    expect(people.map((p) => spacesSubtitle(p.spaces))).toEqual(['In Film Club and 1 more', 'In Film Club', 'In Film Club and 2 more'])
    expect(spacesSubtitle([])).toBe('')
  })

  it('sorts friends by name', () => {
    expect(byName([{ uid: 'fay' }, { uid: 'ana' }, { uid: 'dan' }], profiles).map((x) => x.uid)).toEqual(['ana', 'dan', 'fay'])
  })
})

describe('showcase copy', () => {
  it('words the stats footer from the first month', () => {
    expect(statsFooter('2026-10')).toBe('From finished months since October 2026. Weeks played counts this month too.')
    expect(statsFooter(null)).toBe('Weeks played counts this month too.')
  })

  it('dates old money copies after 3 days', () => {
    expect(updatedFooter(NOW - 3 * DAY, NOW, BERLIN)).toBeNull()
    expect(updatedFooter(NOW - 4 * DAY, NOW, BERLIN)).toBe('Updated Oct 16.')
    expect(updatedFooter(0, NOW, BERLIN)).toBeNull()
  })

  it('names the editor’s switches with last month', () => {
    expect(switchCopy('stats', 'September')).toEqual({ title: 'Stats', subtitle: 'Months at 90%+, streaks and weeks played' })
    expect(switchCopy('achieved', 'September')).toEqual({ title: 'Achieved Goals', subtitle: 'Goals you marked as bought' })
    expect(switchCopy('goals', 'September')).toEqual({ title: 'Current Goals', subtitle: 'Names and progress, never amounts' })
    expect(switchCopy('earnings', 'September')).toEqual({ title: 'Last Month’s Earnings', subtitle: 'What your tasks earned in September' })
  })

  it('asks before showing money, never before stats', () => {
    expect(showConfirm('stats', 'September')).toBeNull()
    expect(showConfirm('achieved', 'September')?.title).toBe('Show your achieved goals?')
    expect(showConfirm('achieved', 'September')?.message).toBe('Anyone on Stakes can see the names of goals you marked as bought, and when.')
    expect(showConfirm('goals', 'September')).toMatchObject({ title: 'Show your goals?', message: 'Anyone on Stakes can see their names and how far along you are, never amounts.' })
    expect(showConfirm('earnings', 'September')).toEqual({
      title: 'Show last month’s earnings?',
      message: 'Anyone on Stakes can see what your tasks earned in September.',
      confirmLabel: 'Show',
      cancelLabel: 'Cancel',
    })
  })

  it('has the small lines', () => {
    expect(earnedIn('September')).toBe('Earned in September')
    expect(nothingSharedText('Lena Fischer')).toBe('Lena hasn’t shared anything yet.')
    expect(acrossSpaces(1)).toBeNull()
    expect(acrossSpaces(2)).toBe('Across 2 spaces')
  })
})

describe('the Add Friend field', () => {
  it('formats a typed code as XXXX-XXXX and a pasted friend link as its code', () => {
    expect(formatFriendInput('abcd')).toBe('ABCD')
    expect(formatFriendInput('abcd2')).toBe('ABCD-2')
    expect(formatFriendInput('abcd 2345')).toBe('ABCD-2345')
    expect(formatFriendInput('ABCD-23456')).toBe('ABCD-2345')
    expect(formatFriendInput('https://stakes.test/?friend=abcd2345')).toBe('ABCD-2345')
    // A space invite link stays as pasted, so the sheet can say what it is.
    expect(formatFriendInput('https://stakes.test/?join=ABCD2345')).toBe('https://stakes.test/?join=ABCD2345')
    expect(formatFriendInput('https://stakes.test/')).toBe('https://stakes.test/')
  })

  it('names the characters a whole code can’t hold', () => {
    expect(badCodeText('CLEO-4567')).toBe('Codes never use “O”. Check the code with your friend.')
    expect(badCodeText('I0O1-2345')).toBe('Codes never use “I”, “0”, “O” and “1”. Check the code with your friend.')
    expect(badCodeText('ABCD-2345')).toBeNull()
    expect(badCodeText('CLEO')).toBeNull()
    expect(badCodeText('https://stakes.test/?join=CLEO4567')).toBeNull()
  })
})

describe('deep links', () => {
  it('reads a friend code and a goal id, and drops anything else', () => {
    expect(parseFriendParams('?friend=abcd-2345')).toEqual({ friend: 'ABCD2345', goal: null })
    expect(parseFriendParams('?friend=ABCD2345&now=2026-10-20')).toEqual({ friend: 'ABCD2345', goal: null })
    expect(parseFriendParams('?friend=nope')).toEqual({ friend: null, goal: null })
    expect(parseFriendParams('?goal=AbC123xyz')).toEqual({ friend: null, goal: 'AbC123xyz' })
    expect(parseFriendParams('?goal=a_b')).toEqual({ friend: null, goal: null })
    expect(parseFriendParams(`?goal=${'a'.repeat(41)}`)).toEqual({ friend: null, goal: null })
    expect(parseFriendParams(`?goal=${encodeURIComponent('x#y')}`)).toEqual({ friend: null, goal: null })
    expect(parseFriendParams('')).toEqual({ friend: null, goal: null })
  })
})
