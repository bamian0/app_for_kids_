// Deals end to end (SPEC §12.10), in iPhone-sized browsers against the emulators with the real rules: proposing and
// agreeing (and the day's notice before a start), a running deal with its provisional end and the reminders job
// confirming it, winning and settling per pair, Same Again, losing per friend with a friend who left, Edit and
// Withdraw, Call Off by everyone, a months deal, judges, the October window, streak rewards, Help, and what leaving
// and removing say about a deal that's on.
//
// Time. `?now=` moves only the phone's clock; the emulator stamps every write with the real time: a proposal's
// createdAt, an Agree, a Call Off tap, a Settled mark. Nothing here depends on the real date: wherever a start or an
// end depends on those times, the test seeds them with admin (the friends' Agrees, the job's agreedAt and start,
// track and ended), and the phones' `?now=` is a fixed moment in November 2026 (October 2026 for the window).
//
// Run alone:
//   npx firebase emulators:exec --only auth,firestore --project demo-stakes "npx playwright test deals"
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { DateTime } from 'luxon'
import { runReminders } from '../../scripts/reminders.ts'
import { utcOffsetMinutes, weekBounds, weekIdsInMonth } from '../../src/domain/time.ts'
import { dealDoc, readDeal, setDeal, setDealsFrom, type SeedDeal } from './deals-seed.ts'
import { createAccount, db, endMonthAt, pairOf, resetEmulators, setPlayedWeek, setSpace, setStakes, spaceDoc, ts, type SeedStakes, type SeedTask } from './emulator.ts'
import { centerOn, phone, sheet, shown, snap } from './helpers.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const TZ = 'Europe/Rome'

type Who = { name: string; email: string; password: string }
const person = (name: string, email: string): Who => ({ name, email, password: 'secret123' })
const LENA = person('Lena Fischer', 'lena@example.com')
const SAM = person('Sam Okafor', 'sam@example.com')
const KIM = person('Kim Park', 'kim@example.com')
const COLORS: Record<string, string> = { Lena: '#AF52DE', Sam: '#34C759', Kim: '#FF2D55' }

const SPACE_ID = 'film-club'
const SPACE = { name: 'Film Club', reward: 'Dinner, on us', penalty: 'Coffee for a week' }
const CODE = 'FCLB2345'

const LENA_TASKS: SeedTask[] = [
  { id: 'l1', title: 'Finish the Lavazza edit' },
  { id: 'l2', title: 'Two gym sessions' },
]
const SAM_TASKS: SeedTask[] = [
  { id: 's1', title: 'Mix the podcast pilot' },
  { id: 's2', title: 'Call the venue' },
]
const KIM_TASKS: SeedTask[] = [
  { id: 'k1', title: 'Storyboard the music video' },
  { id: 'k2', title: 'Return the lights' },
]

// ---------- Time ----------

/** A wall-clock time in Rome (the phones' and the space's zone). */
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis()
const iso = (ms: number) => new Date(ms).toISOString()
const W1 = '2026-11-09'
const W2 = '2026-11-16'
const deadline = (weekId: string) => weekBounds(weekId, TZ).deadlineAt
const CREATED = at('2026-11-04T09:00')

// ---------- Seeding ----------

interface People {
  lena: string
  sam: string
  kim: string
}

/** A fresh project: Lena, Sam and Kim, and their space (the first member owns it), created in September. */
async function setup(opts: { owner?: 'lena' | 'sam'; judges?: Array<keyof People> } = {}): Promise<People> {
  await resetEmulators()
  const t = at('2026-09-01T10:00')
  const uids = [] as string[]
  for (const who of [LENA, SAM, KIM]) uids.push(await createAccount(who, COLORS[who.name.split(' ')[0]], t))
  const p: People = { lena: uids[0], sam: uids[1], kim: uids[2] }
  const members = opts.owner === 'sam' ? [p.sam, p.lena, p.kim] : [p.lena, p.sam, p.kim]
  await setSpace(SPACE_ID, {
    ...SPACE,
    members,
    timezone: TZ,
    utcOffsetMin: utcOffsetMinutes(TZ, at('2026-11-04T09:00')),
    inviteCode: CODE,
    at: t,
    ...(opts.judges ? { judges: opts.judges.map((k) => p[k]) } : {}),
  })
  return p
}

/** Lena's deal with Sam and Kim, Same for Everyone, 2 weeks, as proposed on Nov 4. */
function lenaDeal(p: People, x: Partial<SeedDeal> = {}): SeedDeal {
  return { uid: p.lena, seq: 1, unit: 'week', count: 2, reward: SPACE.reward, penalty: SPACE.penalty, friends: [p.sam, p.kim], createdAt: CREATED, ...x }
}

/** Everyone agreed by Sunday Nov 8, and the job stamped it: it starts with the week of Nov 9. */
const agreedBy = (p: People) => ({ agreed: { [p.sam]: at('2026-11-05T10:00'), [p.kim]: at('2026-11-08T20:00') }, agreedAt: at('2026-11-08T20:00'), start: W1 })

// ---------- Browser ----------

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })
const toast = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text }).first()
const card = (page: Page) => page.locator('.sk-card').filter({ visible: true }).first()
const alertBox = (page: Page) => page.getByRole('alertdialog')
const visibleButton = (scope: Page | Locator, name: string | RegExp) => scope.getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true }).first()

async function signIn(page: Page, who: Who, nowMs: number): Promise<void> {
  await page.goto(`/?now=${iso(nowMs)}`)
  await page.getByRole('button', { name: 'I Have an Account' }).click()
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await expect(tab(page, 'Spaces')).toHaveAttribute('aria-selected', 'true')
}

/** Reopens the app with the phone's clock at `nowMs`, on the space. */
async function travel(page: Page, nowMs: number): Promise<void> {
  await page.goto(`/?now=${iso(nowMs)}`)
  await expect(tab(page, 'Spaces')).toHaveAttribute('aria-selected', 'true')
  await openSpace(page)
}

async function openSpace(page: Page): Promise<void> {
  await page.getByRole('button', { name: new RegExp(SPACE.name) }).first().click()
  await expect(page.getByRole('heading', { name: SPACE.name })).toBeVisible()
  await expect(card(page)).toBeVisible()
}

async function start(browser: Browser, who: Who, nowMs: number) {
  const ph = await phone(browser)
  await signIn(ph.page, who, nowMs)
  await openSpace(ph.page)
  return ph
}

/** The card's block (title and line). */
const block = (page: Page) => card(page).locator('.dl-head').first()

async function expectBlock(page: Page, title: string, text?: string): Promise<void> {
  await expect(block(page).locator('.dl-title')).toHaveText(title)
  if (text !== undefined) await expect(block(page).locator('.dl-text')).toHaveText(text)
}

async function openStakes(page: Page): Promise<void> {
  await card(page).locator('.dl-main').click()
  await expect(page.getByRole('heading', { name: 'Stakes', exact: true })).toBeVisible()
}

async function back(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Back/ }).filter({ visible: true }).first().click()
}

/** Answers the alert on screen with `button`, after checking it says `includes`. */
async function answer(page: Page, button: string, includes: string[] = []): Promise<void> {
  const box = alertBox(page)
  await expect(box).toBeVisible()
  for (const text of includes) await expect(box).toContainText(text)
  await box.getByRole('button', { name: button, exact: true }).click()
  await expect(box).toHaveCount(0)
}

async function closeAll(...phones: { context: { close: () => Promise<void> }; errors: string[] }[]): Promise<void> {
  for (const p of phones) expect(p.errors).toEqual([])
  for (const p of phones) await p.context.close()
}

// =====================================================================================================

test('propose a deal, friends agree, and it starts with the first lists a day after the last Agree', async ({ browser }) => {
  const p = await setup()
  const now = at('2026-11-04T12:00')
  const a = await start(browser, LENA, now)
  const lena = a.page

  await test.step('Nothing at stake: Make a Deal opens the editor, prefilled with the house stakes', async () => {
    await expectBlock(lena, 'Nothing at stake', 'Make a deal: what you get for hitting 90%, what you owe if you miss, and for how long.')
    await snap(lena, 'deals-01-card-nothing')
    await visibleButton(card(lena), 'Make a Deal').click()
    const editor = sheet(lena)
    await expect(editor.getByRole('heading', { name: 'New Deal' })).toBeVisible()
    await expect(editor.getByLabel('What they owe you')).toHaveValue(SPACE.reward)
    await expect(editor.getByLabel('Length')).toHaveValue('4')
    await expect(shown(editor, 'Every week has to reach 90%. Your first week under ends the deal. It starts next week if everyone agrees by Sunday at midnight.')).toBeVisible()
    await snap(lena, 'deals-02-editor')
    await editor.getByLabel('Length').selectOption('2')
    await editor.getByRole('radiogroup', { name: 'Penalty' }).getByRole('radio', { name: 'Different per Friend' }).click()
    // Switching prefills each friend's field from the shared text.
    await expect(editor.getByLabel('You owe Sam…')).toHaveValue(SPACE.penalty)
    await editor.getByLabel('You owe Sam…').fill('A coffee')
    await editor.getByLabel('You owe Kim…').fill('')
    await expect(shown(editor, 'Fill in what you owe each friend, or make it the same for everyone.')).toBeVisible()
    await expect(editor.getByRole('button', { name: 'Propose' })).toBeDisabled()
    await editor.getByLabel('You owe Kim…').fill('Flowers')
    await centerOn(editor.getByLabel('You owe Kim…'))
    await snap(lena, 'deals-03-editor-per-friend')
    await editor.getByRole('button', { name: 'Propose' }).click()
    await expect(toast(lena, 'Deal proposed')).toContainText('Waiting for Sam and Kim to agree.')
  })

  await test.step('Waiting: who it waits for, and until when they can agree for it to start next week', async () => {
    await expectBlock(lena, 'Your deal: waiting for Sam and Kim', '2 weeks at 90%+. Starts next week if they agree by Sunday at midnight.')
    await expect(shown(card(lena), 'Sam: A coffee · Kim: Flowers')).toBeVisible()
    await snap(lena, 'deals-04-card-waiting')
    const doc = await readDeal(SPACE_ID, `${p.lena}_1`)
    expect(doc).toMatchObject({
      uid: p.lena,
      seq: 1,
      unit: 'week',
      count: 2,
      rewardMode: 'group',
      penaltyMode: 'each',
      reward: SPACE.reward,
      // The shared text is kept while the line is per friend (SPEC §12.4), for switching back.
      penalty: SPACE.penalty,
      per: { [p.sam]: { reward: '', penalty: 'A coffee' }, [p.kim]: { reward: '', penalty: 'Flowers' } },
      friends: [p.sam, p.kim],
      agreed: {},
      off: {},
      settled: {},
      ended: null,
    })
    expect((await spaceDoc(SPACE_ID).get()).get('hasDeals')).toBe(true)
  })

  const b = await start(browser, SAM, now)
  const sam = b.page
  await test.step('Sam sees the new deal, takes a look and agrees', async () => {
    await expect(shown(card(sam), 'New deal from Lena')).toBeVisible()
    await snap(sam, 'deals-05-card-news')
    await shown(card(sam), 'New deal from Lena').click()
    await expect(sam.getByRole('heading', { name: 'Stakes', exact: true })).toBeVisible()
    await expect(shown(sam, 'Waiting on You')).toBeVisible()
    await expect(shown(sam, 'Waiting for Kim and you.')).toBeVisible()
    await snap(sam, 'deals-06-stakes-waiting-on-you')
    await visibleButton(sam, 'Agree to Lena’s Deal').click()
    await answer(sam, 'Agree', [
      'Agree to Lena’s deal?',
      '2 weeks, each at 90%+.',
      'If Lena makes it: you all owe “Dinner, on us”, together.',
      'If Lena misses one: you get “A coffee”.',
      'It starts next week once Kim agrees too.',
    ])
    await expect(toast(sam, 'You agreed to Lena’s deal')).toContainText('It starts once Kim agrees too.')
    await expectBlock(lena, 'Your deal: waiting for Kim', '2 weeks at 90%+. Starts next week if Kim agrees by Sunday at midnight.')
    expect(Object.keys(((await readDeal(SPACE_ID, `${p.lena}_1`)) ?? {}).agreed as object)).toEqual([p.sam])
  })

  await test.step('Kim agrees on Sunday night: it starts this week', async () => {
    // The Agrees' times decide the start: seeded, not the real time of a browser tap.
    await dealDoc(SPACE_ID, `${p.lena}_1`).update({ [`agreed.${p.sam}`]: ts(at('2026-11-05T10:00')), [`agreed.${p.kim}`]: ts(at('2026-11-08T23:00')) })
    await travel(lena, at('2026-11-09T10:00'))
    await expectBlock(lena, 'Your deal starts this week', '2 weeks at 90%+ each. It counts from tonight at midnight.')
    await snap(lena, 'deals-07-card-scheduled')
  })

  await test.step('Kim agrees on Monday morning instead: a day’s notice moves it to next week', async () => {
    await dealDoc(SPACE_ID, `${p.lena}_1`).update({ [`agreed.${p.kim}`]: ts(at('2026-11-09T10:00')) })
    await travel(lena, at('2026-11-09T10:00'))
    await expect(block(lena).locator('.dl-title')).toHaveText('Your deal starts next week')
  })

  await closeAll(a, b)
})

test('a running deal: its weeks, a provisional miss, and the job ending it', async ({ browser }) => {
  const p = await setup()
  await setDeal(SPACE_ID, lenaDeal(p, { ...agreedBy(p), track: [{ id: W1, result: 'pass', score: 95 }] }))
  const a = await start(browser, LENA, at('2026-11-18T10:00'))
  const lena = a.page

  await test.step('Week 2 of 2, all 90%+ so far, and the deal’s own screen', async () => {
    await expectBlock(lena, 'Your deal', 'Week 2 of 2 · all 90%+ so far')
    await snap(lena, 'deals-08-card-running')
    await openStakes(lena)
    await expect(shown(lena, 'Leaving Film Club while your deal is on counts as a miss: you’d owe your penalty.')).toBeVisible()
    await snap(lena, 'deals-09-stakes-screen')
    await visibleButton(lena, /^2 weeks at 90%\+/).click()
    await expect(lena.getByRole('heading', { name: 'Your Deal' })).toBeVisible()
    await expect(shown(lena, 'Week of Nov 9')).toBeVisible()
    await expect(shown(lena, '95%', true)).toBeVisible()
    await expect(shown(lena, 'In progress')).toBeVisible()
    await expect(shown(lena, 'Every week needs 90%, minus 5 for each friend you don’t review that week.')).toBeVisible()
    await snap(lena, 'deals-10-deal-screen')
  })

  await test.step('The week closes at 50%: a provisional miss until the job confirms it', async () => {
    await setPlayedWeek(SPACE_ID, W2, weekBounds(W2, TZ), { [p.lena]: LENA_TASKS, [p.sam]: SAM_TASKS, [p.kim]: KIM_TASKS }, { marks: { [p.lena]: 0.5 } })
    await travel(lena, at('2026-11-21T10:00'))
    await expectBlock(lena, 'Your deal', 'Week 2 of 2')
    await expect(shown(card(lena), 'The week of Nov 16 was 50%, under 90%. That ends your deal once it’s confirmed, within a few hours.')).toBeVisible()
    await snap(lena, 'deals-11-card-provisional-miss')
    // No New Deal until the job has confirmed the end.
    await expect(card(lena).getByRole('button', { name: 'New Deal' })).toHaveCount(0)
  })

  await test.step('The reminders job confirms it: lost, and a new deal can be made', async () => {
    const summary = await runReminders({ db, send: async () => undefined, nowMs: at('2026-11-21T10:00'), log: () => {} })
    expect(summary.dealsEnded).toBe(1)
    const doc = await readDeal(SPACE_ID, `${p.lena}_1`)
    expect(doc?.ended).toMatchObject({ outcome: 'lost', period: W2, score: 50 })
    await expectBlock(lena, 'Your deal ended: 50% in the week of Nov 16', 'You owe Sam and Kim: Coffee for a week')
    await snap(lena, 'deals-12-card-lost')
    await visibleButton(card(lena), 'New Deal').click()
    await sheet(lena).getByRole('button', { name: 'Propose' }).click()
    await expect(toast(lena, 'Deal proposed')).toBeVisible()
    await expect(block(lena).locator('.dl-title')).toHaveText('Your deal: waiting for Sam and Kim')
    expect(await readDeal(SPACE_ID, `${p.lena}_2`)).toMatchObject({ seq: 2, count: 4, ended: null })
  })

  await closeAll(a)
})

test('won: one tap settles a together line, Past Deals, and Same Again', async ({ browser }) => {
  const p = await setup()
  const end = deadline(W2)
  await setDeal(SPACE_ID, lenaDeal(p, { ...agreedBy(p), track: [{ id: W1, result: 'pass', score: 95 }, { id: W2, result: 'pass', score: 100 }], ended: { outcome: 'won', at: end, period: W2 }, checkedAt: end + HOUR }))
  const now = at('2026-11-23T10:00')
  const a = await start(browser, LENA, now)
  const lena = a.page

  await test.step('You made it, and Sam and Kim owe you', async () => {
    await expectBlock(lena, 'You made it: 2 weeks at 90%+', 'Sam and Kim owe you: Dinner, on us')
    await expect(visibleButton(card(lena), 'Same Again')).toBeVisible()
    await snap(lena, 'deals-13-card-won')
  })

  await test.step('To Settle: one check marks both pairs', async () => {
    await openStakes(lena)
    const line = lena.getByRole('checkbox', { name: 'Settled: Sam and Kim owe you: Dinner, on us', exact: true })
    await expect(line).toBeEnabled()
    await expect(shown(lena, 'Your deal, 2 weeks · Together')).toBeVisible()
    await line.click()
    await expect(line).toBeChecked()
    await expect.poll(async () => ((await readDeal(SPACE_ID, `${p.lena}_1`))?.settled ?? {}) as Record<string, { settled: boolean; by: string }>).toMatchObject({
      [p.sam]: { settled: true, by: p.lena },
      [p.kim]: { settled: true, by: p.lena },
    })
    await expect(shown(lena, /^Your deal, 2 weeks · Together · Settled · marked by you, /)).toBeVisible()
    await snap(lena, 'deals-14-to-settle')
  })

  const b = await start(browser, SAM, now)
  const sam = b.page
  await test.step('Sam sees who marked it', async () => {
    await expect(shown(card(sam), 'Lena made it: you owe Dinner, on us')).toBeVisible()
    await openStakes(sam)
    await expect(sam.getByRole('checkbox', { name: 'Settled: You and Kim owe Lena: Dinner, on us', exact: true })).toBeChecked()
    await expect(shown(sam, /^Lena’s deal, 2 weeks · Together · Settled · marked by Lena, /)).toBeVisible()
  })

  await test.step('Past Deals', async () => {
    await visibleButton(lena, 'Past Deals').click()
    await expect(lena.getByRole('heading', { name: 'Past Deals' })).toBeVisible()
    await expect(shown(lena, '2 weeks · Made it')).toBeVisible()
    await expect(shown(lena, 'Nov 9 – Nov 21 · Dinner, on us')).toBeVisible()
    await snap(lena, 'deals-15-past-deals')
    await back(lena)
    await back(lena)
  })

  await test.step('Same Again: the same terms, and friends agree again', async () => {
    await visibleButton(card(lena), 'Same Again').click()
    await answer(lena, 'Propose', ['Same deal again?', '2 weeks at 90%+ each. Make it: Dinner, on us. Miss one: Coffee for a week. Friends have to agree again.'])
    await expect(toast(lena, 'Deal proposed')).toBeVisible()
    await expectBlock(lena, 'Your deal: waiting for Sam and Kim')
    expect(await readDeal(SPACE_ID, `${p.lena}_2`)).toMatchObject({ unit: 'week', count: 2, reward: SPACE.reward, penalty: SPACE.penalty, friends: [p.sam, p.kim], agreed: {} })
    await sam.goto(`/?now=${iso(now)}`)
    await openSpace(sam)
    await shown(card(sam), 'New deal from Lena').click()
    await visibleButton(sam, 'Agree to Lena’s Deal').click()
    await answer(sam, 'Agree')
    await expect(toast(sam, 'You agreed to Lena’s deal')).toBeVisible()
    await expectBlock(lena, 'Your deal: waiting for Kim')
  })

  await closeAll(a, b)
})

test('lost, per friend: each line its own, and a line owed to a friend who left', async ({ browser }) => {
  const p = await setup()
  const end = deadline(W2)
  await setDeal(
    SPACE_ID,
    lenaDeal(p, {
      ...agreedBy(p),
      penaltyMode: 'each',
      penalty: '',
      per: { [p.sam]: { reward: '', penalty: 'A coffee' }, [p.kim]: { reward: '', penalty: 'Flowers' } },
      track: [{ id: W1, result: 'pass', score: 95 }, { id: W2, result: 'miss', score: 84 }],
      ended: { outcome: 'lost', at: end, period: W2, score: 84 },
    }),
  )
  const now = at('2026-11-23T10:00')
  const a = await start(browser, LENA, now)
  const b = await start(browser, SAM, now)
  const [lena, sam] = [a.page, b.page]

  await test.step('Your deal ended: what you owe each friend', async () => {
    await expectBlock(lena, 'Your deal ended: 84% in the week of Nov 16', 'Pay up to Sam and Kim')
    await snap(lena, 'deals-16-card-lost-per-friend')
  })

  await test.step('Sam marks his own line', async () => {
    await expect(shown(card(sam), 'Lena’s deal ended: Lena owes you A coffee')).toBeVisible()
    await openStakes(sam)
    const line = sam.getByRole('checkbox', { name: 'Settled: Lena owes you: A coffee', exact: true })
    await line.click()
    await expect(line).toBeChecked()
    await expect.poll(async () => ((await readDeal(SPACE_ID, `${p.lena}_1`))?.settled as Record<string, unknown>)?.[p.sam]).toMatchObject({ settled: true, by: p.sam })
  })

  await test.step('Kim leaves: Lena may mark Kim’s line herself', async () => {
    await spaceDoc(SPACE_ID).update({ memberIds: [p.lena, p.sam], [`leftAt.${p.kim}`]: ts(at('2026-11-22T10:00')) })
    await openStakes(lena)
    await expect(lena.getByRole('checkbox', { name: 'Settled: You owe Sam: A coffee', exact: true })).toBeChecked()
    const kims = lena.getByRole('checkbox', { name: 'Settled: You owe Kim: Flowers', exact: true })
    await expect(kims).toBeEnabled()
    await expect(shown(lena, 'Kim has left, so you can mark this yourself.')).toBeVisible()
    await snap(lena, 'deals-17-settle-leaver')
    await kims.click()
    await expect.poll(async () => ((await readDeal(SPACE_ID, `${p.lena}_1`))?.settled as Record<string, unknown>)?.[p.kim]).toMatchObject({ settled: true, by: p.lena })
    await back(lena)
    await expectBlock(lena, 'Your deal ended: 84% in the week of Nov 16', 'All settled')
  })

  await closeAll(a, b)
})

test('Edit a waiting deal (friends agree again), then Withdraw it', async ({ browser }) => {
  const p = await setup()
  await setDeal(SPACE_ID, lenaDeal(p, { agreed: { [p.sam]: at('2026-11-04T10:00') } }))
  const a = await start(browser, LENA, at('2026-11-04T12:00'))
  const lena = a.page

  await test.step('Edit: 4 weeks instead of 2', async () => {
    await expectBlock(lena, 'Your deal: waiting for Kim')
    await openStakes(lena)
    await visibleButton(lena, /^2 weeks at 90%\+/).click()
    await expect(shown(lena, 'Agreed')).toBeVisible()
    await snap(lena, 'deals-18-deal-waiting')
    await visibleButton(lena, 'Edit Deal').click()
    const editor = sheet(lena)
    await expect(editor.getByRole('heading', { name: 'Edit Deal' })).toBeVisible()
    await editor.getByLabel('Length').selectOption('4')
    await editor.getByRole('button', { name: 'Propose' }).click()
    await expect(toast(lena, 'Deal updated')).toContainText('Friends have to agree again.')
    expect(await readDeal(SPACE_ID, `${p.lena}_1`)).toMatchObject({ ended: { outcome: 'withdrawn', by: p.lena } })
    expect(await readDeal(SPACE_ID, `${p.lena}_2`)).toMatchObject({ count: 4, agreed: {}, ended: null })
    // Back on the Stakes screen: Sam's Agree to the old one doesn't count.
    await expect(shown(lena, 'Waiting for Sam and Kim')).toBeVisible()
  })

  await test.step('Withdraw: nothing at stake', async () => {
    await visibleButton(lena, /^4 weeks at 90%\+/).click()
    await visibleButton(lena, 'Withdraw Deal').click()
    await answer(lena, 'Withdraw', ['Withdraw your deal?', 'Friends won’t be asked anymore, and nothing’s at stake until you make a new one.'])
    await expect(toast(lena, 'Deal withdrawn')).toBeVisible()
    await expect.poll(async () => ((await readDeal(SPACE_ID, `${p.lena}_2`))?.ended as { outcome?: string } | null)?.outcome).toBe('withdrawn')
    await back(lena)
    await expectBlock(lena, 'Nothing at stake')
  })

  await closeAll(a)
})

test('Call Off: everyone in it has to tap, and then it’s off', async ({ browser }) => {
  const p = await setup()
  await setDeal(SPACE_ID, lenaDeal(p, agreedBy(p)))
  const now = at('2026-11-11T10:00')
  const a = await start(browser, LENA, now)
  const b = await start(browser, SAM, now)
  const c = await start(browser, KIM, now)
  const [lena, sam, kim] = [a.page, b.page, c.page]

  await test.step('Lena asks', async () => {
    await openStakes(lena)
    await visibleButton(lena, /^2 weeks at 90%\+/).click()
    await visibleButton(lena, 'Call Off Deal').click()
    await answer(lena, 'Call Off', ['Call off your deal?', 'It ends only if Sam and Kim call it off too. Then nothing’s owed. You can’t take this back.'])
    await expect(toast(lena, 'Asked to call it off')).toContainText('It’s off once Sam and Kim agree.')
    await expect(shown(lena, 'You asked to call it off.', true)).toBeVisible()
    await back(lena)
    await back(lena)
    await expect(shown(card(lena), 'You asked to call it off. Waiting for Sam and Kim.')).toBeVisible()
    await snap(lena, 'deals-19-card-call-off')
  })

  await test.step('Sam sees it and taps Call Off', async () => {
    await expect(shown(card(sam), 'Lena wants to call off Lena’s deal')).toBeVisible()
    await shown(card(sam), 'Lena wants to call off Lena’s deal').click()
    await expect(shown(sam, 'Lena asked to call it off. It’s off once everyone taps Call Off.')).toBeVisible()
    await visibleButton(sam, 'Call Off').click()
    await answer(sam, 'Call Off', ['Call off Lena’s deal?', 'It ends only if everyone in it calls it off. Then nothing’s owed.'])
    await expect(toast(sam, 'Asked to call it off')).toContainText('It’s off once Kim agrees.')
  })

  await test.step('Kim’s tap is the last', async () => {
    await expect(shown(card(kim), 'Lena and Sam want to call off Lena’s deal')).toBeVisible()
    await shown(card(kim), 'Lena and Sam want to call off Lena’s deal').click()
    await visibleButton(kim, 'Call Off').click()
    await answer(kim, 'Call Off')
    await expect(toast(kim, 'Deal called off')).toContainText('It’s confirmed within a few hours.')
    await expect(shown(card(lena), 'Everyone called it off. It’s confirmed within a few hours.')).toBeVisible()
  })

  await test.step('The job confirms: off, nothing owed', async () => {
    await dealDoc(SPACE_ID, `${p.lena}_1`).update({ ended: { outcome: 'off', at: ts(now - HOUR), reason: 'called-off' } })
    await expectBlock(lena, 'Your deal is off', 'Everyone called it off, so nothing’s owed.')
    await snap(lena, 'deals-20-card-off')
    await expect(shown(card(sam), 'Lena’s deal is off')).toBeVisible()
  })

  await closeAll(a, b, c)
})

test('a months deal proposed on Nov 4 starts in December', async ({ browser }) => {
  const p = await setup()
  const now = at('2026-11-04T12:00')
  const a = await start(browser, LENA, now)
  const lena = a.page
  await visibleButton(card(lena), 'Make a Deal').click()
  const editor = sheet(lena)
  await editor.getByRole('radiogroup', { name: 'Unit' }).getByRole('radio', { name: 'Months' }).click()
  await editor.getByLabel('Length').selectOption('3')
  await expect(
    shown(
      editor,
      'Every month has to reach 90%. Your first month under ends the deal. It starts in December if everyone agrees by Sunday, Nov 29 at midnight: a deal starts with the first lists that lock at least a day after everyone agreed.',
    ),
  ).toBeVisible()
  await snap(lena, 'deals-21-editor-months')
  await editor.getByRole('button', { name: 'Propose' }).click()
  await expect(toast(lena, 'Deal proposed')).toBeVisible()
  await expectBlock(lena, 'Your deal: waiting for Sam and Kim', '3 months at 90%+. Starts in December if they agree by Sunday, Nov 29 at midnight.')
  await dealDoc(SPACE_ID, `${p.lena}_1`).update({ [`agreed.${p.sam}`]: ts(at('2026-11-04T13:00')), [`agreed.${p.kim}`]: ts(at('2026-11-04T14:00')) })
  await expectBlock(lena, 'Your deal starts in December', '3 months at 90%+ each. It counts from December’s first lists.')
  await closeAll(a)
})

test('a judge isn’t in a deal and has nothing at stake', async ({ browser }) => {
  const p = await setup({ judges: ['kim'] })
  const now = at('2026-11-04T12:00')
  const a = await start(browser, LENA, now)
  const lena = a.page
  await visibleButton(card(lena), 'Make a Deal').click()
  await sheet(lena).getByRole('button', { name: 'Propose' }).click()
  await expect(toast(lena, 'Deal proposed')).toContainText('Waiting for Sam to agree.')
  await expectBlock(lena, 'Your deal: waiting for Sam')
  expect((await readDeal(SPACE_ID, `${p.lena}_1`))?.friends).toEqual([p.sam])
  const c = await start(browser, KIM, now)
  const kim = c.page
  await expectBlock(kim, 'Nothing at stake', 'You’re judging, so nothing’s at stake. Turn off Only Rate Friends to make a deal.')
  await expect(shown(card(kim), 'New deal from Lena')).toHaveCount(0)
  await snap(kim, 'deals-22-card-judge')
  await closeAll(a, c)
})

test('the October window: October’s stakes read-only, then gone; November owes nothing by itself', async ({ browser }) => {
  const p = await setup()
  // Lena's batch-2 stakes, agreed by Sam and Kim in October.
  const stakes: SeedStakes = { rewardMode: 'group', penaltyMode: 'group', reward: 'Pizza night, on them', penalty: 'Coffee for everyone', tiers: [], updatedAt: at('2026-10-05T10:00') }
  const agreed = at('2026-10-06T10:00')
  await setStakes(SPACE_ID, p.lena, { ...stakes, agreed: { [p.sam]: { at: agreed, terms: pairOf(stakes, p.sam) }, [p.kim]: { at: agreed, terms: pairOf(stakes, p.kim) } } })
  const a = await start(browser, LENA, at('2026-10-26T15:00'))
  const lena = a.page

  await test.step('The card: October’s rows, and nothing at stake after October', async () => {
    await expectBlock(lena, 'Nothing at stake after October', 'From November, stakes don’t renew on their own. Make a deal: what you get for hitting 90%, what you owe if you miss, and for how long.')
    await expect(shown(card(lena), 'October’s stakes')).toBeVisible()
    await expect(shown(card(lena), 'Pizza night, on them')).toBeVisible()
    await snap(lena, 'deals-23-card-october')
  })

  await test.step('The Stakes screen: no Edit, no Agree', async () => {
    await openStakes(lena)
    await expect(shown(lena, 'These count for October, as agreed by now. From November nothing renews on its own: make a deal.')).toBeVisible()
    await expect(lena.getByRole('button', { name: 'Edit Streak Rewards' })).toHaveCount(0)
    await expect(lena.getByRole('button', { name: /^Agree/ })).toHaveCount(0)
    await expect(shown(lena, 'October’s house stakes are set. They count for October, as agreed.')).toBeVisible()
    await snap(lena, 'deals-24-stakes-october')
    await back(lena)
  })

  await test.step('Settings: the owner sees the house stakes read-only', async () => {
    await lena.getByRole('button', { name: 'Space settings' }).click()
    await expect(shown(lena, 'October’s house stakes are set. You can change them from November; new deals start from them.')).toBeVisible()
    await expect(lena.getByLabel('Reward')).toHaveCount(0)
    await expect(visibleButton(lena, 'Deals and Stakes')).toBeVisible()
    await back(lena)
  })

  await test.step('Make a Deal now starts next week (Monday 3 PM is less than a day before the lock)', async () => {
    await visibleButton(card(lena), 'Make a Deal').click()
    await expect(shown(sheet(lena), 'It starts next week if everyone agrees by Sunday at midnight.')).toBeVisible()
    await sheet(lena).getByRole('button', { name: 'Cancel' }).click()
  })

  await test.step('November: October’s rows are gone', async () => {
    await travel(lena, at('2026-11-03T10:00'))
    await expectBlock(lena, 'Nothing at stake')
    await expect(shown(card(lena), 'October’s stakes')).toHaveCount(0)
  })

  await test.step('December: November’s month view owes nothing by itself', async () => {
    const weeks = weekIdsInMonth('2026-11')
    for (const w of weeks) await setPlayedWeek(SPACE_ID, w, weekBounds(w, TZ), { [p.lena]: LENA_TASKS, [p.sam]: SAM_TASKS, [p.kim]: KIM_TASKS }, { marks: { [p.kim]: 0.5 } })
    await endMonthAt(SPACE_ID, weeks[weeks.length - 1], '2026-11', deadline(weeks[weeks.length - 1]))
    await travel(lena, at('2026-12-01T10:00'))
    await lena.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Month', exact: true }).click()
    const title = lena.locator('.s-month-switch__title').filter({ visible: true })
    if (!(await title.innerText()).includes('November')) await lena.getByRole('button', { name: 'Previous month' }).click()
    await expect(title).toContainText('November')
    await expect(lena.locator('.s-month-switch__sub').filter({ visible: true })).toHaveText('Final')
    await expect(shown(lena, 'Deals are settled on the Stakes screen.')).toBeVisible()
    await expect(lena.getByText(/ owes? you: /).filter({ visible: true })).toHaveCount(0)
    await snap(lena, 'deals-25-month-november')
  })

  await test.step('A late ship (dealsFrom December): November keeps its stakes', async () => {
    await setDealsFrom('2026-12')
    await travel(lena, at('2026-12-01T10:00'))
    await lena.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Month', exact: true }).click()
    const title = lena.locator('.s-month-switch__title').filter({ visible: true })
    if (!(await title.innerText()).includes('November')) await lena.getByRole('button', { name: 'Previous month' }).click()
    await expect(title).toContainText('November')
    await expect(lena.getByText(/ owe you: /).filter({ visible: true }).first()).toBeVisible()
    await expect(shown(lena, 'Deals are settled on the Stakes screen.')).toHaveCount(0)
    await setDealsFrom(null)
  })

  await closeAll(a)
})

test('streak rewards from November: Lena adds one, Sam agrees', async ({ browser }) => {
  await setup()
  const now = at('2026-11-11T10:00')
  const a = await start(browser, LENA, now)
  const lena = a.page
  await openStakes(lena)
  await visibleButton(lena, 'Edit Streak Rewards').click()
  const editor = sheet(lena)
  await expect(editor.getByRole('heading', { name: 'Streak Rewards' })).toBeVisible()
  await editor.getByRole('button', { name: 'Add Streak Reward' }).click()
  await tapAction(lena, '2 months')
  await editor.getByLabel('Reward for 2 months in a row').fill('Weekend away')
  await snap(lena, 'deals-26-streak-editor')
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(toast(lena, 'Saved')).toContainText('Counts as soon as Sam and Kim agree.')
  await expect(shown(lena, 'Your new streak rewards')).toBeVisible()

  const b = await start(browser, SAM, now)
  const sam = b.page
  await openStakes(sam)
  await expect(shown(sam, 'Lena’s streak rewards')).toBeVisible()
  await visibleButton(sam, 'Agree to Lena’s Streak Rewards').click()
  await answer(sam, 'Agree', ['Agree to Lena’s streak rewards?', '2 months in a row: you all owe “Weekend away”, together.'])
  await expect(toast(sam, 'You agreed')).toContainText('They count once everyone agrees.')
  const samRow = lena.locator('.ui-row').filter({ visible: true }).filter({ hasText: 'Sam' }).filter({ hasText: 'Agreed' })
  await expect(samRow).toBeVisible()
  await centerOn(samRow)
  await snap(lena, 'deals-27-streak-status')
  await closeAll(a, b)
})

/** Taps an action in the action sheet on screen. */
async function tapAction(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).filter({ visible: true }).last().click()
}

test('Help explains deals', async ({ browser }) => {
  await setup()
  const a = await start(browser, LENA, at('2026-11-11T10:00'))
  const lena = a.page
  await lena.getByRole('button', { name: 'Space settings' }).click()
  await lena.getByRole('button', { name: 'How Stakes Works' }).click()
  await expect(shown(lena, 'Make a deal with friends: your reward, your penalty, and how many weeks or months it runs.')).toBeVisible()
  await expect(shown(lena, 'It starts when every friend taps Agree. Every week or month in it needs 90%; the first miss ends it and you owe your penalty.')).toBeVisible()
  await expect(shown(lena, 'Make it to the end and they owe you your reward. Then nothing’s at stake until a new deal.')).toBeVisible()
  await closeAll(a)
})

test('leaving or removing someone mid-deal counts as a miss; a waiting deal is withdrawn', async ({ browser }) => {
  const p = await setup({ owner: 'sam' })
  await setDeal(SPACE_ID, lenaDeal(p, agreedBy(p)))
  const now = at('2026-11-11T10:00')
  const a = await start(browser, LENA, now)
  const b = await start(browser, SAM, now)
  const [lena, sam] = [a.page, b.page]

  await test.step('Lena’s Leave confirm warns her', async () => {
    await lena.getByRole('button', { name: 'Space settings' }).click()
    await visibleButton(lena, 'Leave Space').click()
    await expect(alertBox(lena)).toContainText('Your deal is on. Leaving counts as a miss: you’d owe Sam and Kim your penalty.')
    await snap(lena, 'deals-28-leave-confirm')
    await answer(lena, 'Cancel')
  })

  await test.step('The owner’s Remove says what it does to Lena’s deal', async () => {
    await sam.getByRole('button', { name: 'Space settings' }).click()
    await visibleButton(sam, new RegExp(LENA.name)).click()
    await expect(shown(sam, 'Lena’s deal is on. Removing Lena counts as a miss for it, so Lena would owe the penalty.')).toBeVisible()
    await sam.getByRole('button', { name: 'Cancel', exact: true }).filter({ visible: true }).last().click()
  })

  await test.step('A waiting deal is withdrawn as she leaves', async () => {
    await dealDoc(SPACE_ID, `${p.lena}_1`).update({ ended: { outcome: 'off', at: ts(now - DAY), reason: 'called-off' } })
    await setDeal(SPACE_ID, lenaDeal(p, { seq: 2, createdAt: now - HOUR }))
    await travel(lena, now)
    await lena.getByRole('button', { name: 'Space settings' }).click()
    await visibleButton(lena, 'Leave Space').click()
    await answer(lena, 'Leave', ['Your deal waiting for agreement is withdrawn.'])
    await expect.poll(async () => ((await readDeal(SPACE_ID, `${p.lena}_2`))?.ended as { outcome?: string } | null)?.outcome).toBe('withdrawn')
  })

  await closeAll(a, b)
})
