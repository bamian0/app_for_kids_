import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { dealClock, dealState } from '../../domain/deals.ts'
import { DEALS_FROM_MONTH } from '../../domain/stakes.ts'
import type { MemberMonthResult } from '../../domain/scoring.ts'
import type { Deal, DealPeriod, DealsView, Space, UID } from '../../domain/types.ts'
import { verdictStatus, verdictText } from '../components/month.ts'
import {
  agreeDealConfirm,
  atStakeLine,
  callOffConfirm,
  dealCard,
  dealFooter,
  dealNews,
  dealNote,
  dealWhen,
  DEALS_FOOTNOTE,
  EDITOR_FOOTER,
  editorLengthFooter,
  friendAgreement,
  friendDealRows,
  historyRow,
  houseStakesFooter,
  judgeDealLine,
  leaveDealLine,
  leavingFooter,
  missingTextsLine,
  octoberAlsoLine,
  octoberFooter,
  octoberHeader,
  periodDetail,
  periodRows,
  proposedToast,
  removeDealLine,
  runningLine,
  sameAgainConfirm,
  SETTLE_FOOTER,
  settleRows,
  sortSettleRows,
  statusLine,
  streakAgreeConfirm,
  streakFooter,
  streakMissingText,
  streakSaveMessage,
  streakStatus,
  streakWaiting,
  streaksWaitOnMe,
  waitingOnYouFooter,
  WITHDRAW_CONFIRM,
  yourDealFooter,
} from './deals.ts'
import type { DealCardInput } from './deals.ts'

const TZ = 'Europe/Berlin'
const H = 3_600_000
const D = 24 * H
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis()
const T0 = at('2026-10-01T10:00')
const CREATED = at('2026-11-06T10:00')
const W1 = '2026-11-09'
const W2 = '2026-11-16'
const NAMES: Record<string, string> = { lena: 'Lena', sam: 'Sam', kim: 'Kim', ana: 'Ana', ben: 'Ben' }
const name = (u: UID) => NAMES[u] ?? 'A former member'

function space(x: Partial<Space> = {}): Space {
  return {
    id: 's1',
    name: 'Film Club',
    reward: 'Dinner, on us',
    penalty: 'Coffee for a week',
    ownerId: 'lena',
    memberIds: ['lena', 'sam', 'kim'],
    joinedAt: Object.fromEntries(['lena', 'sam', 'kim', 'ana', 'ben'].map((u) => [u, T0])),
    timezone: TZ,
    utcOffsetMin: 60,
    inviteCode: 'ABCD2345',
    threshold: 90,
    latePenalty: 5,
    createdAt: T0,
    ...x,
  }
}
const SP = space()

function deal(x: Partial<Deal> = {}): Deal {
  return {
    id: 'lena_1',
    spaceId: 's1',
    uid: 'lena',
    seq: 1,
    unit: 'week',
    count: 2,
    rewardMode: 'group',
    penaltyMode: 'group',
    reward: 'Dinner, on us',
    penalty: 'Coffee for a week',
    per: {},
    friends: ['sam', 'kim'],
    agreed: {},
    off: {},
    settled: {},
    createdAt: CREATED,
    ended: null,
    ...x,
  }
}
const AGREED = { sam: at('2026-11-07T10:00'), kim: at('2026-11-08T22:00') }
const STAMPED = { agreedAt: AGREED.kim, start: W1 }
const running = (x: Partial<Deal> = {}) => deal({ agreed: AGREED, ...STAMPED, ...x })
const PER = { sam: { reward: 'Lunch', penalty: 'A coffee' }, kim: { reward: 'A movie', penalty: 'Flowers' } }
const pass = (id: string, score = 95): DealPeriod => ({ id, result: 'pass', score })
const miss = (id: string, score: number | null, x: Partial<DealPeriod> = {}): DealPeriod => ({ id, result: 'miss', score, ...x })

function input(nowMs: number, x: Partial<DealCardInput> & { open?: Deal[]; ended?: Deal[] } = {}): DealCardInput {
  const view: DealsView = { open: Object.fromEntries((x.open ?? []).map((d) => [d.uid, d])), ended: x.ended ?? [] }
  return {
    space: SP,
    me: 'lena',
    nowMs,
    deals: view,
    name,
    when: (ms) => dealWhen(ms, TZ, nowMs, TZ, 'h12'),
    judging: false,
    oldMonth: null,
    ...x,
  }
}
const card = (nowMs: number, x: Parameters<typeof input>[1] = {}) => dealCard(input(nowMs, x))
const stateAt = (d: Deal, nowMs: number, sp = SP, extra: DealPeriod[] = []) => dealState(d, sp, nowMs, dealClock(sp, d.unit), extra)
const ctx = (nowMs: number, me = 'lena') => ({ me, nowMs, tz: TZ, threshold: 90, name })

describe('the stakes card: your block', () => {
  const now = at('2026-11-06T12:00')

  it('asks for witnesses when you’re alone', () => {
    const b = card(now, { space: space({ memberIds: ['lena'] }) })
    expect(b.kind).toBe('alone')
    expect(b.text).toBe('Stakes need witnesses. Invite at least one friend.')
    expect(b.buttons.map((x) => x.label)).toEqual(['Invite'])
  })

  it('says a judge has nothing at stake', () => {
    const b = card(now, { judging: true })
    expect([b.title, b.text]).toEqual(['Nothing at stake', 'You’re judging, so nothing’s at stake. Turn off Only Rate Friends to make a deal.'])
    expect(b.buttons).toEqual([])
  })

  it('offers Make a Deal, and Same Again after a deal', () => {
    const b = card(now)
    expect([b.title, b.text]).toEqual(['Nothing at stake', 'Make a deal: what you get for hitting 90%, what you owe if you miss, and for how long.'])
    expect(b.buttons.map((x) => x.label)).toEqual(['Make a Deal'])
    const old = running({ ended: { outcome: 'won', at: now - 10 * D, period: W2 } })
    const again = card(now, { ended: [old] })
    expect(again.buttons.map((x) => x.label)).toEqual(['Make a Deal', 'Same Again'])
    expect(again.caption).toBe('Last time: 2 weeks · Dinner, on us')
    expect(card(now, { ended: [{ ...old, rewardMode: 'each', per: PER }] }).caption).toBe('Last time: 2 weeks · Different per friend')
  })

  it('shows "Nothing at stake" without buttons while deals load or fail', () => {
    const b = dealCard({ ...input(now), deals: undefined })
    expect([b.kind, b.title, b.buttons]).toEqual(['unavailable', 'Nothing at stake', []])
  })

  it('needs a friend who plays', () => {
    const b = card(now, { space: space({ judges: ['sam', 'kim'] }) })
    expect(b.text).toBe('Deals need a friend who plays. Invite one first.')
  })

  it('reads the October window, naming the months from the window’s own month', () => {
    const b = card(now, { oldMonth: '2026-10' })
    expect(b.title).toBe('Nothing at stake after October')
    expect(b.text).toBe('From November, stakes don’t renew on their own. Make a deal: what you get for hitting 90%, what you owe if you miss, and for how long.')
    // A late ship (dealsFrom '2026-12'): November is the window's month.
    const late = card(now, { oldMonth: '2026-11' })
    expect(late.title).toBe('Nothing at stake after November')
    expect(late.text.startsWith('From December, stakes don’t renew on their own. Make a deal')).toBe(true)
    expect(octoberHeader('2026-10')).toBe('October’s stakes')
    expect(octoberAlsoLine('2026-10')).toBe('October’s stakes count too, for October.')
    expect(octoberAlsoLine('2026-11')).toBe('November’s stakes count too, for November.')
  })

  it('waits for agreement, saying when it would start and until when', () => {
    const one = card(now, { open: [deal({ agreed: { sam: AGREED.sam } })] })
    expect([one.kind, one.title, one.text]).toEqual(['waiting', 'Your deal: waiting for Kim', '2 weeks at 90%+. Starts next week if Kim agrees by Sunday at midnight.'])
    expect(one.avatars).toEqual([
      { uid: 'sam', agreed: true },
      { uid: 'kim', agreed: false },
    ])
    expect(one.rows?.map((r) => [r.label, r.text])).toEqual([
      ['Make it, they owe you', 'Dinner, on us'],
      ['Miss one, you owe them', 'Coffee for a week'],
    ])
    const two = card(now, { open: [deal()] })
    expect([two.title, two.text]).toEqual(['Your deal: waiting for Sam and Kim', '2 weeks at 90%+. Starts next week if they agree by Sunday at midnight.'])
    const sp4 = space({ memberIds: ['lena', 'sam', 'kim', 'ana'] })
    const three = card(now, { space: sp4, open: [deal({ friends: ['sam', 'kim', 'ana'] })] })
    expect(three.title).toBe('Your deal: waiting for 3 friends')
  })

  it('waits on a months deal, with the date when it is weeks away', () => {
    const nov4 = at('2026-11-04T12:00')
    const b = card(nov4, { open: [deal({ unit: 'month', count: 3, createdAt: nov4 - H })] })
    expect(b.text).toBe('3 months at 90%+. Starts in December if they agree by Sunday, Nov 29 at midnight.')
  })

  it('groups per-friend texts in the rows', () => {
    const b = card(now, { open: [deal({ rewardMode: 'each', per: { sam: { reward: 'Lunch', penalty: '' }, kim: { reward: 'Lunch', penalty: '' } } })] })
    expect(b.rows?.[0].text).toBe('Lunch')
    const c = card(now, { open: [deal({ rewardMode: 'each', per: PER, penaltyMode: 'each' })] })
    expect(c.rows?.map((r) => r.text)).toEqual(['Sam: Lunch · Kim: A movie', 'Sam: A coffee · Kim: Flowers'])
  })

  it('says when nobody is left to agree', () => {
    const b = card(now, { space: space({ memberIds: ['lena', 'ben'] }), open: [deal()] })
    expect([b.title, b.text]).toEqual(['Your deal: nobody left to agree', 'Withdraw it and make a new one.'])
  })

  it('says when an agreed deal starts', () => {
    const sun = at('2026-11-08T23:30')
    const next = card(sun, { open: [running()] })
    expect([next.kind, next.title, next.text]).toEqual(['scheduled', 'Your deal starts next week', '2 weeks at 90%+ each. It counts from tomorrow at midnight.'])
    const mon = at('2026-11-09T10:00')
    const thisWeek = card(mon, { open: [running()] })
    expect([thisWeek.title, thisWeek.text]).toEqual(['Your deal starts this week', '2 weeks at 90%+ each. It counts from tonight at midnight.'])
    const later = card(at('2026-11-02T10:00'), { open: [running({ start: W2 })] })
    expect(later.title).toBe('Your deal starts the week of Nov 16')
    const months = card(at('2026-11-20T10:00'), { open: [running({ unit: 'month', count: 3, start: '2026-12' })] })
    expect([months.title, months.text]).toEqual(['Your deal starts in December', '3 months at 90%+ each. It counts from December’s first lists.'])
  })

  it('shows a running deal’s progress', () => {
    const first = card(at('2026-11-11T10:00'), { open: [running()] })
    expect([first.kind, first.title, first.text]).toEqual(['running', 'Your deal', 'Week 1 of 2 · every week needs 90%+'])
    expect(first.note).toBeNull()
    const second = card(at('2026-11-18T10:00'), { open: [running({ track: [pass(W1)] })] })
    expect(second.text).toBe('Week 2 of 2 · all 90%+ so far')
    const skip: DealPeriod = { id: W1, result: 'skip', score: null, why: 'paused' }
    expect(card(at('2026-11-25T10:00'), { open: [running({ track: [skip, pass(W2)] })] }).text).toBe('Week 2 of 2 · all 90%+ so far · 1 week added')
    expect(card(at('2026-11-25T10:00'), { open: [running({ track: [skip, { ...skip, id: W2, why: 'excused' }] })] }).text).toBe('Week 1 of 2 · every week needs 90%+ · 2 weeks added')
    const months = running({ unit: 'month', count: 3, start: '2026-12', track: [{ id: '2026-12', result: 'skip', score: null, why: 'no-score' }] })
    expect(card(at('2027-01-20T10:00'), { open: [months] }).text).toBe('Month 1 of 3 · every month needs 90%+ · 1 month added')
  })

  it('says a result is coming in, or running late', () => {
    const b = card(at('2026-11-14T10:00'), { open: [running()] })
    expect(b.note?.text).toBe('Results for the week of Nov 9 come in within a few hours.')
    expect(card(at('2026-11-15T01:00'), { open: [running()] }).note?.text).toBe('Deal results are running late. They’ll catch up.')
  })

  describe('a provisional end', () => {
    const t = at('2026-11-14T10:00')
    const note = (extra: DealPeriod[], d = running()) => dealNote(d, stateAt(d, t, SP, extra), { me: 'lena', threshold: 90, latePenalty: 5, name })?.text

    it('a miss', () => {
      expect(note([miss(W1, 84)])).toBe('The week of Nov 9 was 84%, under 90%. That ends your deal once it’s confirmed, within a few hours.')
      expect(note([miss(W1, 0, { why: 'empty' })])).toBe('The week of Nov 9 was 0%, under 90%. That ends your deal once it’s confirmed, within a few hours.')
    })

    it('a miss by missed reviews shows both numbers', () => {
      expect(note([miss(W1, 87, { missed: 1 })])).toBe(
        'The week of Nov 9 was 87% for your deal: 92%, minus 5 for a missed review. That’s under 90%, so it ends your deal once it’s confirmed, within a few hours.',
      )
      expect(note([miss(W1, 80, { missed: 2 })])).toBe(
        'The week of Nov 9 was 80% for your deal: 90%, minus 10 for 2 missed reviews. That’s under 90%, so it ends your deal once it’s confirmed, within a few hours.',
      )
    })

    it('a judged week', () => {
      expect(note([miss(W1, null, { why: 'judge' })])).toBe('You judged the week of Nov 9, so it counts as a miss. That ends your deal once it’s confirmed, within a few hours.')
    })

    it('drops "all 90%+ so far" beside a provisional miss', () => {
      const d = running({ track: [] })
      expect(runningLine(d, stateAt(d, t, SP, [miss(W1, 84)]), 90)).toBe('Week 1 of 2')
      expect(runningLine(d, stateAt(d, t, SP, [pass(W1)]), 90)).toBe('Week 2 of 2 · all 90%+ so far')
    })

    it('the last pass', () => {
      expect(note([pass(W1)], running({ count: 1 }))).toBe('That’s 1 week at 90%+. It’s confirmed within a few hours.')
    })

    it('reads a friend’s deal by name', () => {
      const d = running()
      expect(dealNote(d, stateAt(d, t, SP, [miss(W1, 84)]), { me: 'sam', threshold: 90, latePenalty: 5, name })?.text).toBe(
        'The week of Nov 9 was 84%, under 90%. That ends Lena’s deal once it’s confirmed, within a few hours.',
      )
    })
  })

  it('says who asked to call it off', () => {
    const t = at('2026-11-11T10:00')
    const mine = card(t, { open: [running({ off: { lena: t - H } })] })
    expect(mine.note).toEqual({ text: 'You asked to call it off. Waiting for Sam and Kim.' })
    const theirs = card(t, { open: [running({ off: { sam: t - H } })] })
    expect(theirs.note).toEqual({ text: 'Sam asked to call it off. It’s off once everyone taps Call Off.', action: 'take-a-look' })
  })

  describe('over', () => {
    const t = at('2026-11-23T10:00')
    const won = running({ track: [pass(W1), pass(W2)], ended: { outcome: 'won', at: at('2026-11-21T00:00'), period: W2 } })
    const lost = running({ track: [pass(W1), miss(W2, 84)], ended: { outcome: 'lost', at: at('2026-11-21T00:00'), period: W2, score: 84 } })
    const mark = { settled: true, by: 'lena', at: t }

    it('won', () => {
      const b = card(t, { ended: [won] })
      expect([b.kind, b.title, b.text]).toEqual(['won', 'You made it: 2 weeks at 90%+', 'Sam and Kim owe you: Dinner, on us'])
      expect(b.buttons.map((x) => x.label)).toEqual(['Same Again', 'New Deal'])
      expect(card(t, { ended: [{ ...won, rewardMode: 'each', per: PER }] }).text).toBe('Collect from Sam and Kim')
      expect(card(t, { ended: [{ ...won, settled: { sam: mark, kim: mark } }] }).text).toBe('All settled')
      expect(card(t, { ended: [{ ...won, settled: { sam: mark } }] }).text).toBe('Sam and Kim owe you: Dinner, on us')
    })

    it('stops showing it a week after it ended', () => {
      expect(card(at('2026-11-28T01:00'), { ended: [won] }).kind).toBe('none')
    })

    it('lost', () => {
      const b = card(t, { ended: [lost] })
      expect([b.kind, b.title, b.text]).toEqual(['lost', 'Your deal ended: 84% in the week of Nov 16', 'You owe Sam and Kim: Coffee for a week'])
      expect(card(t, { ended: [{ ...lost, penaltyMode: 'each', per: PER }] }).text).toBe('Pay up to Sam and Kim')
      const missed = { ...lost, track: [pass(W1), miss(W2, 87, { missed: 1 })], ended: { ...lost.ended!, score: 87 } }
      expect(card(t, { ended: [missed] }).title).toBe('Your deal ended: 87% in the week of Nov 16, after a missed review')
      const two = { ...lost, track: [pass(W1), miss(W2, 80, { missed: 2 })], ended: { ...lost.ended!, score: 80 } }
      expect(card(t, { ended: [two] }).title).toBe('Your deal ended: 80% in the week of Nov 16, after 2 missed reviews')
      const judged = { ...lost, track: [pass(W1), miss(W2, null, { why: 'judge' })], ended: { ...lost.ended!, score: null } }
      expect(card(t, { ended: [judged] }).title).toBe('Your deal ended: you judged the week of Nov 16')
      const left = { ...lost, track: [pass(W1), miss(W2, null, { why: 'left' })], ended: { ...lost.ended!, score: null, at: at('2026-11-17T00:00') } }
      expect(card(t, { ended: [left] }).title).toBe('Your deal ended: you left during it')
      const empty = { ...lost, track: [pass(W1), miss(W2, 0, { why: 'empty' })], ended: { ...lost.ended!, score: 0 } }
      expect(card(t, { ended: [empty] }).title).toBe('Your deal ended: 0% in the week of Nov 16')
    })

    it('off', () => {
      const called = running({ ended: { outcome: 'off', at: t - D, reason: 'called-off' } })
      const b = card(t, { ended: [called] })
      expect([b.kind, b.title, b.text]).toEqual(['off', 'Your deal is off', 'Everyone called it off, so nothing’s owed.'])
      expect(b.buttons.map((x) => x.label)).toEqual(['New Deal', 'Same Again'])
      expect(card(t, { ended: [{ ...called, ended: { outcome: 'off', at: t - D, reason: 'alone' } }] }).text).toBe('Everyone in it left, so nothing’s owed.')
    })

    it('a deal in play comes first', () => {
      const next = deal({ id: 'lena_2', seq: 2, createdAt: t - H })
      expect(card(t, { open: [next], ended: [won] }).kind).toBe('waiting')
    })
  })
})

describe('the stakes card: news', () => {
  const now = at('2026-11-06T12:00')
  const news = (nowMs: number, x: Parameters<typeof input>[1]) => dealNews(input(nowMs, { me: 'sam', ...x }))

  it('a friend’s deal waiting on your Agree comes first', () => {
    const kims = deal({ id: 'kim_1', uid: 'kim', friends: ['lena', 'sam'] })
    expect(news(now, { open: [deal()] })).toEqual({ kind: 'agree', text: 'New deal from Lena', uids: ['lena'], dealId: 'lena_1' })
    expect(news(now, { open: [deal(), kims] })?.text).toBe('New deal from Lena and Kim')
    // Once you agreed, it's not news.
    expect(news(now, { open: [deal({ agreed: { sam: now - H } })] })).toBeNull()
  })

  it('then a Call Off waiting on you', () => {
    const t = at('2026-11-11T10:00')
    expect(news(t, { open: [running({ off: { lena: t - H } })] })?.text).toBe('Lena wants to call off Lena’s deal')
    expect(news(t, { open: [running({ off: { kim: t - H } })] })?.text).toBe('Kim wants to call off Lena’s deal')
    expect(news(t, { open: [running({ off: { kim: t - H, sam: t - H } })] })).toBeNull()
  })

  it('then a friend’s deal you’re in that ended lately, until dismissed', () => {
    const t = at('2026-11-23T10:00')
    const won = running({ ended: { outcome: 'won', at: t - D, period: W2 } })
    expect(news(t, { ended: [won] })).toEqual({ kind: 'ended', text: 'Lena made it: you owe Dinner, on us', uid: 'lena', dealId: 'lena_1', seenKey: 'dealSeen.s1.lena_1' })
    expect(news(t, { ended: [won], seen: (k) => k === 'dealSeen.s1.lena_1' })).toBeNull()
    expect(news(t, { ended: [{ ...won, rewardMode: 'each', per: PER }] })?.text).toBe('Lena made it: you owe Lunch')
    const lost = running({ track: [pass(W1), miss(W2, 84)], ended: { outcome: 'lost', at: t - D, period: W2, score: 84 } })
    expect(news(t, { ended: [lost] })?.text).toBe('Lena’s deal ended: Lena owes you Coffee for a week')
    const left = running({ track: [pass(W1), miss(W2, null, { why: 'left' })], ended: { outcome: 'lost', at: t - D, period: W2, score: null } })
    expect(news(t, { space: space({ memberIds: ['sam', 'kim'], leftAt: { lena: at('2026-11-15T10:00') } }), ended: [left] })?.text).toBe(
      'Lena left, so Lena’s deal ended: Lena owes you Coffee for a week',
    )
    expect(news(t, { ended: [running({ ended: { outcome: 'off', at: t - D, reason: 'called-off' } })] })?.text).toBe('Lena’s deal is off')
    // Not a party (joined later): no news.
    expect(dealNews(input(t, { me: 'ana', space: space({ memberIds: ['lena', 'sam', 'kim', 'ana'] }), ended: [won] }))).toBeNull()
  })
})

describe('the Stakes screen', () => {
  it('words the sections’ footers', () => {
    expect(yourDealFooter(90)).toBe(
      'Pick what friends owe you if every week (or month) hits 90%, what you owe if one doesn’t, and for how long. It starts once everyone agrees.',
    )
    expect(leavingFooter('Film Club')).toBe('Leaving Film Club while your deal is on counts as a miss: you’d owe your penalty.')
    expect(octoberFooter('2026-10')).toBe('These count for October, as agreed by now. From November nothing renews on its own: make a deal.')
    expect(SETTLE_FOOTER).toBe(
      'Nothing is paid in the app. Settle up in real life, then whoever was owed marks it Settled. Deals that ended over 60 days ago are in Past Deals.',
    )
    expect(houseStakesFooter('Lena', false, null)).toBe('New deals start from these. Only Lena can change them.')
    expect(houseStakesFooter('Lena', true, null)).toBe('New deals start from these. Change them in Settings.')
    expect(houseStakesFooter('Lena', true, '2026-10')).toBe('October’s house stakes are set. They count for October, as agreed.')
  })

  it('reads each deal’s status in a line', () => {
    const now = at('2026-11-06T12:00')
    const d = deal({ agreed: { kim: now - H } })
    expect(statusLine(d, stateAt(d, now), ctx(now))).toBe('Waiting for Sam')
    expect(statusLine(deal(), stateAt(deal(), now), ctx(now, 'sam'))).toBe('Waiting for Kim and you')
    expect(statusLine(running(), stateAt(running(), now), ctx(now))).toBe('Starts next week')
    const t = at('2026-11-18T10:00')
    const r = running({ track: [pass(W1)] })
    expect(statusLine(r, stateAt(r, t), ctx(t))).toBe('Week 2 of 2 · all 90%+ so far')
  })

  it('shows a friend’s deal as it applies to you', () => {
    expect(friendDealRows(deal(), 'sam', 'Lena').map((r) => [r.label, r.text])).toEqual([
      ['Lena makes it, you owe', 'Dinner, on us, with everyone'],
      ['Lena misses one, you get', 'Coffee for a week, shared with everyone'],
    ])
    expect(friendDealRows(deal({ rewardMode: 'each', penaltyMode: 'each', per: PER }), 'sam', 'Lena').map((r) => r.text)).toEqual(['Lunch', 'A coffee'])
    expect(friendDealRows(deal({ friends: ['sam'] }), 'sam', 'Lena').map((r) => r.text)).toEqual(['Dinner, on us', 'Coffee for a week'])
    expect(atStakeLine(deal({ rewardMode: 'each', per: PER, penaltyMode: 'each' }), 'sam', 'Lena')).toBe('If Lena makes it, you owe: Lunch · If not, you get: A coffee')
  })

  it('words Waiting on You’s footers', () => {
    const now = at('2026-11-06T12:00')
    const last = deal({ agreed: { kim: now - H } })
    expect(waitingOnYouFooter(last, stateAt(last, now), 'sam', name, now, TZ)).toBe('Starts next week once you agree.')
    expect(waitingOnYouFooter(deal(), stateAt(deal(), now), 'sam', name, now, TZ)).toBe('Waiting for Kim and you.')
    const t = at('2026-11-11T10:00')
    const off = running({ off: { lena: t - H } })
    expect(waitingOnYouFooter(off, stateAt(off, t), 'sam', name, t, TZ)).toBe('Lena asked to call it off. It’s off once everyone taps Call Off.')
  })

  it('lists what’s left to settle, unsettled first, with who may mark it', () => {
    const t = at('2026-11-23T10:00')
    const won = running({ track: [pass(W1), pass(W2)], ended: { outcome: 'won', at: at('2026-11-21T00:00'), period: W2 } })
    const rows = settleRows(won, stateAt(won, t), { me: 'lena', memberIds: SP.memberIds, name })
    expect(rows.map((r) => [r.title, r.subtitle, r.canSettle])).toEqual([['Sam and Kim owe you: Dinner, on us', 'Your deal, 2 weeks · Together', true]])
    const sams = settleRows(won, stateAt(won, t), { me: 'sam', memberIds: SP.memberIds, name })
    expect(sams.map((r) => [r.title, r.subtitle, r.canSettle])).toEqual([['You and Kim owe Lena: Dinner, on us', 'Lena’s deal, 2 weeks · Together · Only Lena can mark this.', false]])
    const settled = { ...won, settled: { sam: { settled: true, by: 'lena', at: at('2026-11-30T10:00') }, kim: { settled: true, by: 'lena', at: at('2026-11-30T10:00') } } }
    expect(settleRows(settled, stateAt(settled, t), { me: 'sam', memberIds: SP.memberIds, name })[0].subtitle).toBe('Lena’s deal, 2 weeks · Together · Settled · marked by Lena, Nov 30')
    // Lost per friend: each friend's own line; Kim left, so Lena marks Kim's herself.
    const lost = running({ penaltyMode: 'each', per: PER, track: [miss(W1, 84)], ended: { outcome: 'lost', at: at('2026-11-14T00:00'), period: W1, score: 84 } })
    const sp = space({ memberIds: ['lena', 'sam'], leftAt: { kim: at('2026-11-20T10:00') } })
    const lines = settleRows(lost, stateAt(lost, t, sp), { me: 'lena', memberIds: sp.memberIds, name })
    expect(lines.map((r) => [r.title, r.subtitle, r.canSettle])).toEqual([
      ['You owe Sam: A coffee', 'Your deal, 2 weeks · Only Sam can mark this.', false],
      ['You owe Kim: Flowers', 'Your deal, 2 weeks · Kim has left, so you can mark this yourself.', true],
    ])
    expect(sortSettleRows([...rows.map((r) => ({ ...r, settled: true })), ...lines]).map((r) => r.settled)).toEqual([false, false, true])
  })

  it('words streak rewards', () => {
    expect(streakFooter(90, 3)).toBe(
      'Hit 90% this many months in a row and your friends owe you this too, together, deal or not. A month you sit out doesn’t break a streak. Your streak: 3 months in a row.',
    )
    expect(streakFooter(90, 1)).not.toContain('Your streak')
    expect(streakMissingText('Lena')).toBe('Lena hasn’t set streak rewards with you yet. They count for you once Lena saves them again.')
    expect(streakAgreeConfirm('Lena', [{ months: 3, reward: 'Weekend away' }])).toEqual({
      title: 'Agree to Lena’s streak rewards?',
      lines: ['3 months in a row: you all owe “Weekend away”, together.'],
    })
    expect(streakSaveMessage([])).toBe('Counts now.')
    expect(streakSaveMessage(['Sam'])).toBe('Counts as soon as Sam agrees.')
    expect(streakSaveMessage(['Sam', 'Kim'])).toBe('Counts as soon as Sam and Kim agree.')
    const tiers = [{ months: 3, reward: 'Weekend away' }]
    const pair = { rewardMode: 'group' as const, penaltyMode: 'group' as const, reward: 'x', penalty: 'y' }
    const own = { tiers, agreed: { sam: { terms: { ...pair, tiers } }, kim: { terms: { ...pair, tiers: [] } } } }
    expect([streakStatus(own, 'sam'), streakStatus(own, 'kim'), streakStatus(own, 'ana')]).toEqual(['Agreed', 'Waiting', 'Waiting'])
    expect(streakWaiting(own, tiers, ['sam', 'kim'])).toEqual(['kim'])
    expect(streakWaiting(own, [], ['sam', 'kim'])).toEqual(['sam'])
    expect(streaksWaitOnMe(own, 'sam')).toBe(false)
    expect(streaksWaitOnMe(own, 'kim')).toBe(true)
    expect(streaksWaitOnMe(undefined, 'kim')).toBe(false)
  })
})

describe('a deal’s screen', () => {
  const own = () => null

  it('reads each period', () => {
    expect(periodDetail('week', pass(W1, 93), null)).toBe('93%')
    expect(periodDetail('week', miss(W1, 84), null)).toBe('84%')
    expect(periodDetail('week', { id: W1, result: 'skip', score: null, why: 'paused' }, null)).toBe('Paused · a week added')
    expect(periodDetail('week', { id: W1, result: 'skip', score: null, why: 'excused' }, null)).toBe('Skipped · a week added')
    expect(periodDetail('week', { id: W1, result: 'skip', score: null, why: 'missing' }, null)).toBe('Nobody played · a week added')
    expect(periodDetail('month', { id: '2026-12', result: 'skip', score: null, why: 'no-score' }, null)).toBe('No score · a month added')
    expect(periodDetail('week', miss(W1, null, { why: 'judge' }), null)).toBe('Judge · counts as a miss')
    expect(periodDetail('week', miss(W1, null, { why: 'left' }), null)).toBe('Left · counts as a miss')
    expect(periodDetail('week', miss(W1, 0, { why: 'empty' }), null)).toBe('Nothing planned · 0%')
    expect(periodDetail('week', miss(W1, 87, { missed: 1 }), 92)).toBe('87% · 92%, 1 missed review')
    expect(periodDetail('week', pass(W1, 90.5), null)).toBe('90%')
  })

  it('lists the periods: done, in progress or checking, then the rest', () => {
    const d = running({ count: 4, track: [pass(W1, 93)] })
    const t = at('2026-11-18T10:00')
    expect(periodRows(d, stateAt(d, t), own).map((r) => [r.title, r.detail, r.glyph, r.state])).toEqual([
      ['Week of Nov 9', '93%', 'pass', 'done'],
      ['Week of Nov 16', 'In progress', null, 'current'],
      ['Week of Nov 23', '', null, 'upcoming'],
      ['Week of Nov 30', '', null, 'upcoming'],
    ])
    const checking = at('2026-11-21T10:00')
    expect(periodRows(d, stateAt(d, checking), own)[1].detail).toBe('Checking…')
    expect(periodRows(deal(), stateAt(deal(), t), own)).toEqual([])
    const m = running({ unit: 'month', count: 2, start: '2026-12', track: [pass('2026-12', 94)] })
    expect(periodRows(m, stateAt(m, at('2027-01-15T10:00')), own).map((r) => [r.title, r.detail])).toEqual([
      ['December', '94%'],
      ['January', 'In progress'],
    ])
  })

  it('says how each friend stands while it waits', () => {
    const d = deal({ agreed: { sam: 1 } })
    expect(['sam', 'kim', 'ana'].map((f) => friendAgreement(d, f, ['lena', 'sam', 'kim']))).toEqual(['Agreed', 'Waiting', 'Left'])
  })

  it('words the footers by state', () => {
    const now = at('2026-11-06T12:00')
    const base = { ...ctx(now), latePenalty: 5, when: (ms: number) => dealWhen(ms, TZ, now, TZ, 'h12'), clock: dealClock(SP, 'week'), canSameAgain: false }
    expect(dealFooter(deal(), stateAt(deal(), now), base)).toBe('Starts next week if Sam and Kim agree by Sunday at midnight. Friends see it on their stakes card.')
    const one = deal({ agreed: { sam: now - H } })
    expect(dealFooter(one, stateAt(one, now), base)).toBe('Starts next week if Kim agrees by Sunday at midnight. Friends see it on their stakes card.')
    const sched = running()
    expect(dealFooter(sched, stateAt(sched, now), base)).toBe(
      'Starts next week. Every week needs 90%; the first one under ends it and you owe your penalty. Leaving the space counts as a miss too.',
    )
    const t = at('2026-11-11T10:00')
    expect(dealFooter(running(), stateAt(running(), t), { ...base, nowMs: t })).toBe(
      'Every week needs 90%, minus 5 for each friend you don’t review that week. A paused or skipped week adds one more; a week you judge or aren’t in counts as a miss.',
    )
    const m = running({ unit: 'month', start: '2026-11' })
    expect(dealFooter(m, stateAt(m, t), { ...base, nowMs: t })).toBe(
      'Every month needs 90%. A month with no score, like one that was all paused, adds one more. A month you only judge, or leave during, counts as a miss.',
    )
    const ended = running({ ended: { outcome: 'off', at: at('2026-11-12T10:00'), reason: 'called-off' } })
    expect(dealFooter(ended, stateAt(ended, t), { ...base, canSameAgain: true })).toBe('Ended Nov 12. Same Again proposes it with today’s friends.')
    expect(dealFooter(ended, stateAt(ended, t), base)).toBe('Ended Nov 12.')
  })
})

describe('the editor', () => {
  it('says what counts and when it would start', () => {
    const now = at('2026-11-06T12:00')
    expect(editorLengthFooter('week', 90, W1, 'Sunday at midnight', now, TZ)).toBe(
      'Every week has to reach 90%. Your first week under ends the deal. It starts next week if everyone agrees by Sunday at midnight.',
    )
    expect(editorLengthFooter('month', 90, '2026-12', 'Sunday, Nov 29 at midnight', now, TZ)).toBe(
      'Every month has to reach 90%. Your first month under ends the deal. It starts in December if everyone agrees by Sunday, Nov 29 at midnight: a deal starts with the first lists that lock at least a day after everyone agreed.',
    )
    expect(EDITOR_FOOTER).toBe('Friends have to tap Agree. Nothing’s at stake until they all do.')
    expect(missingTextsLine(['kim'], true, false, name)).toBe('Add what Kim owes you.')
    expect(missingTextsLine(['kim'], false, true, name)).toBe('Add what you owe Kim.')
    expect(missingTextsLine([], true, true, name)).toBeNull()
  })

  it('toasts a proposal', () => {
    expect(proposedToast(['sam', 'kim'], name, false)).toEqual({ title: 'Deal proposed', message: 'Waiting for Sam and Kim to agree.' })
    expect(proposedToast(['sam', 'kim'], name, true)).toEqual({ title: 'Deal updated', message: 'Friends have to agree again.' })
  })
})

describe('confirms', () => {
  it('Same Again', () => {
    expect(sameAgainConfirm({ unit: 'week', count: 4, rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner, on them', penalty: 'Coffee for a week' }, 90)).toEqual({
      title: 'Same deal again?',
      message: '4 weeks at 90%+ each. Make it: Dinner, on them. Miss one: Coffee for a week. Friends have to agree again.',
    })
    expect(sameAgainConfirm({ unit: 'month', count: 1, rewardMode: 'each', penaltyMode: 'group', reward: '', penalty: 'Coffee' }, 90).message).toBe(
      '1 month at 90%+ each. Make it: what each friend owed you last time. Miss one: Coffee. Friends have to agree again.',
    )
  })

  it('Agree', () => {
    const now = at('2026-11-06T12:00')
    const clock = dealClock(SP, 'week')
    const d = deal()
    const first = agreeDealConfirm(d, stateAt(d, now), 'sam', name, 90, now, TZ, clock)
    expect(first.title).toBe('Agree to Lena’s deal?')
    expect(first.lines).toEqual([
      '2 weeks, each at 90%+.',
      'If Lena makes it: you all owe “Dinner, on us”, together.',
      'If Lena misses one: the group gets “Coffee for a week”.',
      'It starts next week once Kim agrees too.',
    ])
    expect(first.toast).toEqual({ title: 'You agreed to Lena’s deal', message: 'It starts once Kim agrees too.' })
    const last = deal({ rewardMode: 'each', penaltyMode: 'each', per: PER, agreed: { kim: now - H } })
    const done = agreeDealConfirm(last, stateAt(last, now), 'sam', name, 90, now, TZ, clock)
    expect(done.lines).toEqual(['2 weeks, each at 90%+.', 'If Lena makes it: you owe “Lunch”.', 'If Lena misses one: you get “A coffee”.', 'It starts next week.'])
    expect(done.toast).toEqual({ title: 'You agreed to Lena’s deal', message: 'It starts next week.' })
  })

  it('Withdraw', () => {
    expect(WITHDRAW_CONFIRM).toEqual({
      title: 'Withdraw your deal?',
      message: 'Friends won’t be asked anymore, and nothing’s at stake until you make a new one.',
      confirmLabel: 'Withdraw',
      cancelLabel: 'Keep It',
    })
  })

  it('Call Off', () => {
    const t = at('2026-11-11T10:00')
    const d = running()
    expect(callOffConfirm(d, stateAt(d, t), 'lena', name)).toEqual({
      title: 'Call off your deal?',
      message: 'It ends only if Sam and Kim call it off too. Then nothing’s owed. You can’t take this back.',
      toast: { title: 'Asked to call it off', message: 'It’s off once Sam and Kim agree.' },
    })
    const one = running({ off: { kim: t - H } })
    expect(callOffConfirm(one, stateAt(one, t), 'lena', name).message).toBe('It ends only if Sam calls it off too. Then nothing’s owed. You can’t take this back.')
    expect(callOffConfirm(one, stateAt(one, t), 'lena', name).toast).toEqual({ title: 'Asked to call it off', message: 'It’s off once Sam agrees.' })
    const last = running({ off: { lena: t - H, kim: t - H } })
    expect(callOffConfirm(last, stateAt(last, t), 'sam', name)).toEqual({
      title: 'Call off Lena’s deal?',
      message: 'It ends only if everyone in it calls it off. Then nothing’s owed.',
      toast: { title: 'Deal called off', message: 'It’s confirmed within a few hours.' },
    })
  })
})

describe('Settings: what leaving, removing and judging do to a deal', () => {
  const t = at('2026-11-11T10:00')
  it('leaving', () => {
    expect(leaveDealLine(running(), stateAt(running(), t), name)).toBe('Your deal is on. Leaving counts as a miss: you’d owe Sam and Kim your penalty.')
    expect(leaveDealLine(deal(), stateAt(deal(), t), name)).toBe('Your deal waiting for agreement is withdrawn.')
    expect(leaveDealLine(undefined, null, name)).toBeNull()
  })
  it('removing', () => {
    expect(removeDealLine(running(), stateAt(running(), t), name)).toBe('Lena’s deal is on. Removing Lena counts as a miss for it, so Lena would owe the penalty.')
    expect(removeDealLine(deal(), stateAt(deal(), t), name)).toBeNull()
  })
  it('judging', () => {
    expect(judgeDealLine(running(), stateAt(running(), t))).toBe('Your deal is running: weeks you judge count as a miss.')
    const m = running({ unit: 'month', start: '2026-11' })
    expect(judgeDealLine(m, stateAt(m, t))).toBe('Your deal is running: a month you only judge counts as a miss.')
    expect(judgeDealLine(deal(), stateAt(deal(), t))).toBeNull()
  })
})

describe('Past Deals', () => {
  const t = at('2026-12-20T10:00')
  it('reads each deal', () => {
    const won = running({ count: 3, track: [pass(W1), pass(W2), pass('2026-11-23')], ended: { outcome: 'won', at: at('2026-11-28T00:00'), period: '2026-11-23' } })
    expect(historyRow(won, stateAt(won, t), 90, TZ)).toEqual({ title: '3 weeks · Made it', subtitle: 'Nov 9 – Nov 28 · Dinner, on us' })
    const lost = running({ unit: 'month', count: 3, start: '2026-11', track: [pass('2026-11'), miss('2026-12', 84)], ended: { outcome: 'lost', at: t, period: '2026-12', score: 84 } })
    expect(historyRow(lost, stateAt(lost, t), 90, TZ)).toEqual({ title: '3 months · Ended in month 2', subtitle: '84% in December · Coffee for a week' })
    const judged = { ...lost, track: [pass('2026-11'), miss('2026-12', null, { why: 'judge' })] }
    expect(historyRow(judged, stateAt(judged, t), 90, TZ).subtitle).toBe('Judged December · Coffee for a week')
    const left = { ...lost, track: [pass('2026-11'), miss('2026-12', null, { why: 'left' })] }
    expect(historyRow(left, stateAt(left, t), 90, TZ).subtitle).toBe('Left the space · Coffee for a week')
    expect(historyRow(running({ ended: { outcome: 'off', at: at('2026-11-12T10:00'), reason: 'called-off' } }), stateAt(running(), t), 90, TZ).title).toBe('2 weeks · Called off')
    expect(historyRow(running({ ended: { outcome: 'off', at: at('2026-11-12T10:00'), reason: 'alone' } }), stateAt(running(), t), 90, TZ)).toEqual({
      title: '2 weeks · Off',
      subtitle: 'Everyone else left',
    })
    const r = running({ count: 4, track: [pass(W1)] })
    const now = at('2026-11-18T10:00')
    expect(historyRow(r, stateAt(r, now), 90, TZ)).toEqual({ title: '4 weeks · Week 2 of 4', subtitle: 'All 90%+ so far' })
    expect(historyRow(deal(), stateAt(deal(), now), 90, TZ).title).toBe('2 weeks · Waiting for agreement')
  })
})

describe('months from the cutover', () => {
  const result = (over: Partial<MemberMonthResult> = {}): MemberMonthResult => ({
    uid: 'lena',
    monthId: '2026-11',
    former: false,
    others: ['sam'],
    weeks: [],
    average: 95,
    missedReviews: 0,
    penaltyPoints: 0,
    finalScore: 95,
    complete: true,
    passed: true,
    ...over,
  })

  it('the Spaces card says how the month went', () => {
    expect(verdictStatus('2026-11', result(), 'lena', name, DEALS_FROM_MONTH)).toBe('November: cleared the bar')
    expect(verdictStatus('2026-11', result({ finalScore: 86, passed: false }), 'lena', name, DEALS_FROM_MONTH)).toBe('November: missed by 4 points')
    expect(verdictStatus('2026-11', result({ finalScore: 89.5, passed: false }), 'lena', name, DEALS_FROM_MONTH)).toBe('November: missed by 1 point')
    expect(verdictStatus('2026-11', result({ finalScore: null, passed: null }), 'lena', name, DEALS_FROM_MONTH)).toBeNull()
    // A late ship: November keeps its stakes, December has none.
    expect(verdictStatus('2026-11', result(), 'lena', name, '2026-12')).toBe('November: Sam owes you')
    expect(verdictStatus('2026-12', result({ monthId: '2026-12' }), 'lena', name, '2026-12')).toBe('December: cleared the bar')
    expect(verdictStatus('2026-10', result({ monthId: '2026-10' }), 'lena', name, DEALS_FROM_MONTH)).toBe('October: Sam owes you')
  })

  it('the month view has no verdict line, and a footnote', () => {
    const stakes = { reward: 'Dinner', penalty: 'Coffee' }
    expect(verdictText(result(), 'lena', name, stakes, DEALS_FROM_MONTH)).toBeNull()
    expect(verdictText(result({ others: [] }), 'lena', name, stakes, DEALS_FROM_MONTH)).toBeNull()
    expect(verdictText(result(), 'lena', name, stakes, '2026-12')).toBe('Sam owes you: Dinner')
    expect(verdictText(result({ monthId: '2026-10' }), 'lena', name, stakes, DEALS_FROM_MONTH)).toBe('Sam owes you: Dinner')
    expect(DEALS_FOOTNOTE).toBe('Deals are settled on the Stakes screen.')
  })
})

describe('dealWhen', () => {
  it('reads like deadlineText, naming the date when it is far away', () => {
    const now = at('2026-11-06T12:00')
    expect(dealWhen(at('2026-11-09T00:00'), TZ, now, TZ, 'h12')).toBe('Sunday at midnight')
    expect(dealWhen(at('2026-11-16T00:00'), TZ, now, TZ, 'h12')).toBe('next Sunday at midnight')
    expect(dealWhen(at('2026-11-30T00:00'), TZ, at('2026-11-04T12:00'), TZ, 'h12')).toBe('Sunday, Nov 29 at midnight')
  })
})
