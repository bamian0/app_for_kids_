import { describe, expect, it } from 'vitest'
import { debtLines, nextAgreement, pairTerms } from '../../domain/stakes.ts'
import type { Debt } from '../../domain/stakes.ts'
import type { MemberMonthResult } from '../../domain/scoring.ts'
import { weekBounds } from '../../domain/time.ts'
import type { MemberStakes, MonthResults, Space, TermsInForce, UID } from '../../domain/types.ts'
import {
  canSettleLine,
  debtLineSubtitle,
  debtLineText,
  judgedFootnote,
  judgeOnly,
  monthDebtView,
  monthlyDetail,
  monthSummary,
  settleLineHint,
  soFar,
  streakPill,
  weekDetail,
} from '../components/month.ts'
import {
  agreeConfirm,
  agreeOutcomeNow,
  agreeToast,
  draftFrom,
  draftInput,
  draftValid,
  friendRows,
  groupedText,
  ownFooter,
  saveMessage,
  stakesAfterSave,
  stakesCard,
  stakesFromLive,
  streakLine,
  streakNote,
  switchMode,
  termsNow,
  unusedTierChoices,
  waitingFooter,
} from './stakes.ts'
import { waitingFor } from '../../domain/stakes.ts'

const TZ = 'Europe/Berlin'
const H = 3_600_000
const D = 24 * H
const T0 = Date.parse('2026-09-01T10:00:00Z')
/** Wednesday Oct 14, mid-October: October's terms count now. */
const MID = Date.parse('2026-10-14T10:00:00Z')
/** October completes at its last week's deadline: Saturday Oct 31 00:00 in Berlin. */
const OCT_END = weekBounds('2026-10-26', TZ).deadlineAt
/** The Saturday after October's last Friday: changes count from November. */
const SAT = OCT_END + 12 * H
const HOUSE = { reward: 'Dinner on me', penalty: 'Coffee for a week' }
const NAMES: Record<UID, string> = { marco: 'Marco', lena: 'Lena', sam: 'Sam', kim: 'Kim', ana: 'Ana', ben: 'Ben', zoe: 'Zoe', ivy: 'Ivy' }
const name = (uid: UID) => NAMES[uid] ?? uid

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

function agree(st: MemberStakes, friend: UID, at: number): MemberStakes {
  const terms = pairTerms(st, friend)
  if (!terms) throw new Error(`no terms for ${friend}`)
  const next = nextAgreement(st.agreed[friend], terms)
  return next ? { ...st, agreed: { ...st.agreed, [friend]: { at, ...next } } } : st
}

const GROUP = own('marco', { reward: 'Dinner, on you', penalty: 'Pizza for all', updatedAt: MID - 2 * D })

describe('the stakes card', () => {
  const three = space(['marco', 'lena', 'sam'])

  it('shows the house rows and no status lines while the stakes load or failed', () => {
    const loading = stakesFromLive({ data: undefined, error: null })
    const failed = stakesFromLive({ data: { marco: GROUP }, error: new Error('Missing or insufficient permissions.') })
    expect(failed).toBeUndefined()
    for (const stakes of [loading, failed]) {
      const card = stakesCard({ space: three, me: 'marco', stakes, nowMs: MID, name })
      expect(card.rows.map((r) => r.text)).toEqual(['Dinner on me', 'Coffee for a week'])
      expect(card.rows.map((r) => r.label)).toEqual(['Hit 90%, they owe you', 'Miss, you owe them'])
      expect(card.news).toBeNull()
      expect(card.pending).toBeNull()
    }
  })

  it('shows a change everyone agreed to at once, and the old texts while one friend is still waiting', () => {
    const lena = agree(GROUP, 'lena', MID - D)
    const waiting = stakesCard({ space: three, me: 'marco', stakes: { marco: lena }, nowMs: MID, name })
    expect(waiting.rows.map((r) => r.text)).toEqual(['Dinner on me', 'Coffee for a week'])
    expect(waiting.pending).toMatchObject({ kind: 'waiting', text: 'Your new stakes: waiting for Sam to agree', uids: ['sam'] })

    const both = agree(lena, 'sam', MID - H)
    const agreed = stakesCard({ space: three, me: 'marco', stakes: { marco: both }, nowMs: MID, name })
    expect(agreed.rows.map((r) => r.text)).toEqual(['Dinner, on you', 'Pizza for all'])
    expect(agreed.pending).toEqual({ kind: 'agreed', text: 'Everyone agreed' })
  })

  it('groups friends by text, at most three groups', () => {
    expect(groupedText([['lena', 'Dinner'], ['sam', 'Dinner'], ['kim', 'Coffee']], name)).toBe('Lena and Sam: Dinner · Kim: Coffee')
    expect(groupedText([['lena', 'Dinner'], ['sam', 'Dinner']], name)).toBe('Dinner')
    expect(
      groupedText(
        [['lena', 'A'], ['sam', 'B'], ['kim', 'C'], ['ana', 'D'], ['ben', 'E'], ['zoe', 'C']],
        name,
      ),
    ).toBe('Lena: A · Sam: B · Kim and Zoe: C · and 2 more')
  })

  it('shows a per-friend line grouped by friend, with the house text for a friend not on it yet', () => {
    // The owner's example: one dinner from the whole group, a penalty of its own per friend.
    const mixed = own('marco', { reward: 'Dinner, on you', penaltyMode: 'each', per: { lena: { reward: '', penalty: 'A coffee' }, sam: { reward: '', penalty: 'A beer' } }, tiers: [{ months: 3, reward: 'Weekend away' }] })
    const afterLena = agree(mixed, 'lena', MID - D)
    const card = stakesCard({ space: three, me: 'marco', stakes: { marco: afterLena }, nowMs: MID, name })
    expect(card.rows.map((r) => r.text)).toEqual(['Dinner on me', 'Lena: A coffee · Sam: Coffee for a week'])
    expect(card.pending?.text).toBe('Your new stakes: waiting for Sam to agree')
    const afterSam = agree(afterLena, 'sam', MID - H)
    const done = stakesCard({ space: three, me: 'marco', stakes: { marco: afterSam }, nowMs: MID, name })
    expect(done.rows.map((r) => r.text)).toEqual(['Dinner, on you', 'Lena: A coffee · Sam: A beer'])
    expect(done.pending?.text).toBe('Everyone agreed')
  })

  it('tells a friend whose Agree is needed, and opens on that friend', () => {
    const card = stakesCard({ space: three, me: 'lena', stakes: { marco: GROUP }, nowMs: MID, name })
    expect(card.news).toEqual({ kind: 'agree', text: 'New stakes from Marco', uids: ['marco'], focus: 'marco' })
    expect(card.pending).toEqual({ kind: 'house', text: 'Same stakes for everyone, for now.' })
    const two = stakesCard({ space: three, me: 'lena', stakes: { marco: GROUP, sam: own('sam', { reward: 'X', penalty: 'Y' }) }, nowMs: MID, name })
    expect(two.news?.text).toBe('New stakes from Marco and Sam')
  })

  it('says when a friend changed their stakes without needing you, until dismissed', () => {
    const sp = space(['marco', 'lena', 'sam'])
    // Lena agreed to her own penalty; then Marco changed only Sam's: Lena's terms stand, so it's only news.
    const each = own('marco', { reward: 'Dinner', penaltyMode: 'each', per: { lena: { reward: '', penalty: 'A coffee' }, sam: { reward: '', penalty: 'A beer' } }, updatedAt: MID - 3 * D })
    const lena = agree(each, 'lena', MID - 3 * D + H)
    const changed = { ...lena, per: { ...lena.per, sam: { reward: '', penalty: 'Two beers' } }, updatedAt: MID - 2 * D }
    const key = `stakesSeen.s1.marco.${MID - 2 * D}`
    const card = stakesCard({ space: sp, me: 'lena', stakes: { marco: changed }, nowMs: MID, name })
    expect(card.news).toEqual({ kind: 'friend', text: 'Marco has new stakes', uid: 'marco', seenKey: key })
    const dismissed = stakesCard({ space: sp, me: 'lena', stakes: { marco: changed }, nowMs: MID, name, seen: (k) => k === key })
    expect(dismissed.news).toBeNull()
    // A week later it isn't news anymore.
    expect(stakesCard({ space: sp, me: 'lena', stakes: { marco: changed }, nowMs: MID + 8 * D, name }).news).toBeNull()
    // Nor once you agreed to them after the change.
    expect(stakesCard({ space: sp, me: 'lena', stakes: { marco: agree(GROUP, 'lena', MID - D) }, nowMs: MID, name }).news).toBeNull()
  })

  it('shows the owner’s house-stakes edit at once, even with an early October freeze (the card reads the space)', () => {
    // An early freeze of October would say otherwise; the card never reads it: what counts is the space's text.
    const edited = space(['lena', 'kim', 'sam'], { reward: 'Brunch on us', penalty: 'Wash the dishes', stakesNote: { by: 'lena', at: MID - H } })
    const kim = stakesCard({ space: edited, me: 'kim', stakes: {}, nowMs: MID, name })
    expect(kim.rows.map((r) => r.text)).toEqual(['Brunch on us', 'Wash the dishes'])
    expect(kim.news).toEqual({ kind: 'house', text: 'Lena changed the house stakes', message: 'They count now.', seenKey: `houseSeen.s1.${MID - H}` })
    // The owner who changed them sees the rows, no notice.
    expect(stakesCard({ space: edited, me: 'lena', stakes: {}, nowMs: MID, name }).news).toBeNull()
    // Someone who joined after the change gets no notice.
    const late = { ...edited, joinedAt: { ...edited.joinedAt, kim: MID } }
    expect(stakesCard({ space: late, me: 'kim', stakes: {}, nowMs: MID + H, name }).news).toBeNull()
  })

  it('a house change made after October completed counts from November', () => {
    const edited = space(['lena', 'kim'], { stakesNote: { by: 'lena', at: SAT - H } })
    const kim = stakesCard({ space: edited, me: 'kim', stakes: {}, nowMs: SAT, name })
    expect(kim.news).toMatchObject({ kind: 'house', message: 'They count from November.' })
  })

  it('a friend who left before agreeing holds a shared line: old rows and the leaver line, never “Everyone agreed”', () => {
    const four = space(['marco', 'lena', 'sam', 'ben'])
    const st = agree(agree(GROUP, 'lena', MID - 2 * D), 'sam', MID - D)
    // Ben leaves after October's first lock without agreeing.
    const gone = { ...four, memberIds: ['marco', 'lena', 'sam'], joinedAt: { marco: T0, lena: T0, sam: T0 }, leftAt: { ben: MID - H } }
    const card = stakesCard({ space: gone, me: 'marco', stakes: { marco: st }, nowMs: MID, name })
    expect(card.rows.map((r) => r.text)).toEqual(['Dinner on me', 'Coffee for a week'])
    expect(card.pending).toEqual({ kind: 'leaver', text: 'Ben left before agreeing, so your shared stakes count from November.', uids: ['ben'] })
  })

  it('asks for stakes for a friend who has none, and tells a judge nothing is owed', () => {
    const sp = space(['marco', 'lena', 'kim'])
    const each = agree(own('marco', { rewardMode: 'each', penalty: 'Pizza', per: { lena: { reward: 'Lunch', penalty: '' } } }), 'lena', MID - D)
    expect(stakesCard({ space: sp, me: 'marco', stakes: { marco: each }, nowMs: MID, name }).pending).toEqual({ kind: 'missing', text: 'Add your stakes for Kim', uids: ['kim'] })
    const judged = space(['marco', 'lena', 'kim'], { judges: ['kim'] })
    const kim = stakesCard({ space: judged, me: 'kim', stakes: { marco: GROUP }, nowMs: MID, name })
    expect(kim.pending).toEqual({ kind: 'judge', text: 'You’re judging: nothing’s owed while you only rate.' })
    // A judge isn't asked to agree.
    expect(kim.news?.kind).not.toBe('agree')
  })

  it('alone: the house rows and nothing else', () => {
    const card = stakesCard({ space: space(['marco']), me: 'marco', stakes: {}, nowMs: MID, name })
    expect(card.alone).toBe(true)
    expect(card.news).toBeNull()
    expect(card.pending).toBeNull()
  })
})

describe('when it counts', () => {
  it('is this week’s month, and the next one after the month completed', () => {
    const sp = space(['marco', 'lena'])
    expect(termsNow(sp, MID)).toMatchObject({ month: '2026-10', thisMonth: '2026-10', window: false })
    expect(termsNow(sp, SAT)).toMatchObject({ month: '2026-11', thisMonth: '2026-10', window: true })
    expect(termsNow(sp, OCT_END - H).window).toBe(false)
  })

  it('says “from November” only in the completion window', () => {
    const sp = space(['marco', 'lena', 'sam'])
    const mid = termsNow(sp, MID)
    const sat = termsNow(sp, SAT)
    expect(saveMessage(['Lena'], 2, mid)).toBe('Counts as soon as Lena agrees.')
    expect(saveMessage(['Lena', 'Sam'], 2, mid)).toBe('Counts as soon as Lena and Sam agree.')
    expect(saveMessage(['Lena', 'Sam', 'Kim', 'Ana'], 4, mid)).toBe('Counts as soon as all 4 friends agree.')
    expect(saveMessage([], 2, mid)).toBe('Counts now.')
    expect(saveMessage([], 0, mid)).toBeUndefined()
    expect(saveMessage([], 2, sat)).toBe('Counts from November. October is final.')
    expect(saveMessage(['Lena'], 2, sat)).toBe('Counts from November, as soon as Lena agrees.')
    for (const text of [saveMessage(['Lena'], 2, mid), saveMessage([], 2, mid)]) expect(text).not.toContain('November')
  })

  it('tells the save toast who has to agree, from the saved terms', () => {
    const agreed = agree(agree(GROUP, 'lena', MID - D), 'sam', MID - H)
    // Back to terms everyone agreed to: counts now.
    const same = stakesAfterSave('marco', draftInput(draftFrom(agreed, HOUSE, ['lena', 'sam']), ['lena', 'sam']), agreed, MID)
    expect(waitingFor(same, ['lena', 'sam'])).toEqual([])
    // Switching a line to per friend changes every pair: everyone has to agree again.
    const d = switchMode(draftFrom(agreed, HOUSE, ['lena', 'sam']), 'penalty', 'each')
    const switched = stakesAfterSave('marco', draftInput(d, ['lena', 'sam']), agreed, MID)
    expect(waitingFor(switched, ['lena', 'sam'])).toEqual(['lena', 'sam'])
    // Then only Lena's penalty changes: only Lena has to agree.
    const both = agree(agree(switched, 'lena', MID), 'sam', MID + H)
    const e = draftFrom(both, HOUSE, ['lena', 'sam'])
    const lenaOnly = stakesAfterSave('marco', draftInput({ ...e, per: { ...e.per, lena: { reward: '', penalty: 'Two coffees' } } }, ['lena', 'sam']), both, MID + 2 * H)
    expect(waitingFor(lenaOnly, ['lena', 'sam'])).toEqual(['lena'])
  })
})

describe('agreeing', () => {
  const three = space(['marco', 'lena', 'sam'])
  const mixed = own('marco', { reward: 'Dinner, on you', penaltyMode: 'each', per: { lena: { reward: '', penalty: 'A coffee' }, sam: { reward: '', penalty: 'A beer' } }, tiers: [{ months: 3, reward: 'Weekend away' }] })

  it('confirms the lines as they apply to you and when they count (partly)', () => {
    const now = termsNow(three, MID)
    const outcome = agreeOutcomeNow(three, 'marco', 'lena', { marco: mixed }, now, MID)
    expect(outcome).toEqual({ counts: 'partly', waitingFor: ['sam'] })
    const confirm = agreeConfirm('Marco', pairTerms(mixed, 'lena')!, outcome, now, name)
    expect(confirm.title).toBe('Agree to Marco’s stakes?')
    expect(confirm.lines).toEqual([
      'Marco hits 90%: you all owe “Dinner, on you”, together.',
      'If Marco misses, you get “A coffee”.',
      '3 months in a row: you all owe “Weekend away”, together.',
      'Your own part counts right away, the shared part once Sam agrees too.',
    ])
    expect(agreeToast('Marco', outcome, now, name)).toEqual({ title: 'You agreed to Marco’s stakes', message: 'Part counts now, the rest once Sam agrees.' })
  })

  it('counts right away for the last one, and once the others agree for a group line', () => {
    const now = termsNow(three, MID)
    const afterLena = agree(mixed, 'lena', MID - D)
    const sam = agreeOutcomeNow(three, 'marco', 'sam', { marco: afterLena }, now, MID)
    expect(sam.counts).toBe('now')
    expect(agreeConfirm('Marco', pairTerms(afterLena, 'sam')!, sam, now, name).lines.at(-1)).toBe('They count right away.')
    expect(agreeToast('Marco', sam, now, name).message).toBe('They count now.')

    const group = own('marco', { reward: 'Dinner', penalty: 'Coffee for a week, the lot' })
    const later = agreeOutcomeNow(three, 'marco', 'lena', { marco: group }, now, MID)
    expect(later).toEqual({ counts: 'later', waitingFor: ['sam'] })
    const lines = agreeConfirm('Marco', pairTerms(group, 'lena')!, later, now, name).lines
    expect(lines[1]).toBe('If Marco misses, the group gets “Coffee for a week, the lot”.')
    expect(lines.at(-1)).toBe('They count once Sam agrees too.')
    expect(agreeToast('Marco', later, now, name).message).toBe('They count once Sam agrees too.')
  })

  it('on the Saturday after the month’s last Friday, an Agree counts from November', () => {
    const now = termsNow(three, SAT)
    const afterLena = agree(mixed, 'lena', SAT - H)
    const sam = agreeOutcomeNow(three, 'marco', 'sam', { marco: afterLena }, now, SAT)
    expect(agreeToast('Marco', sam, now, name).message).toBe('They count from November.')
    expect(agreeConfirm('Marco', pairTerms(afterLena, 'sam')!, sam, now, name).lines.at(-1)).toBe('They count from November. October is final.')
    const partly = agreeOutcomeNow(three, 'marco', 'lena', { marco: mixed }, now, SAT)
    expect(agreeToast('Marco', partly, now, name).message).toBe('Part counts from November, the rest once Sam agrees.')
    expect(agreeConfirm('Marco', pairTerms(mixed, 'lena')!, partly, now, name).lines.at(-1)).toBe('Your own part counts from November, the shared part once Sam agrees too.')
  })

  it('shows a friend’s terms as they apply to you', () => {
    const rows = friendRows('Lena', {
      reward: { text: 'Dinner', together: true, source: 'agreed' },
      penalty: { text: 'A coffee', together: false, source: 'agreed' },
      tiers: [{ months: 3, reward: 'Weekend away' }],
    })
    expect(rows.map((r) => [r.label, r.text, r.note])).toEqual([
      ['Lena hits 90%, you owe', 'Dinner, with everyone', undefined],
      ['Lena misses, you get', 'A coffee', undefined],
      ['Lena: 3 months in a row, you owe', 'Weekend away', 'Together with everyone'],
    ])
    const house = friendRows('Lena', { reward: { text: 'Dinner on me', together: true, source: 'house' }, penalty: { text: 'Coffee for a week', together: true, source: 'house' }, tiers: [] })
    expect(house[1].text).toBe('Coffee for a week, shared with everyone')
  })
})

describe('footers and waiting lines', () => {
  it('never says “Everyone agreed” while anyone is still waiting', () => {
    const waiting = ownFooter({ waiting: ['Sam'], total: 2, leavers: [], month: '2026-10', allAgreed: false })
    expect(waiting).toBe('Your new stakes count as soon as Sam agrees.')
    expect(ownFooter({ waiting: ['Sam', 'Ana'], total: 3, leavers: [], month: '2026-10', allAgreed: false })).toBe('Your new stakes count as soon as Sam and Ana agree.')
    expect(ownFooter({ waiting: [], total: 2, leavers: [], month: '2026-10', allAgreed: true, streak: 3 })).toBe('Everyone agreed: they count now. Your streak: 3 months in a row.')
    expect(ownFooter({ waiting: [], total: 2, leavers: ['Ben'], month: '2026-10', allAgreed: false })).toBe(
      'Everyone here agreed. Ben left before agreeing, so your shared stakes count from November.',
    )
    for (const f of [waiting, ownFooter({ waiting: ['Sam'], total: 2, leavers: ['Ben'], month: '2026-10', allAgreed: true })]) {
      expect(f).not.toContain('Everyone agreed')
    }
  })

  it('names who a friend’s stakes wait for', () => {
    expect(waitingFooter(['sam', 'lena'], 'lena', name)).toBe('Waiting for Sam and you')
    expect(waitingFooter(['sam'], 'lena', name)).toBe('Waiting for Sam')
    expect(waitingFooter(['sam', 'ana'], 'lena', name)).toBe('Waiting for Sam and Ana')
    expect(waitingFooter(['sam', 'ana', 'kim', 'ben'], 'lena', name)).toBe('Waiting for 4 friends')
    expect(waitingFooter([], 'lena', name)).toBe('Everyone agreed')
  })

  it('shows your streak from 2 months on', () => {
    expect(streakLine(1)).toBeNull()
    expect(streakLine(2)).toBe('Your streak: 2 months in a row.')
    expect(streakLine(null)).toBeNull()
  })

  it('says when streaks are late, only for a complete month from October 2026 on', () => {
    expect(streakNote(false, true, '2026-10', '2026-10', OCT_END, OCT_END + D)).toBe('Streaks update within a day of the month ending.')
    expect(streakNote(false, true, '2026-10', '2026-10', OCT_END, OCT_END + 4 * D)).toBe('Streaks are running late. They’ll catch up.')
    expect(streakNote(true, true, '2026-10', '2026-10', OCT_END, OCT_END + 4 * D)).toBeNull()
    expect(streakNote(false, false, '2026-10', '2026-10', OCT_END, MID)).toBeNull()
    expect(streakNote(false, true, '2026-09', '2026-10', OCT_END, OCT_END + D)).toBeNull()
  })
})

describe('the editor', () => {
  const friends = ['lena', 'sam', 'kim']

  it('prefills the house stakes, the same for everyone', () => {
    const d = draftFrom(undefined, HOUSE, friends)
    expect(d).toMatchObject({ rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner on me', penalty: 'Coffee for a week', tiers: [] })
    expect(draftValid(d, friends, [])).toBe(true)
  })

  it('switching a line prefills its empty fields from the other mode', () => {
    const d = switchMode(draftFrom(undefined, HOUSE, friends), 'reward', 'each')
    expect(Object.values(d.per).map((e) => e.reward)).toEqual(['Dinner on me', 'Dinner on me', 'Dinner on me'])
    expect(Object.values(d.per).map((e) => e.penalty)).toEqual(['', '', ''])
    const back = switchMode({ ...d, reward: '', per: { ...d.per, lena: { reward: 'Lunch', penalty: '' } } }, 'reward', 'group')
    expect(back.reward).toBe('Lunch')
  })

  it('lets a judge’s fields stay empty, and leaves them out', () => {
    const d = switchMode(draftFrom(undefined, HOUSE, friends), 'penalty', 'each')
    const filled = { ...d, per: { lena: { reward: '', penalty: 'A coffee' }, sam: { reward: '', penalty: 'A beer' }, kim: { reward: '', penalty: '' } } }
    expect(draftValid(filled, friends, [])).toBe(false)
    expect(draftValid(filled, friends, ['kim'])).toBe(true)
    expect(Object.keys(draftInput(filled, friends).per)).toEqual(['lena', 'sam'])
    // A line for everyone left empty, a duplicate streak length, or text over 120: no Save.
    expect(draftValid({ ...filled, reward: '  ' }, friends, ['kim'])).toBe(false)
    expect(draftValid({ ...filled, tiers: [{ months: 3, reward: 'A' }, { months: 3, reward: 'B' }] }, friends, ['kim'])).toBe(false)
    expect(draftValid({ ...filled, reward: 'x'.repeat(121) }, friends, ['kim'])).toBe(false)
  })

  it('offers the streak lengths not used yet', () => {
    expect(unusedTierChoices([2, 3, 4, 6], [{ months: 3, reward: 'A' }])).toEqual([2, 4, 6])
  })
})

describe('month debt lines', () => {
  const debt = (d: Partial<Debt> & Pick<Debt, 'subject' | 'other' | 'kind' | 'what'>): Debt => ({ monthId: '2026-10', together: true, source: 'agreed', ...d })
  const members = ['marco', 'lena', 'sam', 'kim']

  it('names who owes whom, “you” first', () => {
    const [reward] = debtLines(['marco', 'sam', 'kim'].map((other) => debt({ subject: 'lena', other, kind: 'reward', what: 'Weekend away' })))
    expect(debtLineText(reward, 'marco', name)).toBe('You, Sam and Kim owe Lena: Weekend away')
    const [penalty] = debtLines([debt({ subject: 'lena', other: 'marco', kind: 'penalty', what: 'A coffee', together: false })])
    expect(debtLineText(penalty, 'marco', name)).toBe('Lena owes you: A coffee')
    const [mine] = debtLines(['sam', 'kim', 'ana'].map((other) => debt({ subject: 'marco', other, kind: 'penalty', what: 'Coffee for a week' })))
    expect(debtLineText(mine, 'marco', name)).toBe('You owe Sam, Kim and Ana: Coffee for a week')
    const [tier] = debtLines(['sam', 'kim'].map((other) => debt({ subject: 'marco', other, kind: 'tier', tier: 3, what: 'A weekend away' })))
    expect(debtLineText(tier, 'marco', name)).toBe('Sam and Kim owe you: A weekend away')
  })

  it('lets whoever was owed mark it, or the debtors once everyone owed has left', () => {
    const [reward] = debtLines(['marco', 'sam'].map((other) => debt({ subject: 'lena', other, kind: 'reward', what: 'Dinner' })))
    expect(canSettleLine(reward, 'lena', members)).toBe(true)
    expect(canSettleLine(reward, 'marco', members)).toBe(false)
    expect(settleLineHint(reward, 'marco', members, name)).toBe('Only Lena can mark this.')
    const [group] = debtLines(['sam', 'kim'].map((other) => debt({ subject: 'lena', other, kind: 'penalty', what: 'Coffee' })))
    expect(canSettleLine(group, 'sam', members)).toBe(true)
    expect(canSettleLine(group, 'lena', members)).toBe(false)
    expect(settleLineHint(group, 'lena', members, name)).toBe('Only the people you owe can mark this.')
    expect(settleLineHint(group, 'marco', members, name)).toBe('Only the people Lena owes can mark this.')
    expect(settleLineHint(group, 'sam', members, name)).toBeNull()

    // A line owed only to someone who has left: its debtors mark it.
    const [left] = debtLines([debt({ subject: 'lena', other: 'marco', kind: 'reward', what: 'Dinner', together: false })])
    const stayed = ['marco', 'sam', 'kim']
    expect(canSettleLine(left, 'marco', stayed)).toBe(true)
    expect(canSettleLine(left, 'sam', stayed)).toBe(false)
    expect(settleLineHint(left, 'marco', stayed, name)).toBe('Lena has left, so you can mark this yourself.')
    expect(settleLineHint(left, 'sam', stayed, name)).toBe('Only the people who owe Lena can mark this.')
  })

  it('subtitles a streak reward and a shared line, then who marked it', () => {
    const [tier] = debtLines(['sam', 'kim'].map((other) => debt({ subject: 'marco', other, kind: 'tier', tier: 3, what: 'Weekend away' })))
    expect(debtLineSubtitle(tier, { settled: false }, 'marco', members, name)).toBe('3 months in a row · Together')
    const at = Date.parse('2026-11-02T12:00:00Z')
    expect(debtLineSubtitle(tier, { settled: true, last: { settledBy: 'marco', settledAt: at } }, 'marco', members, name)).toBe(
      '3 months in a row · Together · Settled · marked by you, Nov 2',
    )
    const [one] = debtLines([debt({ subject: 'lena', other: 'marco', kind: 'reward', what: 'Lunch', together: false })])
    expect(debtLineSubtitle(one, { settled: false }, 'marco', members, name)).toBe('Only Lena can mark this.')
    expect(debtLineSubtitle(one, { settled: false }, 'lena', members, name)).toBeUndefined()
  })

  const result = (uid: UID, over: Partial<MemberMonthResult> = {}): MemberMonthResult => ({
    uid,
    monthId: '2026-10',
    former: false,
    others: [],
    weeks: [],
    average: null,
    missedReviews: 0,
    penaltyPoints: 0,
    finalScore: null,
    complete: false,
    passed: null,
    ...over,
  })

  it('reads a month in progress by the score so far', () => {
    const out = soFar({ a: result('a', { finalScore: 92 }), b: result('b', { finalScore: 80 }), c: result('c') }, 90)
    expect([out.a.passed, out.b.passed, out.c.passed]).toEqual([true, false, null])
  })

  it('tells a judge-only month apart', () => {
    expect(judgeOnly(result('a', { judged: ['2026-10-05'] }))).toBe(true)
    expect(judgeOnly(result('a', { judged: ['2026-10-05'], weeks: [{ weekId: '2026-10-12', score: 80, closed: true }] }))).toBe(false)
    expect(judgeOnly(result('a'))).toBe(false)
  })

  it('sums up a month: paused weeks, the month’s list, late points, and a month only judged', () => {
    const closed = () => true
    const weeks = [
      { weekId: '2026-10-05', score: 90, closed: true },
      { weekId: '2026-10-12', score: null, closed: true, paused: true as const },
      { weekId: '2026-10-19', score: 95, closed: true },
      { weekId: '2026-10-26', score: 80, closed: true },
    ]
    expect(monthSummary(result('a', { weeks, finalScore: 88, average: 88 }), closed)).toBe('3 weeks scored · 1 paused')
    const withList = result('a', { weeks: weeks.filter((w) => !w.paused), finalScore: 88, monthly: { score: 92, closed: true, taskCount: 3 }, penaltyPoints: 5 })
    expect(monthSummary(withList, closed)).toBe('3 weeks + October list scored · −5 late')
    expect(monthSummary(result('a', { judged: ['2026-10-05', '2026-10-12'], skippedAsJudge: 2 }), closed)).toBe('Judge · no score this month · didn’t review 2')
    expect(monthSummary(result('a', { judged: ['2026-10-05'] }), closed)).toBe('Judge · no score this month')
    // A judged week in a month they also play counts as a 0% week once closed.
    const mixed = result('a', { weeks: [{ weekId: '2026-10-12', score: 100, closed: true }], judged: ['2026-10-05'], finalScore: 50 })
    expect(monthSummary(mixed, closed)).toBe('2 weeks scored')
    expect(monthSummary(result('a'), closed)).toBe('No scored weeks yet')
  })

  it('reads each week row: paused, judged, scored, or not in', () => {
    const bounds = { startAt: Date.parse('2026-10-05T00:00:00+02:00'), deadlineAt: Date.parse('2026-10-10T00:00:00+02:00') }
    const after = bounds.deadlineAt + H
    const r = result('a', { weeks: [{ weekId: '2026-10-05', score: 92.5, closed: true }] })
    expect(weekDetail(r, '2026-10-05', bounds, after)).toBe('92%')
    expect(weekDetail(result('a', { weeks: [{ weekId: '2026-10-05', score: null, closed: true, paused: true }] }), '2026-10-05', bounds, after)).toBe('Paused')
    expect(weekDetail(result('a', { judged: ['2026-10-05'] }), '2026-10-05', bounds, after)).toBe('Judge')
    const plays = result('a', { judged: ['2026-10-05'], weeks: [{ weekId: '2026-10-12', score: 80, closed: true }] })
    expect(weekDetail(plays, '2026-10-05', bounds, after)).toBe('Judge · 0%')
    expect(weekDetail(plays, '2026-10-05', bounds, bounds.startAt + H)).toBe('Judge')
    expect(weekDetail(result('a'), '2026-10-05', bounds, after)).toBe('Sat out')
    expect(weekDetail(result('a'), '2026-10-05', bounds, bounds.startAt - H)).toBe('Upcoming')
  })

  it('reads the month’s list row, the streak pill and the judges’ footnote', () => {
    expect(monthlyDetail(result('a', { monthly: { score: 92, closed: true, taskCount: 2 } }))).toBe('92%')
    expect(monthlyDetail(result('a', { monthly: { score: 50, closed: false, taskCount: 2 } }))).toBe('In progress')
    expect(monthlyDetail(result('a', { monthlyJudge: true }))).toBe('Judge')
    expect(monthlyDetail(result('a'))).toBe('No list')
    expect(streakPill(3)).toBe('3 months in a row')
    expect(streakPill(1)).toBeNull()
    expect(judgedFootnote(['Kim'], '2026-10')).toBe('Kim judged October.')
    expect(judgedFootnote(['Kim', 'Ana'], '2026-10')).toBe('Kim and Ana judged October.')
    expect(judgedFootnote([], '2026-10')).toBeNull()
  })
})

describe('the month view’s debt lines', () => {
  const sp = space(['marco', 'lena', 'sam'])
  const others = (uid: UID) => ['marco', 'lena', 'sam'].filter((id) => id !== uid)
  const month = (complete: boolean, scores: Record<UID, number>): Record<UID, MemberMonthResult> =>
    Object.fromEntries(
      Object.entries(scores).map(([uid, score]) => [
        uid,
        {
          uid,
          monthId: '2026-10',
          former: false,
          others: others(uid),
          weeks: [{ weekId: '2026-10-05', score, closed: true }],
          average: score,
          missedReviews: 0,
          penaltyPoints: 0,
          finalScore: score,
          complete,
          passed: complete ? score >= 90 : null,
        },
      ]),
    )
  const firstLockAt = weekBounds('2026-09-28', TZ).lockAt
  const agreed = agree(agree(GROUP, 'lena', MID - 2 * H), 'sam', MID - H)

  it('a month in progress quotes what counts now, by the score so far', () => {
    const view = monthDebtView({ space: sp, monthId: '2026-10', results: month(false, { marco: 95, lena: 80, sam: 92 }), stakes: { marco: agreed }, house: HOUSE, completeAt: OCT_END, firstLockAt, stored: null, prev: null })
    const marco = view.lines.filter((l) => l.subject === 'marco')
    expect(marco.map((l) => debtLineText(l, 'marco', name))).toEqual(['Lena and Sam owe you: Dinner, on you'])
    expect(view.streaks).toBeNull()
    // Lena is on the house stakes with everyone (she has no stakes of her own).
    expect(view.lines.filter((l) => l.subject === 'lena').map((l) => debtLineText(l, 'marco', name))).toEqual(['Lena owes you and Sam: Coffee for a week'])
  })

  it('a finished month never changes: agreements after it was complete count from the next month', () => {
    const late = agree(agree(GROUP, 'lena', OCT_END + H), 'sam', OCT_END + 2 * H)
    const view = monthDebtView({ space: sp, monthId: '2026-10', results: month(true, { marco: 95, lena: 80, sam: 92 }), stakes: { marco: late }, house: HOUSE, completeAt: OCT_END, firstLockAt, stored: null, prev: null })
    expect(view.lines.filter((l) => l.subject === 'marco').map((l) => l.what)).toEqual(['Dinner on me'])
    // October is the first results month: streaks start there.
    expect(view.streaks?.streaks.marco).toBe(1)
    // Agreed before it was complete: those terms are October's.
    const before = monthDebtView({ space: sp, monthId: '2026-10', results: month(true, { marco: 95, lena: 80, sam: 92 }), stakes: { marco: agreed }, house: HOUSE, completeAt: OCT_END, firstLockAt, stored: null, prev: null })
    expect(before.lines.filter((l) => l.subject === 'marco').map((l) => l.what)).toEqual(['Dinner, on you'])
  })

  it('uses the stored terms and streak runs once the results are in, with the streak reward due', () => {
    const line = (text: string): TermsInForce['reward'] => ({ text, together: true, source: 'agreed' })
    const pair: TermsInForce = { reward: line('Dinner, on you'), penalty: line('Pizza for all'), tiers: [{ months: 3, reward: 'Weekend away' }] }
    const stored: MonthResults = {
      monthId: '2026-11',
      completeAt: OCT_END + 35 * D,
      members: { marco: { score: 95, passed: true, streak: 3, tierRuns: { '3': 3 } }, lena: { score: 80, passed: false, streak: 0 }, sam: { score: 92, passed: true, streak: 1 } },
      terms: { marco: { lena: pair, sam: pair } },
      createdAt: OCT_END + 36 * D,
    }
    const results = Object.fromEntries(Object.entries(month(true, { marco: 95, lena: 80, sam: 92 })).map(([k, r]) => [k, { ...r, monthId: '2026-11' }]))
    const view = monthDebtView({ space: sp, monthId: '2026-11', results, stakes: {}, house: HOUSE, completeAt: OCT_END + 35 * D, firstLockAt, stored, prev: null })
    const marco = view.lines.filter((l) => l.subject === 'marco')
    expect(marco.map((l) => [debtLineText(l, 'marco', name), l.tier])).toEqual([
      ['Lena and Sam owe you: Dinner, on you', undefined],
      ['Lena and Sam owe you: Weekend away', 3],
    ])
    expect(view.streaks?.streaks.marco).toBe(3)
  })
})
