// Batch 2 end to end (SPEC §9), in iPhone-sized browsers against the emulators with the real rules: a space's
// own times, pausing a week, judges, switching role, a monthly list, per-person stakes per line, agreed changes
// that count at once while finished months keep theirs, the house stakes (with the previous app's early
// freeze), and settling per pair. Accounts, spaces and the stored timelines are seeded; what people do goes
// through the UI.
//
// Time. `?now=` moves only the client's clock; the emulator stamps every write with the real time, and that is
// what the rules judge plans, reviews, freezes and stakes edits by, and what an Agree is stamped with. So each
// test seeds the stored bounds that decide something relative to the real clock (`Date.now()`), so the phone
// and the server agree: a month the phone sees as complete has its last week's (and list's) stored deadline in
// the real past, and a review the server must accept has its stored window open in real time. "This month" in
// the stakes tests is the month after the real one, so `?now=` is ahead of real time.
//
// Run with the other specs (see flow.spec.ts), or alone:
//   npx firebase emulators:exec --only auth,firestore --project demo-stakes "npx playwright test batch2"
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { scheduleProblem, scheduleProblemText } from '../../src/domain/schedule.ts'
import { houseFreezeMonths } from '../../src/domain/stakes.ts'
import {
  addMonths,
  addWeeks,
  formatCountdown,
  formatMonth,
  formatWeekRange,
  momentAt,
  monthIdForWeek,
  utcOffsetMinutes,
  weekBounds,
  weekIdFor,
  weekIdsInMonth,
} from '../../src/domain/time.ts'
import type { WeekSchedule } from '../../src/domain/types.ts'
import {
  createAccount,
  db,
  endMonthAt,
  monthlyDoc,
  monthStakesDoc,
  pairOf,
  resetEmulators,
  setMonthly,
  setMonthlyPlan,
  setMonthStakes,
  setPlan,
  setPlayedWeek,
  setResults,
  setReview,
  setSettlement,
  setSpace,
  setStakes,
  setWeek,
  settlementDoc,
  spaceDoc,
  ts,
  weekDoc,
  type SeedStakes,
  type SeedTask,
} from './emulator.ts'
import { centerOn, phone, sheet, shown, snap } from './helpers.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TZ = 'Europe/Rome'
const CITY = 'Rome'

type Who = { name: string; email: string; password: string }
const person = (name: string, email: string): Who => ({ name, email, password: 'secret123' })
const MARCO = person('Marco Rossi', 'marco@example.com')
const LENA = person('Lena Fischer', 'lena@example.com')
const SAM = person('Sam Okafor', 'sam@example.com')
const KIM = person('Kim Park', 'kim@example.com')
const ANA = person('Ana Souza', 'ana@example.com')
const BEN = person('Ben Carter', 'ben@example.com')
const COLORS: Record<string, string> = { Marco: '#FF9500', Lena: '#AF52DE', Sam: '#34C759', Kim: '#FF2D55', Ana: '#5AC8FA', Ben: '#FFCC00' }

const SPACE_ID = 'film-crew'
const SPACE = { name: 'Film Crew', reward: 'Dinner at Da Enzo, on them', penalty: 'Coffee for everyone, for a week' }
const CODE = 'FCRW2345'

const MARCO_TASKS: SeedTask[] = [
  { id: 'm1', title: 'Color grade the Nike spot' },
  { id: 'm2', title: 'Send the treatment to the agency' },
]
const LENA_TASKS: SeedTask[] = [
  { id: 'l1', title: 'Finish the Lavazza edit' },
  { id: 'l2', title: 'Two gym sessions' },
]
const SAM_TASKS: SeedTask[] = [
  { id: 's1', title: 'Mix the podcast pilot' },
  { id: 's2', title: 'Call the venue about Saturday' },
]
const KIM_TASKS: SeedTask[] = [
  { id: 'k1', title: 'Storyboard the music video' },
  { id: 'k2', title: 'Return the rented lights' },
]

// ---------- Time and words ----------

const iso = (ms: number) => new Date(ms).toISOString()
/** An instant on a week's wall clock in the space's zone: `day` 0 = Monday, `hour` 0–23. */
const on = (weekId: string, day: number, hour: number) => momentAt(weekId, TZ, day * 1440 + hour * 60)
const lastWeekOf = (monthId: string) => weekIdsInMonth(monthId)[weekIdsInMonth(monthId).length - 1]
const MONTH_NAME = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })
/** "2026-10" → "October", as the app writes it. */
const monthName = (monthId: string) => MONTH_NAME.format(Date.UTC(Number(monthId.slice(0, 4)), Number(monthId.slice(5, 7)) - 1, 1))
const WEEK_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
/** A week's Monday as "Oct 19". */
const weekLabel = (weekId: string) => WEEK_LABEL.format(Date.parse(`${weekId}T00:00:00Z`))
/** The app-month of the real now (the month of this week's Friday), and the one after it. */
function realMonths(now: number): { thisWeek: string; real: string; next: string } {
  const thisWeek = weekIdFor(now, TZ)
  const real = monthIdForWeek(thisWeek)
  return { thisWeek, real, next: addMonths(real, 1) }
}

// ---------- Seeding ----------

async function accounts(at: number, ...people: Who[]): Promise<string[]> {
  const uids: string[] = []
  for (const who of people) uids.push(await createAccount(who, COLORS[who.name.split(' ')[0]], at))
  return uids
}

function seedSpace(members: string[], at: number, more: Partial<Parameters<typeof setSpace>[1]> = {}) {
  return setSpace(SPACE_ID, { ...SPACE, members, timezone: TZ, utcOffsetMin: utcOffsetMinutes(TZ, Date.now()), inviteCode: CODE, at, ...more })
}

// ---------- Browser ----------

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })

/** Signs in from the Welcome screen, with the phone's clock at `nowMs` when given. */
async function signIn(page: Page, who: Who, nowMs?: number): Promise<void> {
  await page.goto(nowMs === undefined ? '/' : `/?now=${iso(nowMs)}`)
  await page.getByRole('button', { name: 'I Have an Account' }).click()
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await expect(tab(page, 'Spaces')).toHaveAttribute('aria-selected', 'true')
}

/** Reopens the app with the phone's clock at `nowMs` (or the real clock): back on the Spaces tab, still signed in. */
async function travel(page: Page, nowMs: number | null): Promise<void> {
  await page.goto(nowMs === null ? '/' : `/?now=${iso(nowMs)}`)
  await expect(tab(page, 'Spaces')).toHaveAttribute('aria-selected', 'true')
}

async function openSpace(page: Page): Promise<void> {
  await page.getByRole('button', { name: new RegExp(SPACE.name) }).first().click()
  await expect(page.getByRole('heading', { name: SPACE.name })).toBeVisible()
}

async function back(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Back/ }).filter({ visible: true }).first().click()
}

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const viewTab = (page: Page, name: 'This Week' | 'Next Week' | 'Month') => page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name, exact: true })
/** A visible grouped section holding `text`. */
const section = (page: Page | Locator, text: string | RegExp) => page.locator('.ui-section').filter({ visible: true }).filter({ hasText: text }).first()
/** A banner (toast) with this text. */
const toast = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text }).first()
/** The week's header pill ("Locks in 2d 4h", "Paused"). */
const weekHead = (page: Page) => page.locator('.s-week-head').filter({ visible: true }).first()
/** The Space screen's stakes card. */
const stakesCard = (page: Page) => page.locator('.sk-card').filter({ visible: true }).first()

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Space settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
}

/** The Month tab on `monthId`, stepping with the month switcher. */
async function showMonth(page: Page, monthId: string): Promise<void> {
  await viewTab(page, 'Month').click()
  const title = page.locator('.s-month-switch__title').filter({ visible: true })
  const want = formatMonth(monthId)
  await expect(title).toBeVisible()
  for (const direction of ['Previous month', 'Next month']) {
    for (let i = 0; i < 6; i++) {
      const current = await title.innerText()
      if (current.includes(want)) return
      const button = page.getByRole('button', { name: direction })
      if (await button.isDisabled()) break
      await button.click()
      await expect(title).not.toHaveText(current)
    }
  }
  await expect(title).toContainText(want)
}

/** A week's row in the month view (it opens the week). */
const weekRow = (page: Page, weekId: string) => page.getByRole('button', { name: new RegExp(`^${esc(formatWeekRange(weekId))}`) }).filter({ visible: true }).first()
const stakesHeading = (page: Page) => page.getByRole('heading', { name: 'Stakes', exact: true })
/** The week's Judges list (a section headed "Judges"). */
const judgesSection = (page: Page) =>
  page.locator('.ui-section').filter({ visible: true }).filter({ has: page.getByRole('heading', { name: 'Judges', exact: true }) }).first()

async function answer(page: Page, button: string): Promise<Locator> {
  const alert = page.getByRole('alertdialog')
  await expect(alert).toBeVisible()
  await alert.getByRole('button', { name: button, exact: true }).click()
  return alert
}

async function addTasks(page: Page | Locator, titles: string[]): Promise<void> {
  const input = page.getByLabel('New task')
  for (const title of titles) {
    await input.fill(title)
    await input.press('Enter')
  }
  await input.blur()
}

async function mark(dialog: Locator, title: string, label: 'Done' | 'Half' | 'Not done'): Promise<void> {
  await dialog.getByRole('radiogroup', { name: `Mark for ${title}` }).getByRole('radio', { name: label, exact: true }).click()
}

/** "Locks in 4d 12h" for the lock at `lockAt`, allowing for a minute ticking over while we look. */
async function expectLocksIn(page: Page, lockAt: number): Promise<void> {
  await expect
    .poll(async () => {
      const text = await weekHead(page).innerText()
      const left = lockAt - Date.now()
      return [left - MINUTE, left, left + MINUTE].some((ms) => text.includes(`Locks in ${formatCountdown(ms)}`))
    })
    .toBe(true)
}

async function joinWithCode(page: Page, who: Who, opts: { judge?: boolean } = {}): Promise<void> {
  await page.goto(`/?join=${CODE}`)
  await page.getByRole('button', { name: 'I Have an Account' }).click()
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  const join = sheet(page)
  await expect(join.getByLabel('Invite code')).toHaveValue(`${CODE.slice(0, 4)}-${CODE.slice(4)}`)
  if (opts.judge) {
    const toggle = join.getByRole('switch', { name: 'Only Rate Friends' })
    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect(shown(join, 'Judges rate everyone each week, with no list, no score and nothing owed. You can change this in Settings.')).toBeVisible()
  }
  await join.getByRole('button', { name: `Join ${SPACE.name}`, exact: true }).click()
  await expect(page.getByRole('heading', { name: SPACE.name })).toBeVisible()
  // In a Safari tab, joining leads straight to installing the app.
  const guide = page.getByRole('dialog').filter({ hasText: `You’re in ${SPACE.name}.` })
  await expect(guide).toBeVisible()
  await guide.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(guide).toHaveCount(0)
}

async function planOf(path: string): Promise<string[]> {
  const snap = await db.doc(path).get()
  return ((snap.get('tasks') as SeedTask[] | undefined) ?? []).map((t) => t.title)
}

async function closeAll(browser: Browser, ...phones: { context: { close: () => Promise<void> }; errors: string[] }[]): Promise<void> {
  void browser
  for (const p of phones) expect(p.errors).toEqual([])
  for (const p of phones) await p.context.close()
}

// =====================================================================================================
// 1. Times (SPEC §9.2)
// =====================================================================================================

test('the owner changes the week’s times: notice, read-only for friends, the new times from next week', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [marcoUid, lenaUid] = await accounts(t0 - 40 * DAY, MARCO, LENA, KIM)
  await seedSpace([marcoUid, lenaUid], t0 - 30 * DAY)
  const thisWeek = weekIdFor(t0, TZ)
  const nextWeek = addWeeks(thisWeek, 1)
  await setWeek(SPACE_ID, thisWeek, { ...weekBounds(thisWeek, TZ), members: [marcoUid, lenaUid], submittedBy: [] })
  await setWeek(SPACE_ID, nextWeek, { ...weekBounds(nextWeek, TZ), members: [marcoUid, lenaUid], submittedBy: [] })
  // Lena has this week planned (so her Spaces card has nothing more urgent than the notice), and Marco has next
  // week planned, so Lena has someone to review on its new review day.
  await setPlan(SPACE_ID, thisWeek, lenaUid, LENA_TASKS, t0 - HOUR)
  await setPlan(SPACE_ID, nextWeek, marcoUid, MARCO_TASKS, t0 - HOUR)

  // Lists lock Tuesday at noon; reviews open Friday at midnight (so the review day is Saturday) and are due
  // Saturday at midnight.
  const custom: WeekSchedule = { lock: 2160, reviewOpen: 7200, deadline: 8640 }
  expect(scheduleProblem(custom)).toBeNull()
  const newLock = momentAt(nextWeek, TZ, custom.lock)

  const a = await phone(browser)
  const b = await phone(browser)
  const marco = a.page
  const lena = b.page

  await test.step('Marco sets new times in Settings → Week Schedule and confirms', async () => {
    await signIn(marco, MARCO)
    await openSpace(marco)
    await openSettings(marco)
    await marco.getByRole('button', { name: /^Week Schedule/ }).click()
    await expect(marco.getByRole('heading', { name: 'Week Schedule' })).toBeVisible()
    await expect(shown(marco, `Midnight is the end of the day you pick. Times follow ${CITY} time.`)).toBeVisible()
    await snap(marco, 'b2-01-schedule-owner')
    await marco.getByLabel('Reviews due: day').selectOption({ label: 'Saturday' })
    await marco.getByLabel('Reviews open: day').selectOption({ label: 'Friday' })
    await marco.getByLabel('Lists lock: day').selectOption({ label: 'Tuesday' })
    await marco.getByLabel('Lists lock: time').selectOption({ label: 'Noon' })
    await expect(marco.getByLabel('Reviews due: time')).toHaveValue('1440')
    await expect(section(marco, 'Starts')).toContainText('Next week')
    await marco.getByRole('button', { name: 'Save', exact: true }).click()
    const alert = marco.getByRole('alertdialog')
    await expect(alert).toContainText('Change the times?')
    await expect(alert).toContainText(
      `From next week, lists lock Tuesday at noon, reviews open Friday at midnight and reviews are due Saturday at midnight. This week keeps its times. Everyone in ${SPACE.name} gets a notice.`,
    )
    await snap(marco, 'b2-02-schedule-confirm', 400)
    await answer(marco, 'Change Times')
    await expect(toast(marco, 'New times saved')).toContainText('They start next week.')
    await expect.poll(async () => (await spaceDoc(SPACE_ID).get()).get('schedule')).toEqual(custom)
    const note = (await spaceDoc(SPACE_ID).get()).get('scheduleNote') as { by: string; fromWeek: string; before: WeekSchedule }
    expect(note).toMatchObject({ by: marcoUid, fromWeek: nextWeek, before: { lock: 1440, reviewOpen: 5760, deadline: 7200 } })
    // Next week moved to the new times (a day's notice on both); this week kept its own.
    const next = await weekDoc(SPACE_ID, nextWeek).get()
    expect(next.get('schedule')).toEqual(custom)
    expect((next.get('lockAt') as { toMillis(): number }).toMillis()).toBe(newLock)
    expect((await weekDoc(SPACE_ID, thisWeek).get()).get('schedule')).toBeUndefined()
  })

  await test.step('Lena’s Spaces card and Space screen say so; dismissing the notice sticks', async () => {
    await signIn(lena, LENA)
    await expect(lena.getByRole('button', { name: new RegExp(SPACE.name) }).first()).toContainText('New times from next week')
    await snap(lena, 'b2-03-spaces-new-times', 1000)
    await openSpace(lena)
    const notice = section(lena, 'New times from next week')
    await expect(notice).toContainText(
      'Marco changed them. Lists now lock Tuesday at noon, reviews open Friday at midnight and reviews are due Saturday at midnight.',
    )
    await snap(lena, 'b2-04-schedule-notice')
    await notice.getByRole('button', { name: 'Dismiss' }).click()
    await expect(lena.getByText('New times from next week', { exact: true }).filter({ visible: true })).toHaveCount(0)
    await travel(lena, null)
    await openSpace(lena)
    await expect(lena.getByRole('heading', { name: SPACE.name })).toBeVisible()
    await expect(lena.getByText('Marco changed them.', { exact: false }).filter({ visible: true })).toHaveCount(0)
  })

  await test.step('Lena sees the times read-only, and Help shows the new week', async () => {
    await openSettings(lena)
    await expect(lena.getByRole('button', { name: /^Week Schedule/ })).toContainText('Custom')
    await expect(shown(lena, 'Lists lock Tuesday at noon and reviews are due Saturday at midnight, Rome time.')).toBeVisible()
    await lena.getByRole('button', { name: /^Week Schedule/ }).click()
    await expect(lena.getByRole('heading', { name: 'Week Schedule' })).toBeVisible()
    await expect(lena.getByLabel('Lists lock: day')).toHaveCount(0)
    await expect(shown(lena, /^Only Marco, the owner, can change the times\. Changed by Marco on [A-Z][a-z]{2} \d{1,2}\./)).toBeVisible()
    await expect(shown(lena, 'Tuesday at noon', true)).toBeVisible()
    await snap(lena, 'b2-05-schedule-friend')
    await back(lena)
    await lena.getByRole('button', { name: 'How Stakes Works' }).click()
    await expect(lena.getByRole('heading', { name: 'How Stakes Works' })).toBeVisible()
    const saturday = lena.locator('.hp-stop').filter({ visible: true }).filter({ hasText: 'Saturday' })
    await expect(saturday).toContainText('Reviews due by midnight')
    await expect(lena.locator('.hp-stop').filter({ visible: true }).filter({ hasText: 'Tuesday' })).toContainText('Lists lock at noon')
    await expect(shown(lena, `This space’s own times, on ${CITY} time.`)).toBeVisible()
    await snap(lena, 'b2-06-help-own-times')
    await back(lena)
    await back(lena)
  })

  await test.step('Next week’s pill counts down to the new lock', async () => {
    await viewTab(lena, 'Next Week').click()
    await expectLocksIn(lena, newLock)
  })

  await test.step('Tuesday morning of next week: the old lock has passed, the new one hasn’t, and Lena still plans', async () => {
    await travel(lena, on(nextWeek, 1, 8))
    await openSpace(lena)
    await expect(weekHead(lena)).toContainText(formatWeekRange(nextWeek))
    await expect(weekHead(lena)).toContainText(/Locks in [34]h/)
    await addTasks(lena, ['Edit the festival trailer'])
    await expect.poll(() => planOf(`spaces/${SPACE_ID}/weeks/${nextWeek}/plans/${lenaUid}`)).toEqual(['Edit the festival trailer'])
  })

  await test.step('On the new review day the sheet is the Saturday Review, and Submit goes through', async () => {
    await travel(lena, on(nextWeek, 5, 10))
    await openSpace(lena)
    const cta = lena.getByRole('button', { name: 'Review Marco', exact: true })
    await expect(cta).toBeVisible()
    await cta.click()
    const review = sheet(lena)
    await expect(review.getByRole('heading', { name: 'Saturday Review' })).toBeVisible()
    await snap(lena, 'b2-07-saturday-review')
    // The server judges the submit by the real clock: open the stored review window in real time too (and put
    // it back afterwards, so the screens that follow don't read "This week’s times are off").
    const storedOpen = (await weekDoc(SPACE_ID, nextWeek).get()).get('reviewOpenAt')
    await weekDoc(SPACE_ID, nextWeek).update({ reviewOpenAt: ts(Date.now() - HOUR) })
    await mark(review, MARCO_TASKS[0].title, 'Done')
    await mark(review, MARCO_TASKS[1].title, 'Half')
    await review.getByRole('button', { name: 'Submit Reviews', exact: true }).click()
    await answer(lena, 'Submit')
    await expect(shown(review, 'Reviews in.')).toBeVisible()
    await expect.poll(async () => (await weekDoc(SPACE_ID, nextWeek).collection('reviews').doc(`${lenaUid}_${marcoUid}`).get()).get('marks')).toEqual({ m1: 1, m2: 0.5 })
    await review.getByRole('button', { name: 'Done', exact: true }).click()
    await weekDoc(SPACE_ID, nextWeek).update({ reviewOpenAt: storedOpen })
  })

  await test.step('Kim joins afterwards and is told once that this space has its own times', async () => {
    const c = await phone(browser)
    const kim = c.page
    await joinWithCode(kim, KIM)
    const notice = section(kim, 'This space has its own times')
    await expect(notice).toContainText('Lists lock Tuesday at noon · Reviews open Friday at midnight · Reviews due Saturday at midnight.')
    await snap(kim, 'b2-08-own-times-notice')
    await notice.getByRole('button', { name: 'Dismiss' }).click()
    await expect(kim.getByText('This space has its own times', { exact: true }).filter({ visible: true })).toHaveCount(0)
    await travel(kim, null)
    await openSpace(kim)
    await expect(kim.getByText('This space has its own times', { exact: true }).filter({ visible: true })).toHaveCount(0)
    expect(c.errors).toEqual([])
    await c.context.close()
  })

  await test.step('An invalid draft says why in red and can’t be saved; Use the Usual Times goes back to Usual', async () => {
    // Marco is still on Week Schedule. Reviews opening Sunday at midnight would be after they're due.
    await marco.getByLabel('Reviews open: day').selectOption({ label: 'Sunday' })
    const draft: WeekSchedule = { ...custom, reviewOpen: 10080 }
    const problem = scheduleProblem(draft)
    expect(problem).not.toBeNull()
    const text = scheduleProblemText(problem!, draft)
    expect(text).toContain('Midnight is the end of the day you pick.')
    await expect(shown(marco, text)).toBeVisible()
    await expect(marco.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await snap(marco, 'b2-09-schedule-invalid')
    await marco.getByRole('button', { name: 'Use the Usual Times' }).click()
    await expect(marco.getByLabel('Lists lock: day')).toHaveValue('0')
    await marco.getByRole('button', { name: 'Save', exact: true }).click()
    await answer(marco, 'Change Times')
    await expect(toast(marco, 'New times saved')).toBeVisible()
    await expect.poll(async () => (await spaceDoc(SPACE_ID).get()).get('schedule')).toBeUndefined()
    await back(marco)
    await expect(marco.getByRole('button', { name: /^Week Schedule/ })).toContainText('Usual')
  })

  await closeAll(browser, a, b)
})

// =====================================================================================================
// 2. Pause a week (SPEC §9.3)
// =====================================================================================================

test('pause next week: asked, OK’d, paused, and the month’s pause is used', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [marcoUid, lenaUid] = await accounts(t0 - 40 * DAY, MARCO, LENA)
  await seedSpace([marcoUid, lenaUid], t0 - 30 * DAY)
  const thisWeek = weekIdFor(t0, TZ)
  const nextWeek = addWeeks(thisWeek, 1)
  await setWeek(SPACE_ID, thisWeek, { ...weekBounds(thisWeek, TZ), members: [marcoUid, lenaUid], submittedBy: [] })
  await setWeek(SPACE_ID, nextWeek, { ...weekBounds(nextWeek, TZ), members: [marcoUid, lenaUid], submittedBy: [] })
  const month = monthIdForWeek(nextWeek)

  const a = await phone(browser)
  const b = await phone(browser)
  const marco = a.page
  const lena = b.page

  await test.step('Marco asks to pause next week', async () => {
    await signIn(marco, MARCO)
    await openSpace(marco)
    await openSettings(marco)
    await expect(shown(marco, 'Need a break? A paused week doesn’t count: no reviews, no score. It needs everyone’s OK, once a month at most.')).toBeVisible()
    await marco.getByRole('button', { name: /^Pause a Week/ }).click()
    const actions = marco.getByRole('dialog', { name: 'Pause a week?' })
    await expect(actions).toContainText(`Nothing counts in a paused week, and it’s left out of the month’s average. Everyone in ${SPACE.name} has to say OK by`)
    await snap(marco, 'b2-10-pause-actions', 400)
    await actions.getByRole('button', { name: 'Pause Next Week', exact: true }).click()
    await expect(toast(marco, 'Asked everyone')).toContainText('They’ll see it next time they open Stakes.')
    await expect.poll(async () => (await spaceDoc(SPACE_ID).get()).get('pause')).toMatchObject({ weekId: nextWeek, by: marcoUid, oks: [marcoUid] })
    await expect(shown(marco, 'Pause Requested')).toBeVisible()
  })

  await test.step('Lena sees the request and says OK; both see next week paused', async () => {
    await signIn(lena, LENA)
    await expect(lena.getByRole('button', { name: new RegExp(SPACE.name) }).first()).toContainText('Marco asks to pause next week')
    await snap(lena, 'b2-10b-spaces-pause-ask', 1000)
    await openSpace(lena)
    const card = section(lena, 'Pause next week?')
    await expect(card).toContainText('Marco asked. It only happens if everyone says OK before reviews open')
    await expect(card).toContainText('1 of 2 said OK')
    await snap(lena, 'b2-11-pause-to-answer')
    await card.getByRole('button', { name: 'OK', exact: true }).click()
    await expect.poll(async () => (await spaceDoc(SPACE_ID).get()).get('paused')).toEqual({ [month]: nextWeek })
    await expect(section(lena, 'Next week is paused')).toContainText('Everyone said OK. No reviews and no score that week.')
    await back(marco)
    await expect(section(marco, 'Next week is paused')).toBeVisible()
    await snap(marco, 'b2-12-pause-paused')
  })

  await test.step('Marco’s Settings row: this month’s pause is used', async () => {
    await openSettings(marco)
    await expect(shown(marco, `${monthName(month)}’s pause is used.`)).toBeVisible()
    await back(marco)
  })

  await test.step('Next week: the pill reads Paused, the list is just for you, no 0% warning', async () => {
    await viewTab(marco, 'Next Week').click()
    await expect(weekHead(marco)).toContainText('Paused')
    await expect(shown(marco, 'Paused: your list is just for you next week.')).toBeVisible()
    await expect(marco.getByText(/Empty list = 0%/).filter({ visible: true })).toHaveCount(0)
    await snap(marco, 'b2-13-paused-next-week')
  })

  await test.step('In that week’s review window there is nothing to review', async () => {
    await travel(marco, on(nextWeek, 4, 10))
    await openSpace(marco)
    await expect(weekHead(marco)).toContainText('Paused')
    await expect(section(marco, 'This week is paused')).toContainText('No reviews, no score')
    await expect(marco.getByRole('button', { name: /^Review / })).toHaveCount(0)
    await expect(marco.getByRole('button', { name: 'Unlock Results' })).toHaveCount(0)
    await snap(marco, 'b2-14-paused-this-week')
  })

  await closeAll(browser, a, b)
})

test('pause: Not Now ends a request, the asker waits 12 hours, and can cancel a request', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [marcoUid, lenaUid, samUid] = await accounts(t0 - 40 * DAY, MARCO, LENA, SAM)
  const members = [marcoUid, lenaUid, samUid]
  await seedSpace(members, t0 - 30 * DAY)
  const thisWeek = weekIdFor(t0, TZ)
  const nextWeek = addWeeks(thisWeek, 1)
  await setWeek(SPACE_ID, thisWeek, { ...weekBounds(thisWeek, TZ), members, submittedBy: [] })
  await setWeek(SPACE_ID, nextWeek, { ...weekBounds(nextWeek, TZ), members, submittedBy: [] })

  const a = await phone(browser)
  const b = await phone(browser)
  const c = await phone(browser)
  const [marco, lena, sam] = [a.page, b.page, c.page]

  const askNextWeek = async () => {
    await marco.getByRole('button', { name: /^Pause a Week/ }).click()
    await marco.getByRole('dialog', { name: 'Pause a week?' }).getByRole('button', { name: 'Pause Next Week', exact: true }).click()
    await expect(toast(marco, 'Asked everyone')).toBeVisible()
  }

  await test.step('Marco asks, Lena says OK, Sam says Not Now', async () => {
    await signIn(marco, MARCO)
    await openSpace(marco)
    await openSettings(marco)
    await askNextWeek()
    await signIn(lena, LENA)
    await openSpace(lena)
    await section(lena, 'Pause next week?').getByRole('button', { name: 'OK', exact: true }).click()
    await expect(shown(lena, 'You said OK. Waiting for Sam.')).toBeVisible()
    await snap(lena, 'b2-15-pause-said-ok')
    await signIn(sam, SAM)
    await openSpace(sam)
    await expect(section(sam, 'Pause next week?')).toContainText('2 of 3 said OK')
    await section(sam, 'Pause next week?').getByRole('button', { name: 'Not Now', exact: true }).click()
    await answer(sam, 'Not Now')
    await expect.poll(async () => (await spaceDoc(SPACE_ID).get()).get('pause.declinedBy')).toBe(samUid)
  })

  await test.step('Everyone sees it isn’t happening; Marco has to wait before asking again', async () => {
    await expect(shown(lena, 'Not happening: Sam said not now.')).toBeVisible()
    await expect(shown(sam, 'Not happening: you said not now.')).toBeVisible()
    await back(marco)
    await expect(shown(marco, 'Not happening: Sam said not now.')).toBeVisible()
    await snap(marco, 'b2-16-pause-declined')
    await openSettings(marco)
    await expect(shown(marco, 'You asked not long ago.')).toBeVisible()
  })

  await test.step('Once his request is 13 hours old, Marco can ask again', async () => {
    await spaceDoc(SPACE_ID).update({ 'pause.at': ts(Date.now() - 13 * HOUR) })
    await expect(marco.getByRole('button', { name: /^Pause a Week/ })).toBeEnabled()
    await askNextWeek()
    await expect.poll(async () => (await spaceDoc(SPACE_ID).get()).get('pause')).toMatchObject({ weekId: nextWeek, by: marcoUid, oks: [marcoUid] })
    await expect(section(lena, 'Pause next week?')).toContainText('1 of 3 said OK')
  })

  await test.step('Cancel Request removes the card for everyone, and the wait starts again', async () => {
    await back(marco)
    const card = section(marco, 'Pause next week?')
    await expect(card).toContainText('Waiting for Lena and Sam.')
    await snap(marco, 'b2-17-pause-asked')
    await card.getByRole('button', { name: 'Cancel Request', exact: true }).click()
    await answer(marco, 'Cancel Request')
    await expect.poll(async () => (await spaceDoc(SPACE_ID).get()).get('pause.declinedBy')).toBe(marcoUid)
    for (const page of [marco, lena, sam]) await expect(page.getByText('Pause next week?', { exact: true }).filter({ visible: true })).toHaveCount(0)
    await openSettings(marco)
    await expect(shown(marco, 'You asked not long ago.')).toBeVisible()
  })

  await closeAll(browser, a, b, c)
})

test('pause: a finished month with a paused week, and a paused last week whose monthly lists are reviewed', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [marcoUid, lenaUid] = await accounts(t0 - 120 * DAY, MARCO, LENA)
  const members = [marcoUid, lenaUid]
  const { real, next } = realMonths(t0)
  // A finished month (the one before the real one), every week in the real past.
  const past = addMonths(real, -1)
  const pastWeeks = weekIdsInMonth(past)
  const pausedWeek = pastWeeks[1]
  // The month after the real one, whose last week is paused (seeded) while its lists are reviewed.
  const lastWeek = lastWeekOf(next)
  await seedSpace(members, t0 - 100 * DAY, { paused: { [past]: pausedWeek, [next]: lastWeek } })
  for (const weekId of pastWeeks) {
    const paused = weekId === pausedWeek
    // In the paused week Lena skipped her reviews and Marco gave her nothing: none of it counts.
    await setPlayedWeek(SPACE_ID, weekId, weekBounds(weekId, TZ), { [marcoUid]: MARCO_TASKS, [lenaUid]: LENA_TASKS }, paused ? { skip: [lenaUid], marks: { [lenaUid]: 0 } } : {})
  }
  // Next month's last week and its lists: the stored list window is open in real time (the server judges the
  // submit by it) and still open at the phone's Friday of that week.
  const bounds = (w: string) => weekBounds(w, TZ)
  const nextWeeks = weekIdsInMonth(next)
  await setWeek(SPACE_ID, lastWeek, { ...bounds(lastWeek), members, submittedBy: [] })
  await setMonthly(SPACE_ID, next, {
    startAt: bounds(nextWeeks[0]).startAt,
    lockAt: bounds(nextWeeks[1]).lockAt,
    reviewOpenAt: t0 - HOUR,
    deadlineAt: bounds(lastWeek).deadlineAt,
    members,
    judges: [],
    submittedBy: [],
  })
  const MARCO_LIST: SeedTask[] = [
    { id: 'mm1', title: 'Finish the documentary cut' },
    { id: 'mm2', title: 'Run a half marathon' },
  ]
  await setMonthlyPlan(SPACE_ID, next, marcoUid, MARCO_LIST, t0 - DAY)

  const b = await phone(browser)
  const lena = b.page

  await test.step('The finished month: the paused week reads Paused and is left out, with no late points', async () => {
    await signIn(lena, LENA)
    await openSpace(lena)
    await showMonth(lena, past)
    await expect(lena.locator('.s-month-switch__sub')).toHaveText('Final')
    await expect(lena.locator('.s-month-hero')).toContainText(`${pastWeeks.length - 1} weeks scored · 1 paused`)
    await expect(lena.locator('.s-hero-score')).toHaveText('100%')
    await expect(weekRow(lena, pausedWeek)).toContainText('Paused')
    await expect(lena.getByText(/missed review/).filter({ visible: true })).toHaveCount(0)
    await centerOn(weekRow(lena, pausedWeek))
    await snap(lena, 'b2-18-month-paused-week')
  })

  await test.step('That week, opened from the month, was paused: nothing to review in it', async () => {
    // No toolbar or card opens a paused week's review sheet (SPEC §9.3: no Review toolbar), so its "There’s
    // nothing to review." state can't be reached from the UI; the week itself says why.
    await weekRow(lena, pausedWeek).click()
    await expect(section(lena, 'This week was paused')).toContainText(`Nothing counted, and it’s left out of ${monthName(past)}’s average.`)
    await expect(lena.getByRole('button', { name: /^Review / })).toHaveCount(0)
    await snap(lena, 'b2-19-week-was-paused')
    await back(lena)
  })

  await test.step('A paused last week: Review the Lists opens the monthly sections, and Submit goes through', async () => {
    await travel(lena, on(lastWeek, 4, 10))
    await openSpace(lena)
    await expect(weekHead(lena)).toContainText('Paused')
    const card = section(lena, 'This week is paused')
    await expect(card).toContainText(`Review the ${monthName(next)} Lists`)
    await expect(card).toContainText('No points this week, just the monthly lists.')
    await expect(lena.getByRole('button', { name: 'Review Marco', exact: true })).toBeVisible()
    await snap(lena, 'b2-20-paused-last-week')
    await card.getByRole('button', { name: new RegExp(`Review the ${monthName(next)} Lists`) }).click()
    const review = sheet(lena)
    await expect(shown(review, `${monthName(next)} list`, true)).toBeVisible()
    await expect(review.getByText('This week', { exact: true })).toHaveCount(0)
    await mark(review, MARCO_LIST[0].title, 'Done')
    await mark(review, MARCO_LIST[1].title, 'Not done')
    await snap(lena, 'b2-21-review-monthly-only')
    await review.getByRole('button', { name: 'Submit Reviews', exact: true }).click()
    await answer(lena, 'Submit')
    await expect(shown(review, 'Reviews in.')).toBeVisible()
    await expect.poll(async () => (await monthlyDoc(SPACE_ID, next).collection('reviews').doc(`${lenaUid}_${marcoUid}`).get()).get('marks')).toEqual({ mm1: 1, mm2: 0 })
    expect((await monthlyDoc(SPACE_ID, next).get()).get('submittedBy')).toEqual([lenaUid])
  })

  await closeAll(browser, b)
})

// =====================================================================================================
// 3. Judges, 4. switching role (SPEC §9.4)
// =====================================================================================================

test('a judge joins, rates everyone (the reveal waits for her), and a skipped week reads Didn’t review', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [lenaUid, samUid, anaUid] = await accounts(t0 - 60 * DAY, LENA, SAM, ANA)
  await seedSpace([lenaUid, samUid], t0 - 50 * DAY)
  const thisWeek = weekIdFor(t0, TZ)
  const nextWeek = addWeeks(thisWeek, 1)
  const lastWeek = addWeeks(thisWeek, -1)
  await setWeek(SPACE_ID, nextWeek, { ...weekBounds(nextWeek, TZ), members: [lenaUid, samUid], submittedBy: [] })

  const a = await phone(browser)
  const l = await phone(browser)
  const [ana, lena] = [a.page, l.page]

  await test.step('Ana joins with Only Rate Friends: she judges from the next week that hasn’t locked', async () => {
    await joinWithCode(ana, ANA, { judge: true })
    await expect.poll(async () => (await spaceDoc(SPACE_ID).get()).get('judges')).toEqual([anaUid])
    await expect.poll(async () => (await weekDoc(SPACE_ID, nextWeek).get()).get('judges')).toEqual([anaUid])
    expect((await weekDoc(SPACE_ID, nextWeek).get()).get('members')).toContain(anaUid)
  })

  // The review has to happen in real time (the server checks the window), so this week stands in for the week
  // Ana joined before: she is in it as a judge, it has locked, and its reviews open tomorrow. The week before
  // she judged too, and never reviewed.
  const natural = weekBounds(thisWeek, TZ)
  await spaceDoc(SPACE_ID).update({ [`joinedAt.${anaUid}`]: ts(weekBounds(lastWeek, TZ).startAt - DAY) })
  await setWeek(SPACE_ID, thisWeek, {
    startAt: Math.min(natural.startAt, t0 - 2 * DAY),
    lockAt: t0 - DAY,
    reviewOpenAt: t0 + DAY,
    deadlineAt: t0 + 2 * DAY,
    members: [lenaUid, samUid, anaUid],
    submittedBy: [],
    judges: [anaUid],
  })
  await setPlan(SPACE_ID, thisWeek, lenaUid, LENA_TASKS, t0 - 3 * DAY)
  await setPlan(SPACE_ID, thisWeek, samUid, SAM_TASKS, t0 - 3 * DAY)
  await setPlayedWeek(SPACE_ID, lastWeek, weekBounds(lastWeek, TZ), { [lenaUid]: LENA_TASKS, [samUid]: SAM_TASKS }, { judges: [anaUid], skip: [anaUid] })

  await test.step('This week Ana is judging: her week and her Spaces card say so', async () => {
    await travel(ana, null)
    await expect(ana.getByRole('button', { name: new RegExp(SPACE.name) }).first()).toContainText('Judging this week')
    await snap(ana, 'b2-22-spaces-judging', 1000)
    await openSpace(ana)
    await expect(section(ana, 'You’re judging this week')).toContainText('You rate everyone on review day. No list, no score.')
    await expect(ana.getByLabel('New task')).toHaveCount(0)
    await snap(ana, 'b2-23-week-judge')
  })

  // Review day: Lena and Sam have reviewed each other; the reveal waits for Ana.
  const t1 = Date.now()
  await weekDoc(SPACE_ID, thisWeek).update({ reviewOpenAt: ts(t1 - 2 * HOUR), deadlineAt: ts(t1 + 6 * HOUR), submittedBy: [lenaUid, samUid] })
  await setReview(SPACE_ID, thisWeek, lenaUid, samUid, { s1: 1, s2: 1 }, t1 - HOUR)
  await setReview(SPACE_ID, thisWeek, samUid, lenaUid, { l1: 1, l2: 0.5 }, t1 - HOUR)

  await test.step('Lena has submitted, but the results wait for the judge', async () => {
    await signIn(lena, LENA)
    await openSpace(lena)
    await expect(shown(lena, 'Submitted. Waiting for 1')).toBeVisible()
    await expect(weekHead(lena)).toContainText('Reviews due in')
    await expect(judgesSection(lena)).toContainText('Still reviewing')
  })

  await test.step('Ana reviews Lena and Sam, and the week is revealed', async () => {
    const cta = ana.getByRole('button', { name: 'Review Lena and Sam', exact: true })
    await expect(cta).toBeVisible()
    await cta.click()
    const review = sheet(ana)
    await mark(review, LENA_TASKS[0].title, 'Done')
    await mark(review, LENA_TASKS[1].title, 'Done')
    await review.getByRole('button', { name: 'Next: Sam', exact: true }).click()
    await mark(review, SAM_TASKS[0].title, 'Done')
    await mark(review, SAM_TASKS[1].title, 'Half')
    await review.getByRole('button', { name: 'Submit Reviews', exact: true }).click()
    await answer(ana, 'Submit')
    await expect(shown(review, 'Everyone’s in. Results are live.')).toBeVisible()
    await review.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(weekHead(lena)).toContainText('Results are in')
    expect((await weekDoc(SPACE_ID, thisWeek).get()).get('submittedBy')).toEqual([lenaUid, samUid, anaUid])
  })

  const lastMonth = monthIdForWeek(lastWeek)

  await test.step('The week she skipped: the Judges list says Didn’t review', async () => {
    await showMonth(lena, lastMonth)
    await weekRow(lena, lastWeek).click()
    const judges = judgesSection(lena)
    await expect(judges).toContainText(ANA.name)
    await expect(judges).toContainText('Didn’t review')
    await snap(lena, 'b2-24-judges-didnt-review')
  })

  await test.step('Her month: a judge, with no score', async () => {
    await showMonth(ana, lastMonth)
    await expect(ana.locator('.s-month-hero')).toContainText('Judge · no score this month')
    await snap(ana, 'b2-25-month-judge-only')
  })

  await closeAll(browser, a, l)
})

test('switching to judge during a locked week starts with the next week', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [marcoUid, lenaUid] = await accounts(t0 - 40 * DAY, MARCO, LENA)
  const members = [marcoUid, lenaUid]
  await seedSpace(members, t0 - 30 * DAY)
  const thisWeek = weekIdFor(t0, TZ)
  const nextWeek = addWeeks(thisWeek, 1)
  // This week has locked (seeded mid-week) with Marco playing.
  await setWeek(SPACE_ID, thisWeek, { startAt: t0 - 2 * DAY, lockAt: t0 - DAY, reviewOpenAt: t0 + DAY, deadlineAt: t0 + 2 * DAY, members, submittedBy: [] })
  await setPlan(SPACE_ID, thisWeek, marcoUid, MARCO_TASKS, t0 - 2 * DAY)
  await setPlan(SPACE_ID, thisWeek, lenaUid, LENA_TASKS, t0 - 2 * DAY)
  await setWeek(SPACE_ID, nextWeek, { ...weekBounds(nextWeek, TZ), members, submittedBy: [] })

  const a = await phone(browser)
  const marco = a.page

  await test.step('Marco turns on Only Rate Friends: still playing this week, judging from next week', async () => {
    await signIn(marco, MARCO)
    await openSpace(marco)
    await openSettings(marco)
    await expect(shown(marco, 'Judges rate everyone each week, with no list, no score and nothing owed.')).toBeVisible()
    await marco.getByRole('switch', { name: 'Only Rate Friends' }).click()
    const alert = marco.getByRole('alertdialog')
    await expect(alert).toContainText(`Only rate from the week of ${weekLabel(nextWeek)}?`)
    await expect(alert).toContainText('You’ll rate everyone each week, with no list, no score and nothing owed.')
    await snap(marco, 'b2-26-judge-confirm', 400)
    await answer(marco, 'Only Rate')
    await expect(shown(marco, `This week you’re still playing; you judge from the week of ${weekLabel(nextWeek)}.`, false)).toBeVisible()
    await expect(marco.getByRole('switch', { name: 'Only Rate Friends' })).toBeChecked()
    await expect.poll(async () => (await spaceDoc(SPACE_ID).get()).get('judges')).toEqual([marcoUid])
    await expect.poll(async () => (await weekDoc(SPACE_ID, nextWeek).get()).get('judges')).toEqual([marcoUid])
    // The locked week keeps the role it locked with.
    expect((await weekDoc(SPACE_ID, thisWeek).get()).get('judges')).toBeUndefined()
    await snap(marco, 'b2-27-settings-role')
  })

  await test.step('Next week the list editor is gone', async () => {
    await back(marco)
    await viewTab(marco, 'This Week').click()
    await expect(shown(marco, MARCO_TASKS[0].title, true)).toBeVisible()
    await viewTab(marco, 'Next Week').click()
    await expect(shown(marco, /^You’re judging (next|this) week$/)).toBeVisible()
    await expect(marco.getByLabel('New task')).toHaveCount(0)
    await expect(marco.getByRole('button', { name: 'Add Task with Steps' })).toHaveCount(0)
    await snap(marco, 'b2-28-next-week-judge')
  })

  await closeAll(browser, a)
})

// =====================================================================================================
// 5. Monthly lists (SPEC §9.5)
// =====================================================================================================

test('a monthly list: planned in the first week, locked, ticked, reviewed in the last week, counted as a week', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [lenaUid, samUid] = await accounts(t0 - 60 * DAY, LENA, SAM)
  const members = [lenaUid, samUid]
  await seedSpace(members, t0 - 50 * DAY)
  const { next: month } = realMonths(t0)
  const weeks = weekIdsInMonth(month)
  const last = weeks[weeks.length - 1]
  const bounds = (w: string) => weekBounds(w, TZ)
  // The month's weeks: every week but the last played and reviewed (100% each); the last one planned.
  for (const weekId of weeks.slice(0, -1)) await setPlayedWeek(SPACE_ID, weekId, bounds(weekId), { [lenaUid]: LENA_TASKS, [samUid]: SAM_TASKS })
  await setWeek(SPACE_ID, last, { ...bounds(last), members, submittedBy: [] })
  await setPlan(SPACE_ID, last, lenaUid, LENA_TASKS, bounds(last).startAt)
  await setPlan(SPACE_ID, last, samUid, SAM_TASKS, bounds(last).startAt)
  // The month's list, on the stored weeks' times.
  await setMonthly(SPACE_ID, month, {
    startAt: bounds(weeks[0]).startAt,
    lockAt: bounds(weeks[1]).lockAt,
    reviewOpenAt: bounds(last).reviewOpenAt,
    deadlineAt: bounds(last).deadlineAt,
    members,
    judges: [],
    submittedBy: [],
  })
  const RUN = 'Run a half marathon'
  const FILM = { title: 'Ship the short film', steps: ['Picture lock', 'Sound mix'] }
  const listPath = `spaces/${SPACE_ID}/monthly/${month}/plans/${lenaUid}`
  const M = monthName(month)

  const l = await phone(browser)
  const s = await phone(browser)
  const [lena, sam] = [l.page, s.page]

  const openList = async () => {
    await openSpace(lena)
    await lena.getByRole('button', { name: new RegExp(`^Your ${M} list`) }).click()
    await expect(lena.getByRole('heading', { name: `${M} List`, exact: true })).toBeVisible()
  }

  await test.step('In the month’s first week Lena plans her list: one task, and one with steps', async () => {
    await signIn(lena, LENA, on(weeks[0], 2, 12))
    await openSpace(lena)
    await expect(lena.getByRole('button', { name: new RegExp(`^Your ${M} list`) })).toContainText(`Optional: a few bigger things for ${M}.`)
    await centerOn(lena.getByRole('button', { name: new RegExp(`^Your ${M} list`) }))
    await snap(lena, 'b2-29-monthly-card-planning')
    await lena.getByRole('button', { name: new RegExp(`^Your ${M} list`) }).click()
    await expect(lena.getByRole('heading', { name: `${M} List`, exact: true })).toBeVisible()
    await addTasks(lena, [RUN])
    await lena.getByRole('button', { name: 'Add Task with Steps', exact: true }).click()
    const form = sheet(lena)
    await form.getByLabel('Title', { exact: true }).fill(FILM.title)
    await form.getByLabel('Title', { exact: true }).press('Enter')
    for (const [i, step] of FILM.steps.entries()) {
      const field = form.getByLabel(`Step ${i + 1}`, { exact: true })
      await field.fill(step)
      if (i < FILM.steps.length - 1) await field.press('Enter')
    }
    // A monthly task has no revenue switch.
    await expect(form.getByRole('switch', { name: 'Generates revenue' })).toHaveCount(0)
    await form.getByRole('button', { name: 'Done', exact: true }).click()
    await expect.poll(() => planOf(listPath)).toEqual([RUN, FILM.title])
    const tasks = (await db.doc(listPath).get()).get('tasks') as SeedTask[]
    expect(tasks[1].subs?.map((sub) => sub.slice(sub.indexOf('|') + 1))).toEqual(FILM.steps)
    expect((await db.doc(listPath).get()).get('added')).toBeUndefined()
    await snap(lena, 'b2-30-monthly-planning')
  })

  await test.step('After the list locks she can’t add to it', async () => {
    await travel(lena, on(weeks[1], 2, 12))
    await openSpace(lena)
    await expect(lena.getByRole('button', { name: new RegExp(`^Your ${M} list`) })).toContainText('0 of 2 done')
    await centerOn(lena.getByRole('button', { name: new RegExp(`^Your ${M} list`) }))
    await snap(lena, 'b2-29b-monthly-card-locked')
    await lena.getByRole('button', { name: new RegExp(`^Your ${M} list`) }).click()
    await expect(lena.getByRole('heading', { name: `${M} List`, exact: true })).toBeVisible()
    await expect(shown(lena, RUN, true)).toBeVisible()
    await expect(lena.getByLabel('New task')).toHaveCount(0)
    await expect(lena.getByRole('button', { name: /^Add Task/ })).toHaveCount(0)
    await expect(shown(lena, `Counts as one extra week in your ${M} score. Friends review it in ${M}’s last week.`)).toBeVisible()
    await snap(lena, 'b2-31-monthly-locked')
  })

  await test.step('In week 3 she ticks one off', async () => {
    await travel(lena, on(weeks[2], 2, 12))
    await openList()
    const run = lena.getByRole('checkbox', { name: RUN, exact: true })
    await run.click()
    await expect(run).toBeChecked()
    const runId = ((await db.doc(listPath).get()).get('tasks') as SeedTask[])[0].id
    await expect.poll(async () => (await db.doc(`spaces/${SPACE_ID}/monthly/${month}/progress/${lenaUid}`).get()).get('done')).toEqual({ [runId]: true })
  })

  // Review day of the month's last week. Lena has already reviewed Sam's week.
  const t1 = Date.now()
  await weekDoc(SPACE_ID, last).update({ submittedBy: [lenaUid] })
  await monthlyDoc(SPACE_ID, month).update({ submittedBy: [lenaUid] })
  await setReview(SPACE_ID, last, lenaUid, samUid, { s1: 1, s2: 1 }, t1 - HOUR)

  await test.step('In the last week Sam reviews Lena’s week and her list in one go', async () => {
    await signIn(sam, SAM, on(last, 4, 10))
    await openSpace(sam)
    await centerOn(sam.getByRole('button', { name: new RegExp(`^${M} lists`) }))
    await snap(sam, 'b2-29c-monthly-card-friends')
    // The server judges both submits by the real clock: open the stored windows (the week's and the list's) in
    // real time too, after the Space screen's shots (they'd read "This week’s times are off").
    await weekDoc(SPACE_ID, last).update({ reviewOpenAt: ts(Date.now() - HOUR) })
    await monthlyDoc(SPACE_ID, month).update({ reviewOpenAt: ts(Date.now() - HOUR) })
    await sam.getByRole('button', { name: 'Review Lena', exact: true }).click()
    const review = sheet(sam)
    await expect(shown(review, 'This week', true)).toBeVisible()
    await expect(shown(review, `${M} list`, true)).toBeVisible()
    await snap(sam, 'b2-32a-review-two-parts-top')
    await mark(review, LENA_TASKS[0].title, 'Done')
    await mark(review, LENA_TASKS[1].title, 'Done')
    await mark(review, RUN, 'Done')
    await mark(review, FILM.title, 'Half')
    await snap(sam, 'b2-32-review-two-parts')
    await review.getByRole('button', { name: 'Submit Reviews', exact: true }).click()
    await answer(sam, 'Submit')
    await expect(shown(review, 'Reviews in.')).toBeVisible()
    await expect.poll(async () => (await weekDoc(SPACE_ID, last).collection('reviews').doc(`${samUid}_${lenaUid}`).get()).exists).toBe(true)
    await expect.poll(async () => (await monthlyDoc(SPACE_ID, month).collection('reviews').doc(`${samUid}_${lenaUid}`).get()).exists).toBe(true)
  })

  await test.step('After the deadline her month counts the list as one more week', async () => {
    await travel(lena, on(addWeeks(last, 1), 0, 10))
    await openSpace(lena)
    await showMonth(lena, month)
    await expect(lena.locator('.s-month-switch__sub')).toHaveText('Final')
    await expect(lena.locator('.s-month-hero')).toContainText(`${weeks.length} weeks + ${M} list scored`)
    // Every week 100%, the list 75% (Done + Half): the list is one more week in the average.
    const average = Math.floor((100 * weeks.length + 75) / (weeks.length + 1) + 1e-6)
    await expect(lena.locator('.s-hero-score')).toHaveText(`${average}%`)
    await expect(lena.getByRole('button', { name: new RegExp(`^${M} list`) }).filter({ visible: true }).first()).toContainText('75%')
    await snap(lena, 'b2-33-month-with-list')
    await centerOn(lena.getByRole('button', { name: new RegExp(`^${M} list`) }).filter({ visible: true }).first())
    await snap(lena, 'b2-33b-month-list-row')
  })

  await closeAll(browser, l, s)
})

// =====================================================================================================
// 6–8. Per-person stakes, when they count, the house stakes (SPEC §9.7)
// =====================================================================================================

test('stakes per line: a group reward, a penalty per friend and a streak reward, agreed friend by friend', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [marcoUid, lenaUid, samUid] = await accounts(t0 - 60 * DAY, MARCO, LENA, SAM)
  await seedSpace([marcoUid, lenaUid, samUid], t0 - 50 * DAY, { joinedAt: { [lenaUid]: t0 - 49 * DAY, [samUid]: t0 - 48 * DAY } })
  // Mid-month on every phone (the month after the real one), so every "counts now" means now.
  const { next: month } = realMonths(t0)
  const midMonth = on(weekIdsInMonth(month)[1], 2, 12)

  const a = await phone(browser)
  const b = await phone(browser)
  const c = await phone(browser)
  const [marco, lena, sam] = [a.page, b.page, c.page]

  const openStakes = async (page: Page) => {
    await stakesCard(page).getByRole('button', { name: /they owe you/ }).click()
    await expect(stakesHeading(page)).toBeVisible()
  }
  const editor = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Your Stakes' }) })
  const marcoSection = (page: Page) => section(page, 'Marco hits 90%, you owe')

  await test.step('Marco sets a reward for everyone, a penalty per friend and a 3-month streak reward', async () => {
    await signIn(marco, MARCO, midMonth)
    await openSpace(marco)
    await expect(stakesCard(marco)).toContainText(SPACE.reward)
    await expect(stakesCard(marco)).toContainText('Same stakes for everyone, for now.')
    await openStakes(marco)
    await marco.getByRole('button', { name: 'Edit', exact: true }).click()
    const form = editor(marco)
    await expect(form.getByRole('radiogroup', { name: 'Reward' }).getByRole('radio', { name: 'Same for Everyone' })).toBeChecked()
    await form.getByLabel('What they owe you').fill('Dinner, on you')
    await form.getByRole('radiogroup', { name: 'Penalty' }).getByRole('radio', { name: 'Different per Friend' }).click()
    await form.getByLabel('You owe Lena…').fill('A coffee')
    await form.getByLabel('You owe Sam…').fill('A beer')
    await form.getByRole('button', { name: 'Add Streak Reward' }).click()
    await marco.getByRole('dialog', { name: 'How many months in a row?' }).getByRole('button', { name: '3 months', exact: true }).click()
    await form.getByLabel('Reward for 3 months in a row').fill('Weekend away')
    await snap(marco, 'b2-34-editor-mixed')
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(toast(marco, 'Saved')).toContainText('Counts as soon as Lena and Sam agree.')
    await expect
      .poll(async () => (await db.doc(`spaces/${SPACE_ID}/stakes/${marcoUid}`).get()).data())
      .toMatchObject({
        rewardMode: 'group',
        penaltyMode: 'each',
        reward: 'Dinner, on you',
        per: { [lenaUid]: { penalty: 'A coffee' }, [samUid]: { penalty: 'A beer' } },
        tiers: [{ months: 3, reward: 'Weekend away' }],
        agreed: {},
      })
    await back(marco)
    // Nothing counts yet: the house stakes, and what's pending.
    await expect(stakesCard(marco)).toContainText(SPACE.reward)
    await expect(stakesCard(marco)).toContainText(SPACE.penalty)
    await expect(stakesCard(marco)).toContainText('Your new stakes: waiting for Lena and Sam to agree')
    await snap(marco, 'b2-35-card-waiting')
  })

  await test.step('Lena takes a look and agrees: her own penalty counts now, the shared part waits for Sam', async () => {
    await signIn(lena, LENA, midMonth)
    await openSpace(lena)
    await expect(stakesCard(lena)).toContainText('New stakes from Marco')
    await snap(lena, 'b2-36-card-new-stakes')
    await stakesCard(lena).getByRole('button', { name: /Take a Look/ }).click()
    await expect(stakesHeading(lena)).toBeVisible()
    await expect(marcoSection(lena)).toBeInViewport()
    await marcoSection(lena).getByRole('button', { name: 'Agree to Marco’s Stakes' }).click()
    const alert = lena.getByRole('alertdialog')
    await expect(alert).toContainText('Agree to Marco’s stakes?')
    await expect(alert).toContainText('Marco hits 90%: you all owe “Dinner, on you”, together.')
    await expect(alert).toContainText('If Marco misses, you get “A coffee”.')
    await expect(alert).toContainText('3 months in a row: you all owe “Weekend away”, together.')
    await expect(alert).toContainText('Your own part counts right away, the shared part once Sam agrees too.')
    await snap(lena, 'b2-37-agree-partly', 400)
    await answer(lena, 'Agree')
    await expect(toast(lena, 'You agreed to Marco’s stakes')).toContainText('Part counts now, the rest once Sam agrees.')
    await expect(stakesCard(marco)).toContainText(`Lena: A coffee · Sam: ${SPACE.penalty}`)
    await expect(stakesCard(marco)).toContainText(SPACE.reward)
    await expect(stakesCard(marco)).toContainText('Your new stakes: waiting for Sam to agree')
  })

  await test.step('Sam agrees: it all counts, live on Marco’s card', async () => {
    await signIn(sam, SAM, midMonth)
    await openSpace(sam)
    await stakesCard(sam).getByRole('button', { name: /Take a Look/ }).click()
    await marcoSection(sam).getByRole('button', { name: 'Agree to Marco’s Stakes' }).click()
    await expect(sam.getByRole('alertdialog')).toContainText('They count right away.')
    await answer(sam, 'Agree')
    await expect(toast(sam, 'You agreed to Marco’s stakes')).toContainText('They count now.')
    await expect(stakesCard(marco)).toContainText('Dinner, on you')
    await expect(stakesCard(marco)).toContainText('Lena: A coffee · Sam: A beer')
    await expect(stakesCard(marco)).toContainText('Everyone agreed')
    await snap(marco, 'b2-38-card-everyone-agreed')
  })

  await test.step('Marco changes only Lena’s penalty: it counts with Lena’s Agree alone', async () => {
    await openStakes(marco)
    await marco.getByRole('button', { name: 'Edit', exact: true }).click()
    const form = editor(marco)
    await form.getByLabel('You owe Lena…').fill('Two coffees')
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(toast(marco, 'Saved')).toContainText('Counts as soon as Lena agrees.')
    await back(marco)
    await expect(stakesCard(marco)).toContainText('Lena: A coffee · Sam: A beer')
    await expect(stakesCard(marco)).toContainText('Your new stakes: waiting for Lena to agree')
    await marcoSection(lena).getByRole('button', { name: 'Agree to Marco’s Stakes' }).click()
    await expect(lena.getByRole('alertdialog')).toContainText('They count right away.')
    await answer(lena, 'Agree')
    await expect(toast(lena, 'You agreed to Marco’s stakes')).toContainText('They count now.')
    await expect(stakesCard(marco)).toContainText('Lena: Two coffees · Sam: A beer')
    await expect(stakesCard(marco)).toContainText('Everyone agreed')
  })

  await closeAll(browser, a, b, c)
})

test('an agreed change counts at once; a finished month keeps its terms', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [marcoUid, lenaUid, samUid] = await accounts(t0 - 90 * DAY, MARCO, LENA, SAM)
  const members = [marcoUid, lenaUid, samUid]
  await seedSpace(members, t0 - 80 * DAY)
  const { real: previous, next: month } = realMonths(t0)
  const bounds = (w: string) => weekBounds(w, TZ)
  const plans = { [marcoUid]: MARCO_TASKS, [lenaUid]: LENA_TASKS, [samUid]: SAM_TASKS }

  // The previous month (the real one) is complete: its last week's stored deadline was two days ago. Everyone
  // played and passed. No results doc yet.
  const prevWeeks = weekIdsInMonth(previous)
  for (const weekId of prevWeeks.slice(0, -1)) await setPlayedWeek(SPACE_ID, weekId, bounds(weekId), plans)
  await setPlayedWeek(SPACE_ID, prevWeeks[prevWeeks.length - 1], { startAt: t0 - 8 * DAY, lockAt: t0 - 7 * DAY, reviewOpenAt: t0 - 3 * DAY, deadlineAt: t0 - 2 * DAY }, plans)
  // This month: every week played and reviewed (everyone passes); its last week (seeded) is due after the
  // phone's mid-month.
  const weeks = weekIdsInMonth(month)
  for (const weekId of weeks) await setPlayedWeek(SPACE_ID, weekId, bounds(weekId), plans)
  const lastWeek = weeks[weeks.length - 1]
  // Marco's stakes, agreed by both before the previous month was complete.
  const before: SeedStakes = { rewardMode: 'group', penaltyMode: 'group', reward: 'Lunch, on you', penalty: 'Breakfast for everyone', updatedAt: t0 - 4 * DAY }
  await setStakes(SPACE_ID, marcoUid, {
    ...before,
    agreed: { [lenaUid]: { at: t0 - 3 * DAY, terms: pairOf(before, lenaUid) }, [samUid]: { at: t0 - 3 * DAY, terms: pairOf(before, samUid) } },
  })

  const midMonth = on(weeks[2], 2, 12)
  const N = monthName(addMonths(month, 1))
  const M = monthName(month)

  const a = await phone(browser)
  const b = await phone(browser)
  const c = await phone(browser)
  const [marco, lena, sam] = [a.page, b.page, c.page]

  const editStakes = async (reward: string, penalty: string) => {
    await stakesCard(marco).getByRole('button', { name: /they owe you/ }).click()
    await marco.getByRole('button', { name: 'Edit', exact: true }).click()
    const form = marco.getByRole('dialog').filter({ has: marco.getByRole('heading', { name: 'Your Stakes' }) })
    await form.getByLabel('What they owe you').fill(reward)
    await form.getByLabel('What you owe them').fill(penalty)
    await form.getByRole('button', { name: 'Save', exact: true }).click()
  }
  const agree = async (page: Page, confirmText: string, toastText: string) => {
    await travelIfNeeded(page)
    await page.getByRole('button', { name: 'Agree to Marco’s Stakes' }).filter({ visible: true }).click()
    await expect(page.getByRole('alertdialog')).toContainText(confirmText)
    await answer(page, 'Agree')
    await expect(toast(page, 'You agreed to Marco’s stakes')).toContainText(toastText)
  }
  // Each friend agrees from the Stakes screen (opened on Marco's section from the card).
  const travelIfNeeded = async (page: Page) => {
    if (await stakesHeading(page).isVisible()) return
    await stakesCard(page).getByRole('button', { name: /Take a Look/ }).click()
    await expect(stakesHeading(page)).toBeVisible()
  }

  await test.step('Mid-month: the earlier agreement counts, and the finished month quotes it', async () => {
    await signIn(marco, MARCO, midMonth)
    await openSpace(marco)
    await expect(stakesCard(marco)).toContainText('Lunch, on you')
    await expect(stakesCard(marco)).toContainText('Breakfast for everyone')
    await expect(stakesCard(marco)).toContainText('Everyone agreed')
    await showMonth(marco, previous)
    await expect(marco.locator('.s-month-switch__sub')).toHaveText('Final')
    await expect(shown(marco, 'Lena and Sam owe you: Lunch, on you')).toBeVisible()
    await expect(marco.locator('.s-month-hero')).toContainText('You cleared the bar')
    await viewTab(marco, 'This Week').click()
  })

  await test.step('Marco changes his stakes; both agree; his card and Lena’s Stakes screen show it without a reload', async () => {
    await editStakes('Dinner, on you', 'Coffee for a week')
    await expect(toast(marco, 'Saved')).toContainText('Counts as soon as Lena and Sam agree.')
    await back(marco)
    await signIn(lena, LENA, midMonth)
    await openSpace(lena)
    await agree(lena, 'They count once Sam agrees too.', 'They count once Sam agrees too.')
    await signIn(sam, SAM, midMonth)
    await openSpace(sam)
    await agree(sam, 'They count right away.', 'They count now.')
    await expect(stakesCard(marco)).toContainText('Dinner, on you')
    await expect(stakesCard(marco)).toContainText('Coffee for a week')
    await expect(section(lena, 'Marco hits 90%, you owe')).toContainText('Dinner, on you')
  })

  await test.step('This month’s debt lines quote the new terms; the finished month still quotes its own', async () => {
    await showMonth(marco, month)
    await expect(shown(marco, 'Lena and Sam owe you: Dinner, on you')).toBeVisible()
    await showMonth(marco, previous)
    await expect(shown(marco, 'Lena and Sam owe you: Lunch, on you')).toBeVisible()
    await expect(marco.getByText('Lena and Sam owe you: Dinner, on you').filter({ visible: true })).toHaveCount(0)
    await expect(marco.locator('.s-month-hero')).toContainText('You cleared the bar')
    await centerOn(shown(marco, 'Lena and Sam owe you: Lunch, on you'))
    await snap(marco, 'b2-39-finished-month-keeps')
    await viewTab(marco, 'This Week').click()
  })

  // This month ends just after those agreements, as the server sees it.
  const agreedAt = async (uid: string) => ((await db.doc(`spaces/${SPACE_ID}/stakes/${marcoUid}`).get()).get(`agreed.${uid}.at`) as { toMillis(): number }).toMillis()
  const lastAgree = Math.max(await agreedAt(lenaUid), await agreedAt(samUid))
  await endMonthAt(SPACE_ID, lastWeek, month, lastAgree + 1000)
  const weekend = on(lastWeek, 5, 10)

  await test.step('The Saturday after the month’s last Friday: a new change counts from next month', async () => {
    for (const page of [marco, lena, sam]) await travel(page, weekend)
    await openSpace(marco)
    await editStakes('Pizza night, on you', 'Croissants for a week')
    await expect(toast(marco, 'Saved')).toContainText(`Counts from ${N}, as soon as Lena and Sam agree.`)
    await back(marco)
    await openSpace(sam)
    await agree(sam, `They count from ${N}, once Lena agrees too.`, `They count from ${N}, once Lena agrees too.`)
    await openSpace(lena)
    await agree(lena, `They count from ${N}. ${M} is final.`, `They count from ${N}.`)
    await expect(stakesCard(marco)).toContainText('Pizza night, on you')
    await expect(stakesCard(marco)).toContainText('Croissants for a week')
  })

  await test.step('The month that just ended keeps the terms it had', async () => {
    await showMonth(marco, month)
    await expect(marco.locator('.s-month-switch__sub')).toHaveText('Final')
    await expect(shown(marco, 'Lena and Sam owe you: Dinner, on you')).toBeVisible()
    await expect(marco.getByText(/owe you: Pizza night, on you/).filter({ visible: true })).toHaveCount(0)
    await centerOn(shown(marco, 'Lena and Sam owe you: Dinner, on you'))
    await snap(marco, 'b2-40-month-final-terms')
  })

  await closeAll(browser, a, b, c)
})

test('the house stakes: the owner’s edit counts at once (the early freeze doesn’t bind), and a finished month keeps its own', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [lenaUid, kimUid] = await accounts(t0 - 60 * DAY, LENA, KIM)
  const members = [lenaUid, kimUid]
  // Created this (UTC) month, so the rules only check the months since (SPEC §9.7, editsSpaceText).
  const now = new Date(t0)
  const created = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  await seedSpace(members, created)
  const { real: previous, next: month } = realMonths(t0)
  const bounds = (w: string) => weekBounds(w, TZ)
  // The previous month (the real one) is complete as the server sees it.
  await setWeek(SPACE_ID, lastWeekOf(previous), { startAt: t0 - 8 * DAY, lockAt: t0 - 7 * DAY, reviewOpenAt: t0 - 3 * DAY, deadlineAt: t0 - 2 * DAY, members, submittedBy: members })
  // This month: played and passed by both; the previous app froze its house stakes early (seeded before its
  // completion as the server will see it).
  const weeks = weekIdsInMonth(month)
  for (const weekId of weeks) await setPlayedWeek(SPACE_ID, weekId, bounds(weekId), { [lenaUid]: LENA_TASKS, [kimUid]: KIM_TASKS })
  await setMonthStakes(SPACE_ID, month, { reward: 'Pizza, on them', penalty: 'Gelato for everyone', createdAt: t0 - 2 * DAY })
  const midMonth = on(weeks[1], 2, 12)
  const M = monthName(month)
  const N = monthName(addMonths(month, 1))
  const FIRST = { reward: 'Lunch at the market, on them', penalty: 'Breakfast for everyone' }
  const SECOND = { reward: 'Pasta night, on them', penalty: 'Espresso for everyone' }

  const l = await phone(browser)
  const k = await phone(browser)
  const [lena, kim] = [l.page, k.page]

  const editHouse = async (s: { reward: string; penalty: string }) => {
    await lena.getByLabel('Reward', { exact: true }).fill(s.reward)
    await lena.getByLabel('Penalty', { exact: true }).fill(s.penalty)
    await lena.getByRole('button', { name: 'Save', exact: true }).click()
  }

  await test.step('Mid-month the owner changes the house stakes in Settings: they count now', async () => {
    await signIn(lena, LENA, midMonth)
    await openSpace(lena)
    await expect(stakesCard(lena)).toContainText(SPACE.reward)
    await expect(stakesCard(lena)).not.toContainText('Pizza, on them')
    await openSettings(lena)
    await expect(shown(lena, `They count between two friends until they agree on their own. Changes count right away, for ${M}.`)).toBeVisible()
    await snap(lena, 'b2-41-house-owner')
    await editHouse(FIRST)
    await expect(toast(lena, 'Saved')).toContainText('The new house stakes count now.')
    await snap(lena, 'b2-41b-house-saved-toast', 150, { width: 375, height: 812 })
    await expect.poll(async () => (await spaceDoc(SPACE_ID).get()).get('reward')).toBe(FIRST.reward)
    expect((await spaceDoc(SPACE_ID).get()).get('stakesNote.by')).toBe(lenaUid)
    // The finished previous month was frozen first, with the old stakes (when the rules check it).
    if (houseFreezeMonths({ createdAt: created }, midMonth).includes(previous)) {
      const frozen = await monthStakesDoc(SPACE_ID, previous).get()
      expect(frozen.get('reward')).toBe(SPACE.reward)
      expect((frozen.get('createdAt') as { toMillis(): number }).toMillis()).toBeGreaterThanOrEqual(t0 - 2 * DAY)
    }
    await back(lena)
    await expect(stakesCard(lena)).toContainText(FIRST.reward)
    await expect(stakesCard(lena)).toContainText(FIRST.penalty)
    await snap(lena, 'b2-41c-card-after-house-edit')
  })

  await test.step('Kim sees them on her card at once, with a notice that sticks once dismissed', async () => {
    // Kim's phone runs on the real clock, within the notice's 7 days.
    await signIn(kim, KIM)
    await openSpace(kim)
    await expect(stakesCard(kim)).toContainText(FIRST.reward)
    await expect(stakesCard(kim)).toContainText(FIRST.penalty)
    await expect(stakesCard(kim)).toContainText('Lena changed the house stakes')
    await snap(kim, 'b2-42-card-house-notice')
    await stakesCard(kim).getByRole('button', { name: 'Dismiss' }).click()
    await expect(stakesCard(kim)).not.toContainText('Lena changed the house stakes')
    await travel(kim, null)
    await openSpace(kim)
    await expect(stakesCard(kim)).toContainText(FIRST.reward)
    await expect(stakesCard(kim)).not.toContainText('Lena changed the house stakes')
  })

  await test.step('Kim sees them read-only in Settings, with Your Stakes', async () => {
    await openSettings(kim)
    await expect(kim.getByLabel('Reward', { exact: true })).toHaveCount(0)
    const house = section(kim, 'House stakes')
    await expect(house).toContainText(FIRST.reward)
    await expect(house).toContainText('Only Lena can change the house stakes. Set your own on the Stakes screen.')
    await snap(kim, 'b2-43-house-read-only')
    await kim.getByRole('button', { name: /^Your Stakes/ }).click()
    await expect(stakesHeading(kim)).toBeVisible()
  })

  // This month ends, as the server sees it.
  await endMonthAt(SPACE_ID, lastWeekOf(month), month, Date.now() - HOUR)
  const endedAt = Date.now() - HOUR

  await test.step('After the month’s last Friday the owner changes them again: the month is final with the first change', async () => {
    await travel(lena, on(lastWeekOf(month), 5, 10))
    await openSpace(lena)
    await openSettings(lena)
    await expect(shown(lena, `They count between two friends until they agree on their own. Changes count right away, for ${N}. ${M} is final.`)).toBeVisible()
    await editHouse(SECOND)
    await expect(toast(lena, 'Saved')).toContainText(`The new house stakes count from ${N}. ${M} is final.`)
    await expect.poll(async () => (await spaceDoc(SPACE_ID).get()).get('reward')).toBe(SECOND.reward)
    // The month was re-frozen with the stakes it ended with (the early freeze replaced, once).
    const frozen = await monthStakesDoc(SPACE_ID, month).get()
    expect(frozen.data()).toMatchObject(FIRST)
    expect((frozen.get('createdAt') as { toMillis(): number }).toMillis()).toBeGreaterThanOrEqual(endedAt - MINUTE)
    await back(lena)
    await expect(stakesCard(lena)).toContainText(SECOND.reward)
    await viewTab(lena, 'Month').click()
    await expect(lena.locator('.s-month-switch__title')).toContainText(formatMonth(month))
    await expect(lena.locator('.s-month-switch__sub')).toHaveText('Final')
    await expect(shown(lena, `Kim owes you: ${FIRST.reward}`)).toBeVisible()
    await expect(lena.getByText(`Kim owes you: ${SECOND.reward}`).filter({ visible: true })).toHaveCount(0)
    await centerOn(shown(lena, `Kim owes you: ${FIRST.reward}`))
    await snap(lena, 'b2-44-month-house-final')
  })

  await closeAll(browser, l, k)
})

// =====================================================================================================
// 9. Settling per pair (SPEC §9.7, §9.8)
// =====================================================================================================

test('settling per pair: a streak reward, a group line, a line owed to someone who left, and a legacy month', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [marcoUid, lenaUid, samUid, benUid] = await accounts(t0 - 120 * DAY, MARCO, LENA, SAM, BEN)
  const { real: month, next } = realMonths(t0)
  const older = addMonths(month, -1)
  const bounds = (w: string) => weekBounds(w, TZ)
  // The older month: everyone played its last week and passed; Ben left after it ended.
  const olderLast = lastWeekOf(older)
  const olderEnd = bounds(olderLast).deadlineAt
  await seedSpace([marcoUid, lenaUid, samUid], t0 - 100 * DAY, { leftAt: { [benUid]: olderEnd + HOUR } })
  // The space doc above has no Ben; he was a member until he left.
  await setPlayedWeek(SPACE_ID, olderLast, bounds(olderLast), { [marcoUid]: MARCO_TASKS, [lenaUid]: LENA_TASKS, [samUid]: SAM_TASKS, [benUid]: KIM_TASKS })
  // Lena marked Marco's month settled before batch 2 (one doc per member).
  await setSettlement(SPACE_ID, { monthId: older, uid: marcoUid, settled: true, settledBy: lenaUid, settledAt: olderEnd + DAY })
  await setResults(SPACE_ID, older, {
    completeAt: olderEnd,
    members: {
      [marcoUid]: { score: 100, passed: true, streak: 2, tierRuns: { '3': 2 } },
      [lenaUid]: { score: 100, passed: true, streak: 1 },
      [samUid]: { score: 100, passed: true, streak: 1 },
    },
    createdAt: olderEnd + HOUR,
  })
  // The month (the real one), complete as the server sees it: Marco and Lena passed, Sam scored 0.
  const monthEnd = t0 - DAY
  await setPlayedWeek(
    SPACE_ID,
    lastWeekOf(month),
    { startAt: t0 - 7 * DAY, lockAt: t0 - 6 * DAY, reviewOpenAt: t0 - 2 * DAY, deadlineAt: monthEnd },
    { [marcoUid]: MARCO_TASKS, [lenaUid]: LENA_TASKS, [samUid]: SAM_TASKS },
    { marks: { [samUid]: 0 } },
  )
  // Marco's stakes: a reward per friend and a 3-month streak reward, agreed by both before the month ended
  // (and after the older month did).
  const stakes: SeedStakes = {
    rewardMode: 'each',
    penaltyMode: 'group',
    reward: '',
    penalty: SPACE.penalty,
    per: { [lenaUid]: { reward: 'Lunch', penalty: '' }, [samUid]: { reward: 'A movie', penalty: '' } },
    tiers: [{ months: 3, reward: 'Weekend away' }],
    updatedAt: monthEnd - 4 * HOUR,
  }
  const agreedAt = monthEnd - 2 * HOUR
  await setStakes(SPACE_ID, marcoUid, { ...stakes, agreed: { [lenaUid]: { at: agreedAt, terms: pairOf(stakes, lenaUid) }, [samUid]: { at: agreedAt, terms: pairOf(stakes, samUid) } } })

  const a = await phone(browser)
  const marco = a.page
  const settledDoc = async (m: string, uid: string, other?: string, tier?: number) => (await settlementDoc(SPACE_ID, m, uid, other, tier).get()).data()

  await test.step('The finished month: Lena owes Marco lunch, and his third month in a row brings the streak reward', async () => {
    await signIn(marco, MARCO, on(weekIdsInMonth(next)[1], 2, 12))
    await openSpace(marco)
    await viewTab(marco, 'Month').click()
    await marco.getByRole('button', { name: 'Previous month' }).click()
    await expect(marco.locator('.s-month-switch__title')).toContainText(formatMonth(month))
    await expect(marco.locator('.s-month-switch__sub')).toHaveText('Final')
    await expect(marco.locator('.s-month-hero')).toContainText('3 months in a row')
    await expect(shown(marco, 'Lena owes you: Lunch', true)).toBeVisible()
    await expect(shown(marco, 'Sam owes you: A movie', true)).toBeVisible()
    const tier = marco.getByRole('checkbox', { name: 'Settled: Lena and Sam owe you: Weekend away', exact: true })
    await expect(tier).toBeVisible()
    await expect(shown(marco, /^3 months in a row · Together/)).toBeVisible()
    await centerOn(shown(marco, 'Lena owes you: Lunch', true))
    await snap(marco, 'b2-45-month-debt-lines')
    await marco.getByRole('checkbox', { name: 'Settled: Lena owes you: Lunch', exact: true }).click()
    await tier.click()
    await expect.poll(() => settledDoc(month, marcoUid, lenaUid)).toMatchObject({ monthId: month, uid: marcoUid, other: lenaUid, settled: true, settledBy: marcoUid })
    await expect.poll(() => settledDoc(month, marcoUid, lenaUid, 3)).toMatchObject({ uid: marcoUid, other: lenaUid, tier: 3, settled: true })
    await expect.poll(() => settledDoc(month, marcoUid, samUid, 3)).toMatchObject({ uid: marcoUid, other: samUid, tier: 3, settled: true })
    // Sam's own reward line to Marco is still open.
    expect(await settledDoc(month, marcoUid, samUid)).toBeUndefined()
  })

  await test.step('A group penalty line: one tap marks both pairs', async () => {
    const line = marco.getByRole('checkbox', { name: `Settled: Sam owes you and Lena: ${SPACE.penalty}`, exact: true })
    await expect(line).toBeEnabled()
    await line.click()
    await expect(line).toBeChecked()
    await expect.poll(() => settledDoc(month, samUid, marcoUid)).toMatchObject({ uid: samUid, other: marcoUid, settled: true, settledBy: marcoUid })
    await expect.poll(() => settledDoc(month, samUid, lenaUid)).toMatchObject({ uid: samUid, other: lenaUid, settled: true, settledBy: marcoUid })
  })

  await test.step('The older month: the legacy doc settles Marco’s line, and a line owed to Ben, who left, is the debtors’ to mark', async () => {
    await marco.getByRole('button', { name: 'Previous month' }).click()
    await expect(marco.locator('.s-month-switch__title')).toContainText(formatMonth(older))
    // Marco's own house line (Lena, Sam and Ben owe him), settled by the old per-member doc.
    await expect(marco.getByRole('checkbox', { name: new RegExp(`^Settled: (?!You).* owe you: ${esc(SPACE.reward)}$`) })).toBeChecked()
    const benLine = marco.getByRole('checkbox', { name: `Settled: You, Lena and Sam owe Ben: ${SPACE.reward}`, exact: true })
    await expect(benLine).toBeEnabled()
    await expect(shown(marco, 'Ben has left, so you can mark this yourself.', false)).toBeVisible()
    await centerOn(benLine)
    await snap(marco, 'b2-46-month-leaver-line')
    await benLine.click()
    for (const uid of [marcoUid, lenaUid, samUid]) {
      await expect.poll(() => settledDoc(older, benUid, uid)).toMatchObject({ uid: benUid, other: uid, settled: true, settledBy: marcoUid })
    }
  })

  await closeAll(browser, a)
})
