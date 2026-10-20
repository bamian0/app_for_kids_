import { describe, expect, it } from 'vitest'
import {
  ASK_AGAIN_DAYS,
  FRIEND_PARAM,
  GOAL_PARAM,
  askAgainAt,
  friendsBadge,
  friendsView,
  isSpaceInviteLink,
  normalizeFriendCode,
  pairId,
  pairUsers,
  relationOf,
} from './friends.ts'
import type { FriendState, Friendship, SharedGoal, SharedGoalsView, UID } from './types.ts'

const DAY = 86_400_000
const T = Date.parse('2026-10-20T10:00:00Z')
const ME = 'me1'

function pair(uid: UID, by: UID, state: FriendState, at = T): Friendship {
  return { id: pairId(ME, uid), uid, by, state, at }
}

function goal(id: string, patch: Partial<SharedGoal> = {}): SharedGoal {
  return {
    id,
    name: 'Run 100 km',
    unit: 'km',
    target: 100,
    endsOn: null,
    timezone: 'Europe/Berlin',
    utcOffsetMin: 120,
    zones: {},
    ownerId: 'lena',
    createdBy: 'lena',
    memberIds: ['lena'],
    invited: [ME],
    joinedAt: { lena: T - DAY },
    leftAt: {},
    totals: {},
    total: 0,
    last: null,
    reachedAt: null,
    archivedAt: null,
    createdAt: T - DAY,
    ...patch,
  }
}

describe('constants', () => {
  it('names the link params and the wait', () => {
    expect(FRIEND_PARAM).toBe('friend')
    expect(GOAL_PARAM).toBe('goal')
    expect(ASK_AGAIN_DAYS).toBe(30)
  })
})

describe('pairId and pairUsers', () => {
  it('is the same from either side, in string order', () => {
    expect(pairId('b2', 'a1')).toBe('a1_b2')
    expect(pairId('a1', 'b2')).toBe('a1_b2')
    // Uppercase sorts before lowercase, as in the rules' string order.
    expect(pairId('zed', 'Zed')).toBe('Zed_zed')
    for (const [a, b] of [['x', 'y'], ['Q7', 'q7'], ['abc', 'abd'], ['1', '10']]) expect(pairId(a, b)).toBe(pairId(b, a))
  })
  it('reads a pair id back, and nothing else', () => {
    expect(pairUsers('a1_b2')).toEqual(['a1', 'b2'])
    expect(pairUsers(pairId('Zed', 'zed'))).toEqual(['Zed', 'zed'])
    for (const bad of ['b2_a1', 'a1_a1', 'a1', 'a1_b2_c3', '_b2', 'a1_', 'a-1_b2', 'a1_b 2', '', 'x'.repeat(129) + '_z']) expect(pairUsers(bad)).toBeNull()
    expect(pairUsers(undefined as unknown as string)).toBeNull()
  })
})

describe('friendsView', () => {
  const pairs = [
    pair('fri', 'fri', 'friends', T - 5 * DAY),
    pair('inc', 'inc', 'asked', T - DAY),
    pair('sen', ME, 'asked', T - 2 * DAY),
    // I declined them: hidden from me.
    pair('dec', 'dec', 'declined', T - 3 * DAY),
    // They declined me: silent, still "Requested" for me.
    pair('quiet', ME, 'declined', T - 4 * DAY),
    // My cancel: a tombstone, listed nowhere but kept.
    pair('wd', ME, 'withdrawn', T - 6 * DAY),
    // Their cancel: hidden from me.
    pair('theirwd', 'theirwd', 'withdrawn', T - 7 * DAY),
  ]

  it('splits pairs: friends, incoming, sent (declined ones too), withdrawn (mine only)', () => {
    const view = friendsView(pairs, ME)
    expect(view.friends.map((p) => p.uid)).toEqual(['fri'])
    expect(view.incoming.map((p) => p.uid)).toEqual(['inc'])
    expect(view.sent.map((p) => p.uid)).toEqual(['sen', 'quiet'])
    expect(view.withdrawn.map((p) => p.uid)).toEqual(['wd'])
  })

  it('the asker sees a declined request as sent; the decliner sees nothing', () => {
    const declined = { id: pairId('ana', 'ben'), by: 'ana', state: 'declined' as const, at: T }
    const asAna = friendsView([{ ...declined, uid: 'ben' }], 'ana')
    const asBen = friendsView([{ ...declined, uid: 'ana' }], 'ben')
    expect(asAna.sent.map((p) => p.uid)).toEqual(['ben'])
    expect([...asBen.friends, ...asBen.incoming, ...asBen.sent, ...asBen.withdrawn]).toEqual([])
  })

  it('a withdrawn pair is hidden from both; only its asker keeps it in withdrawn', () => {
    const withdrawn = { id: pairId('ana', 'ben'), by: 'ana', state: 'withdrawn' as const, at: T }
    const asAna = friendsView([{ ...withdrawn, uid: 'ben' }], 'ana')
    const asBen = friendsView([{ ...withdrawn, uid: 'ana' }], 'ben')
    expect([...asAna.friends, ...asAna.incoming, ...asAna.sent]).toEqual([])
    expect(asAna.withdrawn.map((p) => p.uid)).toEqual(['ben'])
    expect([...asBen.friends, ...asBen.incoming, ...asBen.sent, ...asBen.withdrawn]).toEqual([])
  })

  it('sorts newest first, ties by id, and ignores a pair with yourself or a duplicate', () => {
    const view = friendsView(
      [pair('b', 'b', 'friends', T), pair('a', 'a', 'friends', T), pair('c', 'c', 'friends', T + 1), pair(ME, ME, 'friends', T + 9), pair('a', 'a', 'asked', T - 1)],
      ME,
    )
    expect(view.friends.map((p) => p.uid)).toEqual(['c', 'a', 'b'])
    expect(view.incoming).toEqual([])
  })

  it('an empty list', () => {
    expect(friendsView([], ME)).toEqual({ friends: [], incoming: [], sent: [], withdrawn: [] })
  })
})

describe('relationOf', () => {
  const view = friendsView(
    [pair('fri', 'fri', 'friends'), pair('inc', 'inc', 'asked'), pair('sen', ME, 'asked'), pair('quiet', ME, 'declined'), pair('dec', 'dec', 'declined'), pair('wd', ME, 'withdrawn')],
    ME,
  )
  it('me, friend, incoming, sent, else none (your withdrawn pair and one you declined too)', () => {
    expect(relationOf(view, ME, ME)).toBe('me')
    expect(relationOf(view, ME, 'fri')).toBe('friend')
    expect(relationOf(view, ME, 'inc')).toBe('incoming')
    expect(relationOf(view, ME, 'sen')).toBe('sent')
    expect(relationOf(view, ME, 'quiet')).toBe('sent')
    expect(relationOf(view, ME, 'dec')).toBe('none')
    expect(relationOf(view, ME, 'wd')).toBe('none')
    expect(relationOf(view, ME, 'stranger')).toBe('none')
  })
})

describe('askAgainAt', () => {
  const canceled = T - 29 * DAY
  const view = friendsView([pair('wd', ME, 'withdrawn', canceled), pair('old', ME, 'withdrawn', T - 31 * DAY), pair('theirs', 'theirs', 'withdrawn', canceled)], ME)

  it('29 days after a cancel: the day you can ask again', () => {
    expect(askAgainAt(view, 'wd', T)).toBe(canceled + 30 * DAY)
  })
  it('31 days after: ask away', () => {
    expect(askAgainAt(view, 'old', T)).toBeNull()
  })
  it('at exactly 30 days the rules still wait (they need the time to be after it); a millisecond later, null', () => {
    expect(askAgainAt(view, 'wd', canceled + 30 * DAY)).toBe(canceled + 30 * DAY)
    expect(askAgainAt(view, 'wd', canceled + 30 * DAY + 1)).toBeNull()
  })
  it('null for anyone without your withdrawn pair (their cancel never makes you wait)', () => {
    expect(askAgainAt(view, 'theirs', T)).toBeNull()
    expect(askAgainAt(view, 'stranger', T)).toBeNull()
  })
})

describe('normalizeFriendCode and isSpaceInviteLink', () => {
  it('a code with or without its dash or spaces, any case', () => {
    expect(normalizeFriendCode('ABCD-2345')).toBe('ABCD2345')
    expect(normalizeFriendCode('abcd2345')).toBe('ABCD2345')
    expect(normalizeFriendCode(' ab cd 23 45 ')).toBe('ABCD2345')
    expect(normalizeFriendCode('ABCD—2345')).toBe('ABCD2345')
  })
  it('a full friend link, or one in a sentence', () => {
    expect(normalizeFriendCode('https://someone.github.io/app_for_kids_/?friend=WXYZ-7899')).toBe('WXYZ7899')
    expect(normalizeFriendCode('Add me as a friend on Stakes: https://someone.github.io/app_for_kids_/?friend=wxyz7899')).toBe('WXYZ7899')
    expect(normalizeFriendCode('https://x.io/?now=1&friend=ABCD%2D2345#top')).toBe('ABCD2345')
  })
  it('a space invite link is not a friend code', () => {
    const join = 'https://someone.github.io/app_for_kids_/?join=ABCD2345'
    expect(normalizeFriendCode(join)).toBeNull()
    expect(isSpaceInviteLink(join)).toBe(true)
    expect(isSpaceInviteLink('Join my space: ?join=abcd-2345')).toBe(true)
    expect(isSpaceInviteLink('ABCD-2345')).toBe(false)
    expect(isSpaceInviteLink('https://x.io/?friend=ABCD2345')).toBe(false)
    expect(isSpaceInviteLink('https://x.io/?rejoin=ABCD2345')).toBe(false)
  })
  it('anything else is null', () => {
    for (const bad of ['', 'ABCD234', 'ABCD23456', 'ABCD2340', 'ABCI2345', 'https://x.io/', 'https://x.io/?friend=', 'https://x.io/?befriend=ABCD2345', 'https://x.io/?friend=%E0%A4%A'])
      expect(normalizeFriendCode(bad)).toBeNull()
  })
})

describe('friendsBadge', () => {
  const view = friendsView([pair('a', 'a', 'asked'), pair('b', 'b', 'asked'), pair('c', ME, 'asked'), pair('d', 'd', 'friends')], ME)
  const shared: SharedGoalsView = {
    goals: [goal('mine', { memberIds: [ME], invited: [] })],
    invites: [
      goal('open1'),
      goal('open2', { total: 120, reachedAt: T - DAY }),
      goal('ended', { endsOn: '2026-10-18' }),
      goal('finished', { archivedAt: T - DAY }),
    ],
  }
  it('incoming requests + invitations to goals neither finished nor ended', () => {
    expect(friendsBadge(view, shared, T)).toBe(2 + 2)
    expect(friendsBadge(view, undefined, T)).toBe(2)
    expect(friendsBadge(undefined, shared, T)).toBe(2)
    expect(friendsBadge(undefined, undefined, T)).toBe(0)
  })
  it('an invitation stops counting when its goal ends', () => {
    const endsToday = { goals: [], invites: [goal('x', { endsOn: '2026-10-20' })] }
    expect(friendsBadge(undefined, endsToday, Date.parse('2026-10-20T21:59:59Z'))).toBe(1)
    expect(friendsBadge(undefined, endsToday, Date.parse('2026-10-20T22:00:00Z'))).toBe(0)
  })
})
