import { describe, expect, it } from 'vitest'
import type { MemberMonthResult } from './scoring.ts'
import {
  agreementStatus,
  agreementsOf,
  agreeOutcome,
  buildMonthResults,
  debtLines,
  FIRST_RESULTS_MONTH,
  freezeBinds,
  HOUSE_SLACK_MS,
  houseFreezeAt,
  houseFreezeMonths,
  lineSettlement,
  MAX_PAST,
  memberTerms,
  missingFor,
  monthDebts,
  monthHouse,
  monthTerms,
  needsHouseFreeze,
  nextAgreement,
  nextStreak,
  nextTierRuns,
  pairSettlement,
  pairTerms,
  provisionalStreaks,
  sameTerms,
  streaksFor,
  termsFriends,
  termsMonth,
  tiersInForce,
  TIER_CHOICES,
  waitingFor,
  wasMemberAt,
} from './stakes.ts'
import { weekBounds } from './time.ts'
import type { MemberStakes, MonthResults, MonthStakes, PairTerms, Settlement, Space, TermsInForce, UID, Week } from './types.ts'

const TZ = 'Europe/Berlin'
const H = 3_600_000
const D = 24 * H
/** When everyone joined. */
const T0 = Date.parse('2026-09-01T10:00:00Z')
const HOUSE = { reward: 'Dinner on me', penalty: 'Coffee for a week' }

function space(memberIds: UID[], extra: Partial<Space> = {}): Space {
  return {
    id: 's1',
    name: 'Film Club',
    ...HOUSE,
    ownerId: memberIds[0],
    memberIds,
    joinedAt: Object.fromEntries(memberIds.map((uid) => [uid, T0])),
    timezone: TZ,
    utcOffsetMin: 120,
    inviteCode: 'ABCD2345',
    threshold: 90,
    latePenalty: 5,
    createdAt: T0,
    ...extra,
  }
}

function own(uid: UID, s: Partial<Omit<MemberStakes, 'uid'>> = {}): MemberStakes {
  return { uid, rewardMode: 'group', penaltyMode: 'group', reward: '', penalty: '', per: {}, tiers: [], agreed: {}, updatedAt: T0, ...s }
}

/** `friend` taps Agree on the stakes' current terms for them at server time `at`, as the data layer writes it. */
function agree(st: MemberStakes, friend: UID, at: number): MemberStakes {
  const terms = pairTerms(st, friend)
  if (!terms) throw new Error(`no terms for ${friend}`)
  const next = nextAgreement(st.agreed[friend], terms)
  return next ? { ...st, agreed: { ...st.agreed, [friend]: { at, ...next } } } : st
}

/** The owner edits their stakes (never touches `agreed`). */
const edit = (st: MemberStakes, change: Partial<Omit<MemberStakes, 'uid' | 'agreed'>>): MemberStakes => ({ ...st, ...change })

/** [reward, penalty, tier lengths] per friend: what counts, at a glance. */
function texts(terms: Record<UID, TermsInForce>): Record<UID, [string, string, number[]]> {
  return Object.fromEntries(Object.entries(terms).map(([f, t]) => [f, [t.reward.text, t.penalty.text, t.tiers.map((x) => x.months)]]))
}

const houseLine = (text: string) => ({ text, together: true, source: 'house' as const })
const ON_HOUSE: TermsInForce = { reward: houseLine(HOUSE.reward), penalty: houseLine(HOUSE.penalty), tiers: [] }

const t1 = T0 + 10 * D
const t2 = t1 + H
const t3 = t2 + H
const t4 = t3 + H
const t5 = t4 + H
const t6 = t5 + H

const GROUP = own('marco', { reward: 'Dinner, on you', penalty: 'Lunch for everyone' })

describe('terms and agreements', () => {
  const each = own('marco', {
    rewardMode: 'each',
    penaltyMode: 'each',
    per: { lena: { reward: 'Lunch', penalty: 'A coffee' }, sam: { reward: 'A movie', penalty: 'A beer' } },
    tiers: [{ months: 3, reward: 'Weekend away' }],
  })

  it('constants', () => {
    expect(MAX_PAST).toBe(5)
    expect(TIER_CHOICES).toEqual([2, 3, 4, 6, 9, 12, 18, 24])
    expect(FIRST_RESULTS_MONTH).toBe('2026-10')
    expect(HOUSE_SLACK_MS).toBe(2 * H)
  })

  it('pairTerms: each line from its own mode', () => {
    expect(pairTerms(GROUP, 'lena')).toEqual({ rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner, on you', penalty: 'Lunch for everyone', tiers: [] })
    expect(pairTerms(each, 'sam')).toEqual({ rewardMode: 'each', penaltyMode: 'each', reward: 'A movie', penalty: 'A beer', tiers: [{ months: 3, reward: 'Weekend away' }] })
    const mixed = own('marco', { reward: 'Dinner, on you', penaltyMode: 'each', per: { lena: { reward: '', penalty: 'A coffee' } } })
    expect(pairTerms(mixed, 'lena')).toEqual({ rewardMode: 'group', penaltyMode: 'each', reward: 'Dinner, on you', penalty: 'A coffee', tiers: [] })
    const mixed2 = own('marco', { rewardMode: 'each', penalty: 'Lunch for everyone', per: { lena: { reward: 'Lunch', penalty: '' } } })
    expect(pairTerms(mixed2, 'lena')).toEqual({ rewardMode: 'each', penaltyMode: 'group', reward: 'Lunch', penalty: 'Lunch for everyone', tiers: [] })
  })

  it("pairTerms: 'missing' without per[F] while a line is per friend", () => {
    expect(pairTerms(each, 'kim')).toBeNull()
    expect(pairTerms(own('marco', { reward: 'x', penaltyMode: 'each', per: {} }), 'kim')).toBeNull()
    // Both lines for everyone: per[] doesn't matter.
    expect(pairTerms(GROUP, 'kim')).not.toBeNull()
    expect(agreementStatus(each, 'kim')).toBe('missing')
    expect(missingFor(each, ['lena', 'kim', 'sam'])).toEqual(['kim'])
  })

  it('sameTerms compares modes, texts and tiers in order', () => {
    const a = pairTerms(each, 'lena') as PairTerms
    expect(sameTerms(a, { ...a })).toBe(true)
    expect(sameTerms(a, { ...a, penaltyMode: 'group' })).toBe(false)
    expect(sameTerms(a, { ...a, reward: 'Lunch!' })).toBe(false)
    expect(sameTerms(a, { ...a, tiers: [] })).toBe(false)
    expect(sameTerms({ ...a, tiers: [{ months: 2, reward: 'A' }, { months: 3, reward: 'B' }] }, { ...a, tiers: [{ months: 2, reward: 'A' }, { months: 3, reward: 'C' }] })).toBe(false)
  })

  it('status goes by content: changing back to terms a friend agreed to reads as agreed again', () => {
    expect(agreementStatus(GROUP, 'lena')).toBe('waiting')
    const agreed = agree(GROUP, 'lena', t1)
    expect(agreementStatus(agreed, 'lena')).toBe('agreed')
    const changed = edit(agreed, { reward: 'Pizza' })
    expect(agreementStatus(changed, 'lena')).toBe('waiting')
    expect(waitingFor(changed, ['sam', 'lena'])).toEqual(['sam', 'lena'])
    expect(agreementStatus(edit(changed, { reward: 'Dinner, on you' }), 'lena')).toBe('agreed')
  })

  it('agreementsOf lists past then the current one with its time', () => {
    expect(agreementsOf(GROUP, 'lena')).toEqual([])
    const st = agree(agree(edit(agree(GROUP, 'lena', t1), { reward: 'Pizza' }), 'lena', t2), 'sam', t3)
    expect(agreementsOf(st, 'lena').map((a) => [a.at, a.reward])).toEqual([
      [t1, 'Dinner, on you'],
      [t2, 'Pizza'],
    ])
    expect(agreementsOf(st, 'sam').map((a) => a.at)).toEqual([t3])
  })
})

describe('nextAgreement (exactly what the rules accept)', () => {
  const terms = pairTerms(GROUP, 'lena') as PairTerms

  it('a first Agree: the terms and an empty past', () => {
    expect(nextAgreement(undefined, terms)).toEqual({ terms, past: [] })
  })

  it('an unchanged re-agree writes nothing', () => {
    expect(nextAgreement({ at: t1, terms, past: [] }, { ...terms })).toBeNull()
  })

  it('a re-agree after a change stamps the current one into past with its time', () => {
    const next = nextAgreement({ at: t1, terms, past: [] }, { ...terms, reward: 'Pizza' })
    expect(next).toEqual({ terms: { ...terms, reward: 'Pizza' }, past: [{ ...terms, at: t1 }] })
  })

  it('keeps 6 agreements in all: the 6th re-agree drops the oldest', () => {
    const past = [1, 2, 3, 4, 5].map((i) => ({ ...terms, reward: `v${i}`, at: t1 + i }))
    const next = nextAgreement({ at: t1 + 6, terms: { ...terms, reward: 'v6' }, past }, { ...terms, reward: 'v7' })
    expect(next?.past.map((p) => p.reward)).toEqual(['v2', 'v3', 'v4', 'v5', 'v6'])
    expect(next?.past).toHaveLength(MAX_PAST)
    expect(next?.past[4]).toEqual({ ...terms, reward: 'v6', at: t1 + 6 })
  })

  it('copies only the five term keys, and keeps earlier entries (and their raw times) untouched', () => {
    const stamp = { seconds: 1, nanoseconds: 5 }
    const prev = { at: stamp, terms, past: [{ ...terms, reward: 'old', at: { seconds: 0, nanoseconds: 1 } }] }
    const next = nextAgreement(prev, { ...terms, reward: 'new', extra: 'no' } as PairTerms)
    expect(next?.terms).toEqual({ ...terms, reward: 'new' })
    expect(next?.past[0]).toBe(prev.past[0])
    expect(next?.past[1].at).toBe(stamp)
  })
})

describe('wasMemberAt', () => {
  const sp = space(['a', 'b'], { joinedAt: { a: 100, b: 500 }, leftAt: { c: 300, b: 200 } })
  it('a current member from their latest join; a former member until they left', () => {
    expect(wasMemberAt(sp, 'a', 100)).toBe(true)
    expect(wasMemberAt(sp, 'a', 99)).toBe(false)
    // b left at 200 and rejoined at 500: counts from 500.
    expect(wasMemberAt(sp, 'b', 400)).toBe(false)
    expect(wasMemberAt(sp, 'b', 500)).toBe(true)
    // c left at 300; their join time is gone, so assumed earlier.
    expect(wasMemberAt(sp, 'c', 299)).toBe(true)
    expect(wasMemberAt(sp, 'c', 300)).toBe(false)
    expect(wasMemberAt(sp, 'x', 1)).toBe(false)
  })
})

describe('memberTerms (SPEC §9.7: what counts, line by line)', () => {
  const sp = space(['marco', 'lena', 'sam', 'kim'])
  const friends = ['lena', 'sam', 'kim']

  it('no stakes, or nobody agreed: everyone on the house stakes', () => {
    const none = { lena: ON_HOUSE, sam: ON_HOUSE, kim: ON_HOUSE }
    expect(memberTerms(sp, 'marco', friends, undefined, HOUSE, Infinity)).toEqual(none)
    expect(memberTerms(sp, 'marco', friends, {}, HOUSE, Infinity)).toEqual(none)
    expect(memberTerms(sp, 'marco', friends, { marco: GROUP }, HOUSE, Infinity)).toEqual(none)
  })

  it('only Sam of three agreed to a Same-for-everyone line: everyone stays on the house line', () => {
    const st = agree(GROUP, 'sam', t1)
    expect(memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, Infinity)).toEqual({ lena: ON_HOUSE, sam: ON_HOUSE, kim: ON_HOUSE })
  })

  it('all three agreed: one together line from the third Agree on (each pair stamped with its own Agree)', () => {
    const st = agree(agree(agree(GROUP, 'sam', t1), 'lena', t2), 'kim', t3)
    // Before the third Agree (cutoff at its time: only agreements before it count), the house stakes.
    expect(texts(memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, t3))).toEqual({
      lena: ['Dinner on me', 'Coffee for a week', []],
      sam: ['Dinner on me', 'Coffee for a week', []],
      kim: ['Dinner on me', 'Coffee for a week', []],
    })
    const r = memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, t3 + 1)
    expect(r.lena.reward).toEqual({ text: 'Dinner, on you', together: true, source: 'agreed', at: t2 })
    expect(r.sam.penalty).toEqual({ text: 'Lunch for everyone', together: true, source: 'agreed', at: t1 })
    expect(r.kim.reward.at).toBe(t3)
  })

  it('a change agreed by two of three: the old agreed terms keep counting for all', () => {
    let st = agree(agree(agree(GROUP, 'sam', t1), 'lena', t2), 'kim', t3)
    st = edit(st, { reward: 'Pizza, on you' })
    st = agree(agree(st, 'lena', t4), 'sam', t5)
    const r = memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, Infinity)
    expect(texts(r)).toEqual({
      lena: ['Dinner, on you', 'Lunch for everyone', []],
      sam: ['Dinner, on you', 'Lunch for everyone', []],
      kim: ['Dinner, on you', 'Lunch for everyone', []],
    })
    // Lena's old agreement (now in her past) is the one in force.
    expect(r.lena.reward.at).toBe(t2)
  })

  it('an agreed change counts at once: a cutoff after the last Agree gives the new terms', () => {
    let st = agree(agree(agree(GROUP, 'sam', t1), 'lena', t2), 'kim', t3)
    st = edit(st, { reward: 'Pizza, on you' })
    st = agree(agree(agree(st, 'lena', t4), 'sam', t5), 'kim', t6)
    expect(texts(memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, t6 + 1)).kim).toEqual(['Pizza, on you', 'Lunch for everyone', []])
    expect(texts(memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, t6)).kim).toEqual(['Dinner, on you', 'Lunch for everyone', []])
  })

  it('a finished month never changes: agreements after its completion leave its terms, and count for the next month', () => {
    const october = weekBounds('2026-10-26', TZ).deadlineAt
    const november = weekBounds('2026-11-23', TZ).deadlineAt
    let st = agree(agree(agree(GROUP, 'sam', t1), 'lena', t2), 'kim', t3)
    st = edit(st, { reward: 'Pizza, on you' })
    st = agree(st, 'lena', october - H)
    st = agree(st, 'sam', october + H)
    st = agree(st, 'kim', october + 2 * H)
    expect(texts(memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, october)).lena[0]).toBe('Dinner, on you')
    expect(texts(memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, november)).lena[0]).toBe('Pizza, on you')
  })

  it('a newcomer who joined after the agreement and hasn’t agreed: the others stay on it, the newcomer on the house stakes', () => {
    const later = { ...sp, joinedAt: { ...sp.joinedAt, kim: t3 } }
    const st = agree(agree(GROUP, 'sam', t1), 'lena', t2)
    expect(texts(memberTerms(later, 'marco', friends, { marco: st }, HOUSE, Infinity))).toEqual({
      lena: ['Dinner, on you', 'Lunch for everyone', []],
      sam: ['Dinner, on you', 'Lunch for everyone', []],
      kim: ['Dinner on me', 'Coffee for a week', []],
    })
    expect(memberTerms(later, 'marco', friends, { marco: st }, HOUSE, Infinity).kim).toEqual(ON_HOUSE)
  })

  it('a newcomer who joined before a group change: the change waits for them', () => {
    const later = { ...sp, joinedAt: { ...sp.joinedAt, kim: t3 } }
    let st = agree(agree(GROUP, 'sam', t1), 'lena', t2)
    st = edit(st, { reward: 'Pizza, on you' })
    st = agree(agree(st, 'lena', t4), 'sam', t5)
    expect(texts(memberTerms(later, 'marco', friends, { marco: st }, HOUSE, Infinity))).toEqual({
      lena: ['Dinner, on you', 'Lunch for everyone', []],
      sam: ['Dinner, on you', 'Lunch for everyone', []],
      kim: ['Dinner on me', 'Coffee for a week', []],
    })
    // Once Kim agrees too, the change counts for all three.
    const all = agree(st, 'kim', t6)
    expect(texts(memberTerms(later, 'marco', friends, { marco: all }, HOUSE, Infinity)).kim).toEqual(['Pizza, on you', 'Lunch for everyone', []])
  })

  it('a per-friend text change for one friend counts with that friend’s Agree alone, even with a group change on the other line waiting', () => {
    let st = own('marco', {
      reward: 'Dinner, on you',
      penaltyMode: 'each',
      per: { lena: { reward: '', penalty: 'A coffee' }, sam: { reward: '', penalty: 'A beer' }, kim: { reward: '', penalty: 'A tea' } },
    })
    st = agree(agree(agree(st, 'lena', t1), 'sam', t2), 'kim', t3)
    st = edit(st, { reward: 'Pizza, on you', per: { ...st.per, lena: { reward: '', penalty: 'Two coffees' } } })
    st = agree(st, 'lena', t4)
    const r = memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, Infinity)
    expect(texts(r)).toEqual({
      lena: ['Dinner, on you', 'Two coffees', []],
      sam: ['Dinner, on you', 'A beer', []],
      kim: ['Dinner, on you', 'A tea', []],
    })
    expect(r.lena.penalty).toEqual({ text: 'Two coffees', together: false, source: 'agreed', at: t4 })
    expect(r.lena.reward.at).toBe(t1)
  })

  it('reward the same for everyone, penalty per friend (the owner’s example): the group owes one dinner, each friend gets their own', () => {
    let st = own('marco', { reward: 'Dinner, on you', penaltyMode: 'each', per: { lena: { reward: '', penalty: 'A coffee' }, sam: { reward: '', penalty: 'A beer' } } })
    const three = space(['marco', 'lena', 'sam'])
    st = agree(agree(st, 'lena', t1), 'sam', t2)
    const r = memberTerms(three, 'marco', ['lena', 'sam'], { marco: st }, HOUSE, Infinity)
    expect(r.lena).toEqual({
      reward: { text: 'Dinner, on you', together: true, source: 'agreed', at: t1 },
      penalty: { text: 'A coffee', together: false, source: 'agreed', at: t1 },
      tiers: [],
    })
    expect(texts(r).sam).toEqual(['Dinner, on you', 'A beer', []])
  })

  it('reward per friend, penalty the same for everyone', () => {
    let st = own('marco', { rewardMode: 'each', penalty: 'Coffee for the group', per: { lena: { reward: 'Lunch', penalty: '' }, sam: { reward: 'A movie', penalty: '' } } })
    const three = space(['marco', 'lena', 'sam'])
    st = agree(st, 'lena', t1)
    // Lena's own reward counts at once; the shared penalty waits for Sam.
    expect(texts(memberTerms(three, 'marco', ['lena', 'sam'], { marco: st }, HOUSE, Infinity))).toEqual({
      lena: ['Lunch', 'Coffee for a week', []],
      sam: ['Dinner on me', 'Coffee for a week', []],
    })
    st = agree(st, 'sam', t2)
    expect(texts(memberTerms(three, 'marco', ['lena', 'sam'], { marco: st }, HOUSE, Infinity))).toEqual({
      lena: ['Lunch', 'Coffee for the group', []],
      sam: ['A movie', 'Coffee for the group', []],
    })
  })

  it('a switch from Same for everyone to Different per friend waits for everyone who had agreed', () => {
    let st = agree(agree(agree(GROUP, 'lena', t1), 'sam', t2), 'kim', t3)
    st = edit(st, { penaltyMode: 'each', per: { lena: { reward: '', penalty: 'A coffee' }, sam: { reward: '', penalty: 'A beer' }, kim: { reward: '', penalty: 'A tea' } } })
    st = agree(agree(st, 'lena', t4), 'sam', t5)
    const r = memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, Infinity)
    expect(texts(r).lena).toEqual(['Dinner, on you', 'Lunch for everyone', []])
    expect(r.lena.penalty.together).toBe(true)
    st = agree(st, 'kim', t6)
    expect(texts(memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, Infinity))).toEqual({
      lena: ['Dinner, on you', 'A coffee', []],
      sam: ['Dinner, on you', 'A beer', []],
      kim: ['Dinner, on you', 'A tea', []],
    })
  })

  it('streak rewards wait for everyone', () => {
    let st = edit(GROUP, { tiers: [{ months: 3, reward: 'Weekend away' }] })
    st = agree(agree(st, 'lena', t1), 'sam', t2)
    expect(memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, Infinity).lena.tiers).toEqual([])
    st = agree(st, 'kim', t3)
    const r = memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, Infinity)
    expect(r.lena.tiers).toEqual([{ months: 3, reward: 'Weekend away' }])
    expect(r.kim.tiers).toEqual([{ months: 3, reward: 'Weekend away' }])
    // A new tier agreed by two of three: the old tiers keep counting.
    st = edit(st, { tiers: [{ months: 3, reward: 'Weekend away' }, { months: 6, reward: 'A trip' }] })
    st = agree(agree(st, 'lena', t4), 'sam', t5)
    expect(memberTerms(sp, 'marco', friends, { marco: st }, HOUSE, Infinity).sam.tiers.map((t) => t.months)).toEqual([3])
  })

  it('a former member who left before an agreement isn’t needed for it', () => {
    const left = space(['marco', 'lena', 'sam'], { leftAt: { kim: t2 } })
    const st = agree(agree(GROUP, 'lena', t3), 'sam', t4)
    expect(texts(memberTerms(left, 'marco', friends, { marco: st }, HOUSE, Infinity))).toEqual({
      lena: ['Dinner, on you', 'Lunch for everyone', []],
      sam: ['Dinner, on you', 'Lunch for everyone', []],
      kim: ['Dinner on me', 'Coffee for a week', []],
    })
  })

  it('a friend who left without agreeing still holds back a change agreed while they were in', () => {
    const left = space(['marco', 'lena', 'sam'], { leftAt: { kim: t5 } })
    const st = agree(agree(GROUP, 'lena', t3), 'sam', t4)
    expect(texts(memberTerms(left, 'marco', friends, { marco: st }, HOUSE, Infinity)).lena[0]).toBe('Dinner on me')
    // Without Kim among the friends (next month's termsFriends), it counts.
    expect(texts(memberTerms(left, 'marco', ['lena', 'sam'], { marco: st }, HOUSE, Infinity)).lena[0]).toBe('Dinner, on you')
  })

  it('ignores the subject and repeated friends, and other members’ docs', () => {
    const st = agree(agree(agree(GROUP, 'lena', t1), 'sam', t2), 'kim', t3)
    const r = memberTerms(sp, 'marco', ['lena', 'marco', 'lena', 'sam', 'kim'], { marco: st, lena: own('lena') }, HOUSE, Infinity)
    expect(Object.keys(r)).toEqual(['lena', 'sam', 'kim'])
  })
})

describe('agreeOutcome', () => {
  const three = space(['marco', 'lena', 'sam'])
  // e2e scenario 6: the reward line for everyone, the penalty per friend, a streak reward; nobody agreed.
  const marco = own('marco', {
    reward: 'Dinner, on you',
    penaltyMode: 'each',
    per: { lena: { reward: '', penalty: 'A coffee' }, sam: { reward: '', penalty: 'A beer' } },
    tiers: [{ months: 3, reward: 'Weekend away' }],
  })

  it("Lena's Agree is 'partly' (her own penalty now, the rest once Sam agrees); Sam's after it is 'now'", () => {
    expect(agreeOutcome(three, 'marco', 'lena', ['lena', 'sam'], { marco }, HOUSE, t1)).toEqual({ counts: 'partly', waitingFor: ['sam'] })
    const afterLena = agree(marco, 'lena', t1)
    expect(texts(memberTerms(three, 'marco', ['lena', 'sam'], { marco: afterLena }, HOUSE, Infinity))).toEqual({
      lena: ['Dinner on me', 'A coffee', []],
      sam: ['Dinner on me', 'Coffee for a week', []],
    })
    expect(agreeOutcome(three, 'marco', 'sam', ['lena', 'sam'], { marco: afterLena }, HOUSE, t2)).toEqual({ counts: 'now', waitingFor: [] })
    const both = agree(afterLena, 'sam', t2)
    expect(texts(memberTerms(three, 'marco', ['lena', 'sam'], { marco: both }, HOUSE, Infinity))).toEqual({
      lena: ['Dinner, on you', 'A coffee', [3]],
      sam: ['Dinner, on you', 'A beer', [3]],
    })
    // Marco changes only Lena's penalty: her Agree counts at once, without Sam.
    const changed = edit(both, { per: { ...both.per, lena: { reward: '', penalty: 'Two coffees' } } })
    expect(agreeOutcome(three, 'marco', 'lena', ['lena', 'sam'], { marco: changed }, HOUSE, t3)).toEqual({ counts: 'now', waitingFor: [] })
    expect(texts(memberTerms(three, 'marco', ['lena', 'sam'], { marco: agree(changed, 'lena', t3) }, HOUSE, Infinity)).lena[1]).toBe('Two coffees')
  })

  it("'later' when nothing would count yet, waiting for exactly who holds it", () => {
    const sp = space(['marco', 'lena', 'sam', 'kim'])
    const friends = ['lena', 'sam', 'kim']
    expect(agreeOutcome(sp, 'marco', 'lena', friends, { marco: GROUP }, HOUSE, t1)).toEqual({ counts: 'later', waitingFor: ['sam', 'kim'] })
    const two = agree(agree(GROUP, 'lena', t1), 'sam', t2)
    expect(agreeOutcome(sp, 'marco', 'kim', friends, { marco: two }, HOUSE, t3)).toEqual({ counts: 'now', waitingFor: [] })
    // Sam agreed to an older version that differs only in the penalty: he holds back only the penalty.
    let st = agree(GROUP, 'sam', t1)
    st = edit(st, { penalty: 'Pizza for everyone' })
    st = agree(st, 'kim', t2)
    expect(agreeOutcome(sp, 'marco', 'lena', friends, { marco: st }, HOUSE, t3)).toEqual({ counts: 'partly', waitingFor: ['sam'] })
  })

  it("'now' when already agreed, and when nothing shared is pending (both lines per friend, no streak rewards)", () => {
    const agreed = agree(GROUP, 'lena', t1)
    const sp = space(['marco', 'lena'])
    expect(agreeOutcome(sp, 'marco', 'lena', ['lena'], { marco: agreed }, HOUSE, t2)).toEqual({ counts: 'now', waitingFor: [] })
    const each = own('marco', { rewardMode: 'each', penaltyMode: 'each', per: { lena: { reward: 'Lunch', penalty: 'A coffee' }, sam: { reward: 'A movie', penalty: 'A beer' } } })
    expect(agreeOutcome(three, 'marco', 'lena', ['lena', 'sam'], { marco: each }, HOUSE, t1)).toEqual({ counts: 'now', waitingFor: [] })
  })

  it('a device clock behind the server: the Agree still lands after earlier ones and after my join', () => {
    const st = agree(GROUP, 'lena', t2)
    // Sam's device says t1, before Lena's Agree (t2) was stamped.
    expect(agreeOutcome(three, 'marco', 'sam', ['lena', 'sam'], { marco: st }, HOUSE, t1)).toEqual({ counts: 'now', waitingFor: [] })
    // Sam joined (server time) at t3; his device still says t1.
    const joinedLate = { ...three, joinedAt: { ...three.joinedAt, sam: t3 } }
    expect(agreeOutcome(joinedLate, 'marco', 'sam', ['lena', 'sam'], { marco: GROUP }, HOUSE, t1)).toEqual({ counts: 'later', waitingFor: ['lena'] })
  })

  it('a friend who left this month doesn’t hold back an Agree made after they left', () => {
    const left = space(['marco', 'lena', 'sam'], { leftAt: { kim: t1 } })
    const st = agree(GROUP, 'lena', t2)
    expect(agreeOutcome(left, 'marco', 'sam', ['lena', 'sam', 'kim'], { marco: st }, HOUSE, t3)).toEqual({ counts: 'now', waitingFor: [] })
  })
})

describe('tiersInForce', () => {
  it('a newcomer who agreed only to new tiers the others haven’t: the old tiers stay in force from the other pairs', () => {
    const sp = space(['marco', 'lena', 'sam', 'kim'], { joinedAt: { marco: T0, lena: T0, sam: T0, kim: t3 } })
    let st = edit(GROUP, { tiers: [{ months: 3, reward: 'Weekend away' }] })
    st = agree(agree(st, 'lena', t1), 'sam', t2)
    st = edit(st, { tiers: [{ months: 3, reward: 'Weekend away' }, { months: 6, reward: 'A trip' }] })
    st = agree(st, 'kim', t4)
    // Kim first, so "any pair" would see her [] first.
    const pairs = memberTerms(sp, 'marco', ['kim', 'lena', 'sam'], { marco: st }, HOUSE, Infinity)
    expect(pairs.kim.tiers).toEqual([])
    expect(tiersInForce({ marco: pairs }, 'marco')).toEqual([{ months: 3, reward: 'Weekend away' }])
    expect(tiersInForce({ marco: pairs }, 'lena')).toEqual([])
    expect(tiersInForce(undefined, 'marco')).toEqual([])
    // So Marco's 3-month run goes on in the month results instead of being dropped.
    const prev: MonthResults = { monthId: '2026-10', completeAt: 1, members: { marco: { score: 95, passed: true, streak: 1, tierRuns: { '3': 1 } } }, createdAt: 2 }
    const month = { marco: { ...result('marco', ['kim', 'lena', 'sam']), monthId: '2026-11' } }
    expect(buildMonthResults('2026-11', 3, month, prev, { marco: pairs }).members.marco).toEqual({ score: 95, passed: true, streak: 2, tierRuns: { '3': 2 } })
  })
})

describe('termsFriends', () => {
  const lock = weekBounds('2026-09-28', TZ).lockAt
  it('current members other than me who don’t judge, plus friends who left since the month’s first lock', () => {
    const sp = space(['marco', 'lena', 'sam', 'ana'], { judges: ['ana', 'gone'], leftAt: { ben: lock + D, old: lock - H } })
    expect(termsFriends(sp, 'marco', lock)).toEqual(['lena', 'sam', 'ben'])
    expect(termsFriends(sp, 'lena', lock, [])).toEqual(['marco', 'sam', 'ana', 'ben'])
    // A friend who left and came back is a current member, listed once.
    expect(termsFriends({ ...sp, leftAt: { lena: lock + D } }, 'marco', lock)).toEqual(['lena', 'sam'])
  })

  it('a leaver who never agreed gives the same terms on the card and in the month in progress', () => {
    const sp = space(['marco', 'lena', 'sam'], { leftAt: { ben: lock + 2 * D } })
    const st = agree(agree(GROUP, 'lena', lock + D), 'sam', lock + D + H)
    const card = memberTerms(sp, 'marco', termsFriends(sp, 'marco', lock), { marco: st }, HOUSE, Infinity)
    expect(texts(card).lena[0]).toBe('Dinner on me')
    const month: Record<UID, MemberMonthResult> = {
      marco: result('marco', ['lena', 'sam', 'ben'], { complete: false }),
      lena: result('lena', ['marco', 'sam', 'ben'], { complete: false }),
      sam: result('sam', ['marco', 'lena', 'ben'], { complete: false }),
      ben: result('ben', ['marco', 'lena', 'sam'], { complete: false }),
    }
    const completeAt = weekBounds('2026-10-26', TZ).deadlineAt
    const terms = monthTerms(sp, '2026-10', month, { marco: st }, HOUSE, { completeAt, firstLockAt: lock })
    expect(terms.marco.lena).toEqual(card.lena)
    expect(terms.marco.sam).toEqual(card.sam)
  })
})

function result(uid: UID, others: UID[], r: Partial<MemberMonthResult> = {}): MemberMonthResult {
  const passed = r.passed === undefined ? true : r.passed
  return {
    uid,
    monthId: '2026-10',
    former: false,
    others,
    weeks: [],
    average: 95,
    missedReviews: 0,
    penaltyPoints: 0,
    finalScore: passed === null ? null : passed ? 95 : 50,
    complete: true,
    passed,
    judged: [],
    monthly: null,
    monthlyJudge: false,
    skippedAsJudge: 0,
    ...r,
  }
}

describe('monthTerms', () => {
  const sp = space(['marco', 'lena', 'sam'])
  const completeAt = weekBounds('2026-10-26', TZ).deadlineAt
  const firstLockAt = weekBounds('2026-09-28', TZ).lockAt
  const month = {
    marco: result('marco', ['lena', 'sam']),
    lena: result('lena', ['marco', 'sam'], { passed: false }),
    sam: result('sam', ['marco', 'lena']),
  }

  it('a complete month: the agreements made before it was complete, with each player’s others', () => {
    let st = agree(agree(GROUP, 'lena', t1), 'sam', t2)
    st = edit(st, { reward: 'Pizza, on you' })
    st = agree(agree(st, 'lena', completeAt - H), 'sam', completeAt + H)
    const terms = monthTerms(sp, '2026-10', month, { marco: st }, HOUSE, { completeAt, firstLockAt })
    expect(texts(terms.marco)).toEqual({ lena: ['Dinner, on you', 'Lunch for everyone', []], sam: ['Dinner, on you', 'Lunch for everyone', []] })
    expect(terms.lena).toEqual({ marco: ON_HOUSE, sam: ON_HOUSE })
    expect(Object.keys(terms).sort()).toEqual(['lena', 'marco', 'sam'])
  })

  it('stored terms win', () => {
    const stored: MonthResults = { monthId: '2026-10', completeAt, members: {}, terms: { marco: { lena: ON_HOUSE } }, createdAt: completeAt + D }
    expect(monthTerms(sp, '2026-10', month, { marco: agree(GROUP, 'lena', t1) }, HOUSE, { completeAt, firstLockAt }, stored)).toBe(stored.terms)
  })

  it('a month in progress: every agreement so far counts (what counts now)', () => {
    const progress = Object.fromEntries(Object.entries(month).map(([u, r]) => [u, { ...r, complete: false, passed: null }]))
    const st = agree(agree(GROUP, 'lena', t1), 'sam', t2)
    const terms = monthTerms(sp, '2026-10', progress, { marco: st }, HOUSE, { completeAt, firstLockAt })
    expect(texts(terms.marco).lena[0]).toBe('Dinner, on you')
  })

  it('the month’s house stakes: a binding freeze, else the space’s (an early October freeze doesn’t bind)', () => {
    const frozen: MonthStakes = { reward: 'Old dinner', penalty: 'Old coffee', frozen: true, createdAt: completeAt + H }
    const house = monthHouse(sp, '2026-10', frozen, completeAt)
    expect(monthTerms(sp, '2026-10', month, {}, house, { completeAt, firstLockAt }).marco.lena.reward.text).toBe('Old dinner')
    const early = { ...frozen, createdAt: firstLockAt + H }
    const live = monthHouse(sp, '2026-10', early, completeAt)
    expect(monthTerms(sp, '2026-10', month, {}, live, { completeAt, firstLockAt }).marco.lena.reward.text).toBe('Dinner on me')
  })

  it('judge-only members and members with nobody else have no pairs', () => {
    const solo = { marco: result('marco', []), ana: result('ana', ['marco'], { passed: null }) }
    expect(monthTerms(sp, '2026-10', solo, {}, HOUSE, { completeAt, firstLockAt })).toEqual({})
  })
})

describe('house stakes per month', () => {
  const sp = space(['marco', 'lena'])
  const sepComplete = weekBounds('2026-09-21', TZ).deadlineAt
  const sepLock = weekBounds('2026-08-31', TZ).lockAt
  const completeAt = weekBounds('2026-10-26', TZ).deadlineAt
  const firstLock = weekBounds('2026-09-28', TZ).lockAt
  const freeze = (createdAt?: number): MonthStakes => ({ reward: 'Frozen dinner', penalty: 'Frozen coffee', frozen: true, ...(createdAt === undefined ? {} : { createdAt }) })

  it('freezeBinds: before FIRST_RESULTS_MONTH any freeze; from it on only one made at completion (2h slack)', () => {
    expect(freezeBinds('2026-09', freeze(sepLock), sepComplete)).toBe(true)
    expect(freezeBinds('2026-10', freeze(firstLock), completeAt)).toBe(false)
    expect(freezeBinds('2026-10', freeze(completeAt), completeAt)).toBe(true)
    expect(freezeBinds('2026-10', freeze(completeAt - 2 * H), completeAt)).toBe(true)
    expect(freezeBinds('2026-10', freeze(completeAt - 2 * H - 1), completeAt)).toBe(false)
    expect(freezeBinds('2026-11', freeze(undefined), completeAt)).toBe(true)
  })

  it('monthHouse: the freeze when it binds, else the space’s current text', () => {
    expect(monthHouse(sp, '2026-09', freeze(sepLock), sepComplete)).toEqual({ reward: 'Frozen dinner', penalty: 'Frozen coffee', frozen: true })
    expect(monthHouse(sp, '2026-10', freeze(firstLock), completeAt)).toEqual({ ...HOUSE, frozen: false })
    expect(monthHouse(sp, '2026-10', freeze(completeAt + 5 * 60_000), completeAt)).toEqual({ reward: 'Frozen dinner', penalty: 'Frozen coffee', frozen: true })
    expect(monthHouse(sp, '2026-10', null, completeAt)).toEqual({ ...HOUSE, frozen: false })
    expect(monthHouse(sp, '2026-10', undefined, completeAt)).toEqual({ ...HOUSE, frozen: false })
    // useMonthStakes' fallback (no doc) isn't a freeze.
    expect(monthHouse(sp, '2026-09', { ...HOUSE, reward: 'x', frozen: false }, sepComplete)).toEqual({ ...HOUSE, frozen: false })
  })

  const week = (weekId: string, b: Partial<Week> = {}): Week => ({ id: weekId, spaceId: 's1', ...weekBounds(weekId, TZ), members: [], submittedBy: [], ...b })

  it('houseFreezeAt: the stored last week, the list if later, computed without a doc; no utcOffsetMin and no doc: the 5th UTC', () => {
    expect(houseFreezeAt(sp, '2026-10')).toBe(completeAt)
    expect(houseFreezeAt(sp, '2026-10', week('2026-10-26', { deadlineAt: completeAt + 3 * H }))).toBe(completeAt + 3 * H)
    // A doc of another week is ignored.
    expect(houseFreezeAt(sp, '2026-10', week('2026-10-19', { deadlineAt: completeAt + 3 * H }))).toBe(completeAt)
    const list = { ...week('2026-10-26'), id: '2026-10', deadlineAt: completeAt + 5 * H }
    expect(houseFreezeAt(sp, '2026-10', null, list)).toBe(completeAt + 5 * H)
    expect(houseFreezeAt(sp, '2026-10', null, { ...list, id: '2026-11' })).toBe(completeAt)
    const old = { ...sp, utcOffsetMin: undefined }
    expect(houseFreezeAt(old, '2026-10')).toBe(Date.parse('2026-11-05T00:00:00Z'))
    expect(houseFreezeAt(old, '2026-12')).toBe(Date.parse('2027-01-05T00:00:00Z'))
    expect(houseFreezeAt(old, '2026-10', week('2026-10-26'))).toBe(completeAt)
  })

  it('needsHouseFreeze: once freezeAt passed and nothing binding is there', () => {
    expect(needsHouseFreeze('2026-10', null, completeAt, completeAt, completeAt - 1)).toBe(false)
    expect(needsHouseFreeze('2026-10', null, completeAt, completeAt, completeAt)).toBe(true)
    expect(needsHouseFreeze('2026-10', freeze(completeAt + H), completeAt, completeAt, completeAt + D)).toBe(false)
    expect(needsHouseFreeze('2026-10', freeze(firstLock), completeAt, completeAt, completeAt + D)).toBe(true)
    expect(needsHouseFreeze('2026-09', freeze(sepLock), sepComplete, sepComplete, sepComplete + D)).toBe(false)
  })

  it('houseFreezeMonths: the UTC month and the one before, never before the space’s creation month (UTC)', () => {
    expect(houseFreezeMonths(sp, Date.parse('2026-10-14T12:00:00Z'))).toEqual(['2026-09', '2026-10'])
    // Berlin is already in November; UTC is still in October.
    expect(houseFreezeMonths(sp, Date.parse('2026-10-31T23:30:00Z'))).toEqual(['2026-09', '2026-10'])
    expect(houseFreezeMonths(sp, Date.parse('2026-11-01T00:30:00Z'))).toEqual(['2026-10', '2026-11'])
    expect(houseFreezeMonths(sp, Date.parse('2027-01-01T00:00:00Z'))).toEqual(['2026-12', '2027-01'])
    expect(houseFreezeMonths({ ...sp, createdAt: Date.parse('2026-10-03T08:00:00Z') }, Date.parse('2026-10-14T12:00:00Z'))).toEqual(['2026-10'])
    expect(houseFreezeMonths({ ...sp, createdAt: Date.parse('2026-09-30T23:00:00Z') }, Date.parse('2026-10-14T12:00:00Z'))).toEqual(['2026-09', '2026-10'])
  })
})

describe('termsMonth', () => {
  const sp = space(['marco', 'lena'])
  const last = weekBounds('2026-10-26', TZ)
  const doc = (b: Partial<Week> = {}): Week => ({ id: '2026-10-26', spaceId: 's1', ...last, members: [], submittedBy: [], ...b })

  it('this week’s month, and the next one once this month is complete', () => {
    expect(termsMonth(sp, Date.parse('2026-10-14T10:00:00Z'))).toBe('2026-10')
    // The Monday of October's last week: still October.
    expect(termsMonth(sp, last.startAt + H)).toBe('2026-10')
    expect(termsMonth(sp, last.deadlineAt - 1)).toBe('2026-10')
    // The Saturday after October's last Friday: November.
    expect(termsMonth(sp, last.deadlineAt)).toBe('2026-11')
    expect(termsMonth(sp, last.deadlineAt + D, doc())).toBe('2026-11')
    // A new week is November's anyway.
    expect(termsMonth(sp, weekBounds('2026-11-02', TZ).startAt + H)).toBe('2026-11')
  })

  it('by the stored deadline of this week, and the monthly list’s if later', () => {
    const stored = doc({ deadlineAt: last.deadlineAt + 12 * H })
    expect(termsMonth(sp, last.deadlineAt + H, stored)).toBe('2026-10')
    expect(termsMonth(sp, last.deadlineAt + 12 * H, stored)).toBe('2026-11')
    const list = { ...doc(), id: '2026-10', deadlineAt: last.deadlineAt + 6 * H }
    expect(termsMonth(sp, last.deadlineAt + H, doc(), list)).toBe('2026-10')
    expect(termsMonth(sp, last.deadlineAt + 6 * H, doc(), list)).toBe('2026-11')
    // A doc of another week doesn't count as this week's.
    expect(termsMonth(sp, last.deadlineAt + H, { ...stored, id: '2026-10-19' })).toBe('2026-11')
  })
})

describe('debts', () => {
  const sp = space(['marco', 'lena', 'sam', 'kim'])
  const friendsOf = (uid: UID) => sp.memberIds.filter((u) => u !== uid)
  const tier = { months: 3, reward: 'Weekend away' }
  // Marco: reward for everyone, agreed by Lena and Sam only (Kim joined later), with a streak reward.
  const later = { ...sp, joinedAt: { ...sp.joinedAt, kim: t3 } }
  const marco = agree(agree(edit(GROUP, { reward: 'Dinner on me', tiers: [tier] }), 'lena', t1), 'sam', t2)
  const lena = own('lena', { penaltyMode: 'each', per: { marco: { reward: '', penalty: 'A coffee' }, sam: { reward: '', penalty: 'A beer' }, kim: { reward: '', penalty: 'A tea' } }, reward: 'Lunch' })
  const lenaAgreed = agree(agree(lena, 'marco', t1), 'sam', t2)
  const stakes = { marco, lena: lenaAgreed }
  const results = {
    marco: result('marco', friendsOf('marco')),
    lena: result('lena', friendsOf('lena'), { passed: false }),
    sam: result('sam', friendsOf('sam')),
    kim: result('kim', friendsOf('kim'), { passed: null }),
  }
  const terms = Object.fromEntries(sp.memberIds.map((uid) => [uid, memberTerms(later, uid, friendsOf(uid), stakes, HOUSE, Infinity)]))

  it('each pair both ways: reward when the subject passed, penalty when they missed; nothing for a null verdict', () => {
    const debts = monthDebts('2026-10', results, terms, null)
    expect(debts.filter((d) => d.subject === 'marco').map((d) => [d.kind, d.other, d.what, d.together, d.source])).toEqual([
      ['reward', 'lena', 'Dinner on me', true, 'agreed'],
      ['reward', 'sam', 'Dinner on me', true, 'agreed'],
      ['reward', 'kim', 'Dinner on me', true, 'house'],
    ])
    expect(debts.filter((d) => d.subject === 'lena').map((d) => [d.kind, d.other, d.what, d.together])).toEqual([
      ['penalty', 'marco', 'A coffee', false],
      ['penalty', 'sam', 'A beer', false],
      ['penalty', 'kim', 'Coffee for a week', true],
    ])
    expect(debts.filter((d) => d.subject === 'kim')).toEqual([])
    expect(debts.every((d) => d.monthId === '2026-10')).toBe(true)
  })

  it('streak rewards: owed in the month the run first equals the length, by the friends on those agreed terms', () => {
    const allAgreed = agree(marco, 'kim', t4)
    const t = { ...terms, marco: memberTerms(later, 'marco', friendsOf('marco'), { ...stakes, marco: allAgreed }, HOUSE, Infinity) }
    const tiers = monthDebts('2026-10', results, t, { marco: { '3': 3 } }).filter((d) => d.kind === 'tier')
    expect(tiers.map((d) => [d.other, d.what, d.tier, d.together])).toEqual([
      ['lena', 'Weekend away', 3, true],
      ['sam', 'Weekend away', 3, true],
      ['kim', 'Weekend away', 3, true],
    ])
    expect(monthDebts('2026-10', results, t, { marco: { '3': 4 } }).filter((d) => d.kind === 'tier')).toEqual([])
    expect(monthDebts('2026-10', results, t, null).filter((d) => d.kind === 'tier')).toEqual([])
    // Kim joined after Lena and Sam agreed and never agreed herself: the streak reward counts for those two
    // (everyone needed when they agreed), and Kim, on the house stakes, owes no streak reward.
    expect(monthDebts('2026-10', results, terms, { marco: { '3': 3 } }).filter((d) => d.kind === 'tier').map((d) => d.other)).toEqual(['lena', 'sam'])
  })

  it('debtLines groups together debts by subject, kind, text and source; reward, tiers ascending, penalty', () => {
    const t = {
      marco: {
        lena: { reward: { text: 'Dinner', together: true, source: 'agreed' as const, at: t1 }, penalty: houseLine('x'), tiers: [{ months: 6, reward: 'Trip' }, tier] },
        sam: { reward: { text: 'Dinner', together: true, source: 'agreed' as const, at: t2 }, penalty: houseLine('x'), tiers: [{ months: 6, reward: 'Trip' }, tier] },
        kim: { reward: houseLine('Dinner'), penalty: houseLine('x'), tiers: [] },
      },
      lena: { marco: { reward: houseLine('r'), penalty: { text: 'A coffee', together: false, source: 'agreed' as const }, tiers: [] }, sam: { reward: houseLine('r'), penalty: { text: 'A coffee', together: false, source: 'agreed' as const }, tiers: [] }, kim: ON_HOUSE },
    }
    const res = { marco: result('marco', ['lena', 'sam', 'kim']), lena: result('lena', ['marco', 'sam', 'kim'], { passed: false }) }
    const lines = debtLines(monthDebts('2026-10', res, t, { marco: { '3': 3, '6': 6 } }))
    expect(lines.map((l) => [l.subject, l.kind, l.what, l.tier, l.together, l.source, l.debtors, l.creditors])).toEqual([
      ['marco', 'reward', 'Dinner', undefined, true, 'agreed', ['lena', 'sam'], ['marco']],
      ['marco', 'reward', 'Dinner', undefined, true, 'house', ['kim'], ['marco']],
      ['marco', 'tier', 'Weekend away', 3, true, 'agreed', ['lena', 'sam'], ['marco']],
      ['marco', 'tier', 'Trip', 6, true, 'agreed', ['lena', 'sam'], ['marco']],
      ['lena', 'penalty', 'A coffee', undefined, false, 'agreed', ['lena'], ['marco']],
      ['lena', 'penalty', 'A coffee', undefined, false, 'agreed', ['lena'], ['sam']],
      ['lena', 'penalty', 'Coffee for a week', undefined, true, 'house', ['lena'], ['kim']],
    ])
    expect(lines[0].keys).toEqual([
      { uid: 'marco', other: 'lena' },
      { uid: 'marco', other: 'sam' },
    ])
    expect(lines[2].keys).toEqual([
      { uid: 'marco', other: 'lena', tier: 3 },
      { uid: 'marco', other: 'sam', tier: 3 },
    ])
  })

  it('nothing owed with nobody else', () => {
    expect(monthDebts('2026-10', { marco: result('marco', []) }, {}, null)).toEqual([])
  })
})

describe('settlements', () => {
  const s = (id: string, x: Partial<Settlement>): Settlement => ({ id, monthId: '2026-10', uid: 'marco', settled: true, settledBy: 'marco', settledAt: 1, ...x })
  const legacy = s('2026-10_marco', { settledAt: 5 })
  const pairSam = s('2026-10_marco_sam', { other: 'sam', settled: false, settledAt: 9 })
  const tierLena = s('2026-10_marco_lena_s3', { other: 'lena', tier: 3, settledAt: 7 })

  it('a pair doc decides its pair; else the legacy doc covers non-streak debts; never a streak reward', () => {
    const all = [legacy, pairSam, tierLena, s('2026-09_marco_lena', { monthId: '2026-09', other: 'lena' })]
    expect(pairSettlement(all, '2026-10', { uid: 'marco', other: 'lena' })).toBe(legacy)
    expect(pairSettlement(all, '2026-10', { uid: 'marco', other: 'sam' })).toBe(pairSam)
    expect(pairSettlement(all, '2026-10', { uid: 'marco', other: 'lena', tier: 3 })).toBe(tierLena)
    expect(pairSettlement(all, '2026-10', { uid: 'marco', other: 'sam', tier: 3 })).toBeUndefined()
    expect(pairSettlement(all, '2026-11', { uid: 'marco', other: 'lena' })).toBeUndefined()
  })

  it('a line is settled when every pair is; the newest mark is the one shown', () => {
    const line = {
      subject: 'marco',
      kind: 'reward' as const,
      what: 'Dinner',
      together: true,
      source: 'house' as const,
      debtors: ['lena', 'sam'],
      creditors: ['marco'],
      keys: [
        { uid: 'marco', other: 'lena' },
        { uid: 'marco', other: 'sam' },
      ],
    }
    expect(lineSettlement([legacy, pairSam], '2026-10', line)).toEqual({ settled: false })
    const both = [legacy, { ...pairSam, settled: true }]
    expect(lineSettlement(both, '2026-10', line)).toEqual({ settled: true, last: both[1] })
    expect(lineSettlement([legacy], '2026-10', line)).toEqual({ settled: true, last: legacy })
    expect(lineSettlement([], '2026-10', line)).toEqual({ settled: false })
  })
})

describe('streaks and streak rewards', () => {
  const pass = { finalScore: 95, passed: true, others: ['lena'] }
  const miss = { finalScore: 50, passed: false, others: ['lena'] }
  const sat = { finalScore: null, passed: null, others: ['lena'] }
  const solo = { finalScore: 95, passed: true, others: [] }
  const t3 = { months: 3, reward: 'Weekend away' }
  const t6 = { months: 6, reward: 'A trip' }

  it('nextStreak: pass, pass, miss, pass; a month with no score or nobody else carries', () => {
    let s = 0
    const seen: number[] = []
    for (const m of [pass, pass, sat, solo, miss, pass]) seen.push((s = nextStreak(s, m)))
    expect(seen).toEqual([1, 2, 2, 2, 0, 1])
    expect(nextStreak(4, undefined)).toBe(4)
  })

  it('Marco on a 5-month streak adds tiers 3 and 6: owed after 3 and 6 more passes', () => {
    let runs: Record<string, number> | undefined
    let streak = 5
    const owed: string[] = []
    for (let i = 1; i <= 7; i++) {
      runs = nextTierRuns(runs, pass, [t3, t6])
      streak = nextStreak(streak, pass)
      for (const t of [t3, t6]) if (runs[String(t.months)] === t.months) owed.push(`${i}:${t.months}`)
    }
    expect(owed).toEqual(['3:3', '6:6'])
    expect(streak).toBe(12)
    expect(runs).toEqual({ '3': 7, '6': 7 })
  })

  it('a tier agreed while the streak is 2 is owed only after its own run reaches its length', () => {
    // Two passes before the tier was in force: no run yet.
    let runs = nextTierRuns(nextTierRuns(undefined, pass, []), pass, [])
    expect(runs).toEqual({})
    runs = nextTierRuns(runs, pass, [t3])
    expect(runs).toEqual({ '3': 1 })
  })

  it('a miss resets every run; a skipped month carries; a tier not in force drops its run', () => {
    expect(nextTierRuns({ '3': 2, '6': 2 }, miss, [t3, t6])).toEqual({ '3': 0, '6': 0 })
    expect(nextTierRuns({ '3': 2, '6': 2 }, sat, [])).toEqual({ '3': 2, '6': 2 })
    expect(nextTierRuns({ '3': 2, '6': 2 }, solo, [])).toEqual({ '3': 2, '6': 2 })
    expect(nextTierRuns({ '3': 2, '6': 2 }, undefined, [t3])).toEqual({ '3': 2, '6': 2 })
    expect(nextTierRuns({ '3': 2, '6': 2 }, pass, [t3])).toEqual({ '3': 3 })
    expect(nextTierRuns({ '3': 2 }, miss, [])).toEqual({})
  })

  const terms3 = { marco: { lena: { reward: { text: 'D', together: true, source: 'agreed' as const, at: 1 }, penalty: houseLine('P'), tiers: [t3] } } }

  it('buildMonthResults: the roster plus everyone in the previous doc, streaks and runs carried', () => {
    const month = { marco: result('marco', ['lena']), lena: result('lena', ['marco'], { passed: false }) }
    const prev: MonthResults = {
      monthId: '2026-10',
      completeAt: 1,
      members: { marco: { score: 92, passed: true, streak: 2, tierRuns: { '3': 2 } }, ben: { score: 80, passed: false, streak: 0 }, lena: { score: 91, passed: true, streak: 4 } },
      createdAt: 2,
    }
    const r = buildMonthResults('2026-11', 123, { ...month, marco: { ...month.marco, monthId: '2026-11' } }, prev, terms3)
    expect(r).toEqual({
      monthId: '2026-11',
      completeAt: 123,
      members: {
        marco: { score: 95, passed: true, streak: 3, tierRuns: { '3': 3 } },
        lena: { score: 50, passed: false, streak: 0 },
        ben: { score: null, passed: null, streak: 0 },
      },
      terms: terms3,
    })
    // No player pairs: no terms key; no prev: from 0.
    const r2 = buildMonthResults('2026-10', 5, { marco: result('marco', []) }, null, { marco: {} })
    expect(r2).toEqual({ monthId: '2026-10', completeAt: 5, members: { marco: { score: 95, passed: true, streak: 0 } } })
  })

  it('provisional streaks: from the previous doc, or from 0 in the space’s first month or FIRST_RESULTS_MONTH; else unknown', () => {
    const month = { marco: result('marco', ['lena']) }
    expect(provisionalStreaks('2026-10', '2026-03', null, month, terms3)).toEqual({ streaks: { marco: 1 }, tierRuns: { marco: { '3': 1 } } })
    expect(provisionalStreaks('2026-11', '2026-03', null, month, terms3)).toBeNull()
    expect(provisionalStreaks('2026-12', '2026-12', null, month, terms3)).toEqual({ streaks: { marco: 1 }, tierRuns: { marco: { '3': 1 } } })
    expect(provisionalStreaks('2026-09', '2026-03', null, month, terms3)).toBeNull()
    const prev: MonthResults = { monthId: '2026-10', completeAt: 1, members: { marco: { score: 95, passed: true, streak: 2, tierRuns: { '3': 2 } } }, createdAt: 2 }
    expect(provisionalStreaks('2026-11', '2026-03', prev, month, terms3)).toEqual({ streaks: { marco: 3 }, tierRuns: { marco: { '3': 3 } } })
  })

  it('streaksFor: the month’s own doc, else provisional', () => {
    const own: MonthResults = { monthId: '2026-11', completeAt: 1, members: { marco: { score: 95, passed: true, streak: 7, tierRuns: { '3': 7 } }, lena: { score: 10, passed: false, streak: 0 } }, createdAt: 2 }
    expect(streaksFor('2026-11', '2026-03', own, null, {}, {})).toEqual({ streaks: { marco: 7, lena: 0 }, tierRuns: { marco: { '3': 7 }, lena: {} } })
    expect(streaksFor('2026-11', '2026-03', null, null, {}, {})).toBeNull()
  })
})
