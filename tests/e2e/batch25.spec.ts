// Batch 2.5 end to end (SPEC §10), in iPhone-sized browsers against the emulators with the real rules: adding to a
// locked monthly list, crossing a task out with a reason and undoing it twice, the fair vote on review day (excused,
// and not), a week skipped for someone, a monthly task crossed out and voted on (and what a paused last week does
// and doesn't hide), and Help. Accounts, spaces and stored timelines are seeded; what people do goes through the UI.
//
// Time, as in batch2.spec.ts: `?now=` moves only the phone's clock, the emulator judges every write by the real one.
// So a test that writes seeds the stored window that decides it (the lock and reviews opening) around both the
// phone's time and the real time; the screens then say "This week’s times are off" or "This month’s times are
// off", which is expected here. Crossed-out and added times are the server's: the expected badges are read from the
// stored docs.
//
// Run alone:
//   npx firebase emulators:exec --only auth,firestore --project demo-stakes "npx playwright test batch25"
import { expect, test, type Locator, type Page } from '@playwright/test'
import { FieldValue, type Timestamp } from 'firebase-admin/firestore'
import { addMonths, momentAt, monthIdForWeek, utcOffsetMinutes, weekBounds, weekIdFor, weekIdsInMonth } from '../../src/domain/time.ts'
import {
  createAccount,
  db,
  monthlyDoc,
  resetEmulators,
  setMonthly,
  setMonthlyPlan,
  setMonthlyReview,
  setPlan,
  setProgress,
  setReview,
  setSpace,
  setWeek,
  spaceDoc,
  ts,
  weekDoc,
  type SeedTask,
} from './emulator.ts'
import { centerOn, phone, sheet, shown, snap } from './helpers.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TZ = 'Europe/Rome'

type Who = { name: string; email: string; password: string }
const person = (name: string, email: string): Who => ({ name, email, password: 'secret123' })
const LENA = person('Lena Fischer', 'lena@example.com')
const SAM = person('Sam Okafor', 'sam@example.com')
const KIM = person('Kim Park', 'kim@example.com')
const COLORS: Record<string, string> = { Lena: '#AF52DE', Sam: '#34C759', Kim: '#FF2D55' }

const SPACE_ID = 'film-club'
const SPACE = { name: 'Film Club', reward: 'Dinner at Da Enzo, on them', penalty: 'Coffee for everyone, for a week' }
const CODE = 'FCLB2345'

const SWIM: SeedTask = { id: 'l1', title: 'Swim 3 times' }
const EDIT: SeedTask = { id: 'l2', title: 'Edit the reel' }
const RUN: SeedTask = { id: 's1', title: 'Run 20 km' }
const FILM: SeedTask = { id: 'lm1', title: 'Ship the short film' }
const READ: SeedTask = { id: 'lm2', title: 'Read two books' }
const BIKE: SeedTask = { id: 'sm1', title: 'Fix the bike' }
const POOL = 'The pool is closed all week'

// ---------- Time and words ----------

const iso = (ms: number) => new Date(ms).toISOString()
/** An instant on a week's wall clock in the space's zone: `day` 0 = Monday, `hour` 0–23. */
const on = (weekId: string, day: number, hour: number) => momentAt(weekId, TZ, day * 1440 + hour * 60)
const lastWeekOf = (monthId: string) => weekIdsInMonth(monthId)[weekIdsInMonth(monthId).length - 1]
const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...options, timeZone: TZ })
/** "Wed" / "Wednesday" on the space's clock. */
const weekday = (ms: number, long = false) => fmt({ weekday: long ? 'long' : 'short' }).format(ms)
/** "Oct 24" / "October 24" on the space's clock. */
const monthDay = (ms: number, long = false) => fmt({ month: long ? 'long' : 'short', day: 'numeric' }).format(ms)
const MONTH_NAME = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })
/** "2026-10" → "October", as the app writes it. */
const monthName = (monthId: string) => MONTH_NAME.format(Date.UTC(Number(monthId.slice(0, 4)), Number(monthId.slice(5, 7)) - 1, 1))
/** The app-month after the real one (the month of this week's Friday, plus one). */
const nextMonth = (now: number) => addMonths(monthIdForWeek(weekIdFor(now, TZ)), 1)

// ---------- Seeding ----------

async function accounts(at: number, ...people: Who[]): Promise<string[]> {
  const uids: string[] = []
  for (const who of people) uids.push(await createAccount(who, COLORS[who.name.split(' ')[0]], at))
  return uids
}

function seedSpace(members: string[], at: number, more: Partial<Parameters<typeof setSpace>[1]> = {}) {
  return setSpace(SPACE_ID, { ...SPACE, members, timezone: TZ, utcOffsetMin: utcOffsetMinutes(TZ, Date.now()), inviteCode: CODE, at, ...more })
}

const planRef = (coll: 'weeks' | 'monthly', id: string, uid: string) => db.doc(`spaces/${SPACE_ID}/${coll}/${id}/plans/${uid}`)

/** The stored `cancels` log of a plan: key → { at (ms), why? }. */
async function cancelsOf(coll: 'weeks' | 'monthly', id: string, uid: string): Promise<Record<string, { at: number; why?: string }>> {
  const raw = ((await planRef(coll, id, uid).get()).get('cancels') ?? {}) as Record<string, { at: Timestamp; why?: string }>
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { at: v.at.toMillis(), ...(v.why !== undefined ? { why: v.why } : {}) }]))
}

// ---------- Browser ----------

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function signIn(page: Page, who: Who, nowMs?: number): Promise<void> {
  await page.goto(nowMs === undefined ? '/' : `/?now=${iso(nowMs)}`)
  await page.getByRole('button', { name: 'I Have an Account' }).click()
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await expect(tab(page, 'Spaces')).toHaveAttribute('aria-selected', 'true')
}

async function openSpace(page: Page): Promise<void> {
  await page.getByRole('button', { name: new RegExp(SPACE.name) }).first().click()
  await expect(page.getByRole('heading', { name: SPACE.name })).toBeVisible()
}

/** Pushes the month's list from the monthly card on the Space screen. */
async function openList(page: Page, month: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^(Your )?${month} list`) }).filter({ visible: true }).first().click()
  await expect(page.getByRole('heading', { name: `${month} List`, exact: true })).toBeVisible()
}

/** A visible grouped section holding `text`. */
const section = (scope: Page | Locator, text: string | RegExp) => scope.locator('.ui-section').filter({ visible: true }).filter({ hasText: text }).first()
/** A member's card: the visible section whose header row names them. */
const card = (page: Page, name: string) => section(page, new RegExp(`^${esc(name)}`))
/** A task's row (its title starts the row's text), anywhere visible in `scope`. */
const taskRow = (scope: Page | Locator, title: string) => scope.locator('.tk-row').filter({ visible: true }).filter({ hasText: new RegExp(`^${esc(title)}`) }).first()
/** The row's button that opens your own task. */
const openTask = (page: Page, title: string) => page.getByRole('button', { name: new RegExp(`^${esc(title)}`) }).filter({ visible: true }).first()
const toast = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text }).first()

async function answer(page: Page, button: string): Promise<Locator> {
  const alert = page.getByRole('alertdialog')
  await expect(alert).toBeVisible()
  await alert.getByRole('button', { name: button, exact: true }).click()
  return alert
}

async function mark(dialog: Locator, title: string, label: 'Done' | 'Half' | 'Not done'): Promise<void> {
  await dialog.getByRole('radiogroup', { name: `Mark for ${title}` }).getByRole('radio', { name: label, exact: true }).click()
}

async function vote(dialog: Locator, title: string, label: 'Fair, Skip It' | 'Not Done'): Promise<void> {
  await dialog.getByRole('radiogroup', { name: `Vote for ${title}` }).getByRole('radio', { name: label, exact: true }).click()
}

async function closeAll(...phones: { context: { close: () => Promise<void> }; errors: string[] }[]): Promise<void> {
  for (const p of phones) expect(p.errors).toEqual([])
  for (const p of phones) await p.context.close()
}

const CROSS_OUT_WHY = 'For when something outside your control gets in the way. Friends see your reason and decide on review day if it’s fair to skip it.'

// =====================================================================================================
// 1. Monthly adds (SPEC §10.2)
// =====================================================================================================

test('a locked monthly list grows by one task at a time, with the date it was added', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [lenaUid, samUid, kimUid] = await accounts(t0 - 60 * DAY, LENA, SAM, KIM)
  const members = [lenaUid, samUid, kimUid]
  await seedSpace(members, t0 - 50 * DAY)
  const month = nextMonth(t0)
  const M = monthName(month)
  const weeks = weekIdsInMonth(month)
  const bounds = (w: string) => weekBounds(w, TZ)
  // The list locked (in real time too, so the server takes the add); its reviews open in its last week as usual.
  await setMonthly(SPACE_ID, month, {
    startAt: bounds(weeks[0]).startAt,
    lockAt: t0 - HOUR,
    reviewOpenAt: bounds(lastWeekOf(month)).reviewOpenAt,
    deadlineAt: bounds(lastWeekOf(month)).deadlineAt,
    members,
    judges: [],
    submittedBy: [],
  })
  // Lena and Sam had lists at the lock; Kim didn't.
  await setMonthlyPlan(SPACE_ID, month, lenaUid, [FILM, READ], bounds(weeks[0]).startAt)
  await setMonthlyPlan(SPACE_ID, month, samUid, [BIKE], bounds(weeks[0]).startAt)
  const midMonth = on(weeks[2], 2, 11)
  const NEW = { title: 'Mail the festival submission', step: 'Export the screener' }

  const l = await phone(browser)
  const s = await phone(browser)
  const k = await phone(browser)
  const [lena, sam, kim] = [l.page, s.page, k.page]

  let addedText = ''
  await test.step('Lena adds a task with a step to her locked list', async () => {
    await signIn(lena, LENA, midMonth)
    await openSpace(lena)
    await openList(lena, M)
    const mine = card(lena, `${LENA.name} (You)`)
    await expect(shown(lena, `Locked. You can still add tasks until`)).toBeVisible()
    await expect(shown(lena, 'Friends see the date you added them.')).toBeVisible()
    await centerOn(mine)
    await snap(lena, 'b25-01-monthly-add-row')
    await mine.getByRole('button', { name: 'Add Task', exact: true }).click()
    const form = sheet(lena)
    await expect(shown(form, `The task joins your ${M} list and gets reviewed in ${M}’s last week. Friends see it was added on ${monthDay(midMonth, true)}. Once added, it can’t be edited or removed.`)).toBeVisible()
    // A monthly task has no revenue.
    await expect(form.getByRole('switch', { name: 'Generates revenue' })).toHaveCount(0)
    await form.getByLabel('Title', { exact: true }).fill(NEW.title)
    await form.getByRole('button', { name: 'Add Step', exact: true }).click()
    await form.getByLabel('Step 1', { exact: true }).fill(NEW.step)
    await snap(lena, 'b25-02-monthly-add-sheet')
    await form.getByRole('button', { name: `Add to ${M} List`, exact: true }).click()
    await expect(lena.getByRole('dialog')).toHaveCount(0)

    const plan = await planRef('monthly', month, lenaUid).get()
    const tasks = plan.get('tasks') as SeedTask[]
    expect(tasks.slice(0, 2)).toEqual([FILM, READ])
    expect(tasks[2]).toEqual({ id: expect.any(String), title: NEW.title, subs: [expect.stringMatching(new RegExp(`\\|${NEW.step}$`))] })
    const added = plan.get('added') as Record<string, Timestamp>
    expect(Object.keys(added)).toEqual([tasks[2].id])
    addedText = `Added ${monthDay(added[tasks[2].id].toMillis())}`
    await expect(taskRow(mine, NEW.title)).toContainText(addedText)
    await centerOn(taskRow(mine, NEW.title))
    await snap(lena, 'b25-03-monthly-added-badge')
  })

  await test.step('Sam sees it with its date', async () => {
    await signIn(sam, SAM, midMonth + HOUR)
    await openSpace(sam)
    await openList(sam, M)
    const hers = card(sam, LENA.name)
    await expect(taskRow(hers, NEW.title)).toContainText(addedText)
    await expect(shown(hers, NEW.step, true)).toBeVisible()
  })

  await test.step('Kim, who had no list at the lock, can’t start one', async () => {
    await signIn(kim, KIM, midMonth + HOUR)
    await openSpace(kim)
    await openList(kim, M)
    await expect(shown(kim, `No ${M} list`, true)).toBeVisible()
    await expect(kim.getByRole('button', { name: 'Add Task', exact: true })).toHaveCount(0)
  })

  await closeAll(l, s, k)
})

// =====================================================================================================
// 2. Cross out, undo, and the 2-undo cap (SPEC §10.3, §10.5)
// =====================================================================================================

test('crossing out a task with a reason, undoing it twice, and the final cross-out', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [lenaUid, samUid] = await accounts(t0 - 60 * DAY, LENA, SAM)
  const members = [lenaUid, samUid]
  await seedSpace(members, t0 - 50 * DAY)
  // This (real) week, locked a day ago; reviews open in two days. The phone runs on the real clock.
  const week = weekIdFor(t0, TZ)
  await setWeek(SPACE_ID, week, { startAt: t0 - 2 * DAY, lockAt: t0 - DAY, reviewOpenAt: t0 + 2 * DAY, deadlineAt: t0 + 3 * DAY, members, submittedBy: [] })
  await setPlan(SPACE_ID, week, lenaUid, [SWIM, EDIT], t0 - 2 * DAY)
  await setPlan(SPACE_ID, week, samUid, [RUN], t0 - 2 * DAY)
  await setProgress(SPACE_ID, week, lenaUid, { [EDIT.id]: true }, t0 - HOUR)

  const l = await phone(browser)
  const s = await phone(browser)
  const [lena, sam] = [l.page, s.page]
  const mine = () => card(lena, `${LENA.name} (You)`)
  const swimBox = () => lena.getByRole('checkbox', { name: SWIM.title, exact: true })

  const crossOut = async (confirmTail: string) => {
    await openTask(lena, SWIM.title).click()
    const form = sheet(lena)
    await form.getByRole('button', { name: 'Cross Out Task', exact: true }).click()
    const field = form.getByLabel('Why can’t you do it?')
    await expect(field).toBeFocused()
    await field.fill(POOL)
    await form.getByRole('button', { name: 'Cross Out Task', exact: true }).click()
    const alert = lena.getByRole('alertdialog')
    await expect(alert).toContainText(`Cross out “${SWIM.title}”?`)
    await expect(alert).toContainText(confirmTail)
    await alert.getByRole('button', { name: 'Cross Out', exact: true }).click()
    await expect(lena.getByRole('dialog')).toHaveCount(0)
    await expect(toast(lena, 'Crossed out')).toBeVisible()
  }
  const undo = async (confirmTail: string, footerTail: string) => {
    await openTask(lena, SWIM.title).click()
    const form = sheet(lena)
    await form.getByRole('button', { name: 'Undo Cross Out', exact: true }).click()
    const alert = lena.getByRole('alertdialog')
    await expect(alert).toContainText('Undo the cross-out?')
    await expect(alert).toContainText(`“${SWIM.title}” counts again and you can tick it.${confirmTail}`)
    await alert.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(toast(lena, 'Back on your list')).toBeVisible()
    // The sheet stays, now offering Cross Out again with what's left.
    await expect(shown(form, `${CROSS_OUT_WHY}${footerTail}`)).toBeVisible()
    await form.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(lena.getByRole('dialog')).toHaveCount(0)
    await expect(swimBox()).toBeVisible()
  }

  await test.step('Before crossing out, the sheet says what it’s for and that it can be undone twice', async () => {
    await signIn(lena, LENA)
    await openSpace(lena)
    await expect(swimBox()).toBeVisible()
    await openTask(lena, SWIM.title).click()
    const form = sheet(lena)
    await expect(shown(form, `${CROSS_OUT_WHY} You can undo it twice.`)).toBeVisible()
    await snap(lena, 'b25-04-sheet-cross-out-row')
    await form.getByRole('button', { name: 'Cross Out Task', exact: true }).click()
    // The reason, in place; the button waits for one.
    const button = form.getByRole('button', { name: 'Cross Out Task', exact: true })
    await expect(button).toBeDisabled()
    await expect(shown(form, `Everyone in ${SPACE.name} sees this.`)).toBeVisible()
    await form.getByLabel('Why can’t you do it?').fill('   ')
    await expect(button).toBeDisabled()
    await form.getByLabel('Why can’t you do it?').fill(POOL)
    await expect(button).toBeEnabled()
    await snap(lena, 'b25-05-sheet-reason')
    await button.click()
    const alert = lena.getByRole('alertdialog')
    await expect(alert).toContainText(`Cross out “${SWIM.title}”?`)
    await expect(alert).toContainText('Friends see it crossed out with your reason, and on review day they decide if it’s fair to skip it. You can undo this twice until reviews open.')
    await snap(lena, 'b25-06-cross-out-confirm')
    await alert.getByRole('button', { name: 'Cross Out', exact: true }).click()
    await expect(lena.getByRole('dialog')).toHaveCount(0)
    await expect(toast(lena, 'Crossed out')).toContainText('Friends decide on review day.')
  })

  let crossedText = ''
  await test.step('Her card shows it struck through with the reason, not counted yet, and no check circle', async () => {
    const log = await cancelsOf('weeks', week, lenaUid)
    expect(Object.keys(log)).toEqual([`1:${SWIM.id}`])
    expect(log[`1:${SWIM.id}`].why).toBe(POOL)
    crossedText = `Crossed out ${weekday(log[`1:${SWIM.id}`].at)}`
    const row = taskRow(mine(), SWIM.title)
    await expect(row).toContainText(`“${POOL}”`)
    await expect(row).toContainText(crossedText)
    await expect(row.locator('.tk-struck')).toHaveText(SWIM.title)
    await expect(row.getByRole('img', { name: 'Crossed out', exact: true })).toBeVisible()
    await expect(swimBox()).toHaveCount(0)
    await expect(mine()).toContainText('1 of 1 done · 1 crossed out, not counted yet')
    await snap(lena, 'b25-07-card-crossed-out')
  })

  await test.step('Sam’s phone shows the same', async () => {
    await signIn(sam, SAM)
    await openSpace(sam)
    const hers = card(sam, LENA.name)
    await expect(taskRow(hers, SWIM.title)).toContainText(`“${POOL}”`)
    await expect(taskRow(hers, SWIM.title)).toContainText(crossedText)
    await expect(hers).toContainText('1 of 1 done · 1 crossed out, not counted yet')
    await centerOn(hers)
    await snap(sam, 'b25-08-friend-card-crossed-out')
  })

  await test.step('The crossed-out sheet: when, why, and Undo with two left', async () => {
    await openTask(lena, SWIM.title).click()
    const form = sheet(lena)
    await expect(shown(form, `Crossed out ${weekday((await cancelsOf('weeks', week, lenaUid))[`1:${SWIM.id}`].at, true)}`, true)).toBeVisible()
    await expect(shown(form, `“${POOL}”`, true)).toBeVisible()
    await expect(shown(form, /^You can undo this twice, until reviews open /)).toBeVisible()
    await snap(lena, 'b25-09-sheet-crossed-out')
    await form.getByRole('button', { name: 'Done', exact: true }).click()
  })

  await test.step('Undo, cross out, undo, cross out: the undos run out', async () => {
    await undo(' You’ll have 1 undo left.', ' You have 1 undo left.')
    await crossOut('You can undo this once more until reviews open.')
    await undo(' That’s your last undo: if you cross it out again, it’s final.', ' If you cross it out again, it’s final.')
    await crossOut('This one is final: you’ve used both undos.')
    const log = await cancelsOf('weeks', week, lenaUid)
    expect(Object.keys(log).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `${n}:${SWIM.id}`))
    expect(log[`5:${SWIM.id}`].why).toBe(POOL)
    expect(log[`2:${SWIM.id}`].why).toBeUndefined()
  })

  await test.step('The fifth change is final: no Undo', async () => {
    await openTask(lena, SWIM.title).click()
    const form = sheet(lena)
    await expect(shown(form, 'This is final. Friends decide on review day if it’s fair to skip it.')).toBeVisible()
    await expect(form.getByRole('button', { name: 'Undo Cross Out', exact: true })).toHaveCount(0)
    await expect(form.getByRole('button', { name: 'Cross Out Task', exact: true })).toHaveCount(0)
    await snap(lena, 'b25-10-sheet-final')
    await form.getByRole('button', { name: 'Done', exact: true }).click()
    // Ticks stay frozen: no check circle.
    await expect(swimBox()).toHaveCount(0)
  })

  await closeAll(l, s)
})

// =====================================================================================================
// 3. The vote on review day: excused (SPEC §10.4)
// =====================================================================================================

test('review day: friends (a judge too) say fair, and the crossed-out task doesn’t count', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [lenaUid, samUid, kimUid] = await accounts(t0 - 60 * DAY, LENA, SAM, KIM)
  const members = [lenaUid, samUid, kimUid]
  await seedSpace(members, t0 - 50 * DAY, { judges: [kimUid] })
  // This (real) week, in its review window on the real clock; the phone runs on it too.
  const week = weekIdFor(t0, TZ)
  const crossedAt = t0 - 2 * DAY
  await setWeek(SPACE_ID, week, {
    startAt: t0 - 4 * DAY,
    lockAt: t0 - 3 * DAY,
    reviewOpenAt: t0 - HOUR,
    deadlineAt: t0 + DAY,
    members,
    judges: [kimUid],
    submittedBy: [lenaUid],
  })
  await setPlan(SPACE_ID, week, lenaUid, [SWIM, EDIT], t0 - 4 * DAY, undefined, { [SWIM.id]: [{ at: crossedAt, why: POOL }] })
  await setPlan(SPACE_ID, week, samUid, [RUN], t0 - 4 * DAY)
  await setProgress(SPACE_ID, week, lenaUid, { [EDIT.id]: true, [SWIM.id]: true }, t0 - 3 * DAY)
  // Lena has already reviewed Sam.
  await setReview(SPACE_ID, week, lenaUid, samUid, { [RUN.id]: 1 }, t0 - MINUTE)

  const l = await phone(browser)
  const s = await phone(browser)
  const k = await phone(browser)
  const [lena, sam, kim] = [l.page, s.page, k.page]

  const review = async (page: Page, who: Who, names: string) => {
    await signIn(page, who)
    await openSpace(page)
    await page.getByRole('button', { name: `Review ${names}`, exact: true }).click()
    return sheet(page)
  }

  await test.step('Sam’s review shows the reason and asks Fair, Skip It or Not Done', async () => {
    const form = await review(sam, SAM, 'Lena')
    await expect(shown(form, `Crossed out ${weekday(crossedAt, true)}: “${POOL}”`, true)).toBeVisible()
    await expect(form.locator('.s-review-task__title.tk-struck')).toHaveText(SWIM.title)
    await expect(shown(form, 'If most reviewers say it’s fair, it doesn’t count for Lena. If not, it counts as not done.')).toBeVisible()
    await expect(shown(form, '2 tasks · 1 crossed out · all checked off')).toBeVisible()
    await expect(form.getByRole('button', { name: '2 to mark', exact: true })).toBeVisible()
    await snap(sam, 'b25-11-review-vote')
    await vote(form, SWIM.title, 'Fair, Skip It')
    await expect(form.getByRole('button', { name: '1 to mark', exact: true })).toBeVisible()
    await mark(form, EDIT.title, 'Done')
    await snap(sam, 'b25-12-review-vote-picked')
    await form.getByRole('button', { name: 'Submit Reviews', exact: true }).click()
    await answer(sam, 'Submit')
    await expect(shown(form, 'Reviews in.')).toBeVisible()
    await expect
      .poll(async () => (await weekDoc(SPACE_ID, week).collection('reviews').doc(`${samUid}_${lenaUid}`).get()).get('marks'))
      .toEqual({ [SWIM.id]: 'fair', [EDIT.id]: 1 })
  })

  await test.step('Kim, a judge, votes fair too', async () => {
    const form = await review(kim, KIM, 'Lena and Sam')
    await vote(form, SWIM.title, 'Fair, Skip It')
    await mark(form, EDIT.title, 'Done')
    await form.getByRole('button', { name: /^Next/ }).click()
    await mark(form, RUN.title, 'Done')
    await form.getByRole('button', { name: 'Submit Reviews', exact: true }).click()
    await answer(kim, 'Submit')
    await expect(shown(form, 'Reviews in.')).toBeVisible()
  })

  await test.step('Results: the task is skipped, 2 of 2 said fair, and her score leaves it out', async () => {
    await signIn(lena, LENA)
    await openSpace(lena)
    const mine = card(lena, `${LENA.name} (You)`)
    const row = taskRow(mine, SWIM.title)
    await expect(row).toContainText(`“${POOL}” · 2 of 2 said fair`)
    await expect(row).toContainText('Skipped')
    await expect(row.getByRole('img', { name: 'Skipped', exact: true })).toBeVisible()
    await expect(mine).toContainText('1 skipped')
    await expect(mine.locator('.s-mini-score__value')).toHaveText('100%')
    await snap(lena, 'b25-13-results-excused')
  })

  await closeAll(l, s, k)
})

// =====================================================================================================
// 4–5. Not excused, and a whole week skipped (SPEC §10.4, §10.5)
// =====================================================================================================

test('results: a crossed-out task that counts as not done, and a week skipped in the month', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [lenaUid, samUid, kimUid] = await accounts(t0 - 90 * DAY, LENA, SAM, KIM)
  const members = [lenaUid, samUid, kimUid]
  await seedSpace(members, t0 - 80 * DAY)
  const month = nextMonth(t0)
  const [w1, w2, w3] = weekIdsInMonth(month)
  const b1 = weekBounds(w1, TZ)
  const b2 = weekBounds(w2, TZ)
  const reviewed = (b: { reviewOpenAt: number }) => b.reviewOpenAt + HOUR

  // Week 1: Lena crossed out Swim; Sam said fair, Kim not: 1 of 2, so it counts as not done.
  await setWeek(SPACE_ID, w1, { ...b1, members, submittedBy: members })
  await setPlan(SPACE_ID, w1, lenaUid, [SWIM, EDIT], b1.startAt, undefined, { [SWIM.id]: [{ at: b1.lockAt + DAY, why: POOL }] })
  await setPlan(SPACE_ID, w1, samUid, [RUN], b1.startAt)
  await setPlan(SPACE_ID, w1, kimUid, [BIKE], b1.startAt)
  await setReview(SPACE_ID, w1, samUid, lenaUid, { [SWIM.id]: 'fair', [EDIT.id]: 1 }, reviewed(b1))
  await setReview(SPACE_ID, w1, kimUid, lenaUid, { [SWIM.id]: 0, [EDIT.id]: 1 }, reviewed(b1))
  for (const [a, b] of [[lenaUid, samUid], [lenaUid, kimUid], [samUid, kimUid], [kimUid, samUid]]) {
    await setReview(SPACE_ID, w1, a, b, { [b === samUid ? RUN.id : BIKE.id]: 1 }, reviewed(b1))
  }
  // Week 2: Lena's only task crossed out, and everyone said fair: the week is skipped for her.
  await setWeek(SPACE_ID, w2, { ...b2, members, submittedBy: members })
  await setPlan(SPACE_ID, w2, lenaUid, [SWIM], b2.startAt, undefined, { [SWIM.id]: [{ at: b2.lockAt + DAY, why: 'Ear infection' }] })
  await setPlan(SPACE_ID, w2, samUid, [RUN], b2.startAt)
  await setPlan(SPACE_ID, w2, kimUid, [BIKE], b2.startAt)
  await setReview(SPACE_ID, w2, samUid, lenaUid, { [SWIM.id]: 'fair' }, reviewed(b2))
  await setReview(SPACE_ID, w2, kimUid, lenaUid, { [SWIM.id]: 'fair' }, reviewed(b2))
  for (const [a, b] of [[lenaUid, samUid], [lenaUid, kimUid], [samUid, kimUid], [kimUid, samUid]]) {
    await setReview(SPACE_ID, w2, a, b, { [b === samUid ? RUN.id : BIKE.id]: 1 }, reviewed(b2))
  }
  const monday3 = on(w3, 0, 10)

  const l = await phone(browser)
  const s = await phone(browser)
  const [lena, sam] = [l.page, s.page]

  await test.step('Week 1: 1 of 2 said fair, so the task counts as not done', async () => {
    await signIn(lena, LENA, monday3)
    await openSpace(lena)
    await lena.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Month', exact: true }).click()
    await lena.getByRole('button', { name: new RegExp(`^${esc(new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${w1}T00:00:00Z`)))}`) }).filter({ visible: true }).first().click()
    const mine = card(lena, `${LENA.name} (You)`)
    const row = taskRow(mine, SWIM.title)
    await expect(row).toContainText(`“${POOL}” · 1 of 2 said fair`)
    await expect(row).toContainText('Not done')
    // (0 + Done + Done) over 2 tasks × 2 reviewers.
    await expect(mine.locator('.s-mini-score__value')).toHaveText('50%')
    await snap(lena, 'b25-14-results-not-excused')
  })

  await test.step('Week 2 is skipped for her: no score, not 0%', async () => {
    await signIn(sam, SAM, monday3)
    await openSpace(sam)
    await sam.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Month', exact: true }).click()
    await sam.getByRole('button', { name: new RegExp(`^${esc(new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${w2}T00:00:00Z`)))}`) }).filter({ visible: true }).first().click()
    const hers = card(sam, LENA.name)
    await expect(hers).toContainText('Skipped: friends said fair')
    await expect(hers.locator('.ui-pill')).toHaveText('Skipped')
    await expect(hers.locator('.s-mini-score')).toHaveCount(0)
    await expect(taskRow(hers, SWIM.title)).toContainText('“Ear infection” · 2 of 2 said fair')
    await snap(sam, 'b25-15-week-skipped')
  })

  await test.step('Her month lists the week as Skipped and averages the rest', async () => {
    await lena.getByRole('button', { name: /^Back/ }).filter({ visible: true }).first().click()
    const hero = lena.locator('.s-month-hero').filter({ visible: true })
    await expect(hero).toContainText('1 week scored · 1 skipped')
    await expect(lena.locator('.s-hero-score').filter({ visible: true })).toHaveText('50%')
    const label = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${w2}T00:00:00Z`))
    await expect(lena.getByRole('button', { name: new RegExp(`^${esc(label)}`) }).filter({ visible: true }).first()).toContainText('Skipped')
    await snap(lena, 'b25-16-month-skipped')
  })

  await closeAll(l, s)
})

// =====================================================================================================
// 6. A monthly task crossed out and voted on; a paused last week (SPEC §10.3, §10.5)
// =====================================================================================================

test('a monthly task: crossed out in a paused last week, then voted on with the week’s tasks', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [lenaUid, samUid] = await accounts(t0 - 60 * DAY, LENA, SAM)
  const members = [lenaUid, samUid]
  const month = nextMonth(t0)
  const M = monthName(month)
  const weeks = weekIdsInMonth(month)
  const last = lastWeekOf(month)
  const lb = weekBounds(last, TZ)
  // The month's last week is paused (before its reviews open).
  await seedSpace(members, t0 - 50 * DAY, { paused: { [month]: last } })
  await setWeek(SPACE_ID, last, { ...lb, members, submittedBy: [] })
  await setPlan(SPACE_ID, last, lenaUid, [SWIM, EDIT], lb.startAt)
  await setPlan(SPACE_ID, last, samUid, [RUN], lb.startAt)
  // The list locked (in real time too, so the server takes the cross-out); its reviews open with the last week's.
  await setMonthly(SPACE_ID, month, {
    startAt: weekBounds(weeks[0], TZ).startAt,
    lockAt: t0 - HOUR,
    reviewOpenAt: lb.reviewOpenAt,
    deadlineAt: lb.deadlineAt,
    members,
    judges: [],
    submittedBy: [],
  })
  await setMonthlyPlan(SPACE_ID, month, lenaUid, [FILM, READ], weekBounds(weeks[0], TZ).startAt)
  await setMonthlyPlan(SPACE_ID, month, samUid, [BIKE], weekBounds(weeks[0], TZ).startAt)
  const wednesday = on(last, 2, 12)

  const l = await phone(browser)
  const s = await phone(browser)
  const [lena, sam] = [l.page, s.page]

  await test.step('In the paused week her weekly task offers no Cross Out', async () => {
    await signIn(lena, LENA, wednesday)
    await openSpace(lena)
    await openTask(lena, SWIM.title).click()
    const form = sheet(lena)
    await expect(form.getByRole('heading', { name: 'Details' })).toBeVisible()
    await expect(form.getByRole('button', { name: 'Cross Out Task', exact: true })).toHaveCount(0)
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(lena.getByRole('dialog')).toHaveCount(0)
  })

  let crossedAt = 0
  await test.step('Her October list still offers Add Task and Cross Out, and she crosses one out', async () => {
    await openList(lena, M)
    const mine = card(lena, `${LENA.name} (You)`)
    await expect(mine.getByRole('button', { name: 'Add Task', exact: true })).toBeVisible()
    await openTask(lena, FILM.title).click()
    const form = sheet(lena)
    await expect(shown(form, `${CROSS_OUT_WHY} You can undo it twice.`)).toBeVisible()
    await form.getByRole('button', { name: 'Cross Out Task', exact: true }).click()
    await form.getByLabel('Why can’t you do it?').fill('The festival was cancelled')
    await form.getByRole('button', { name: 'Cross Out Task', exact: true }).click()
    await answer(lena, 'Cross Out')
    await expect(lena.getByRole('dialog')).toHaveCount(0)
    const log = await cancelsOf('monthly', month, lenaUid)
    expect(Object.keys(log)).toEqual([`1:${FILM.id}`])
    crossedAt = log[`1:${FILM.id}`].at
    // A monthly list spans weeks: the badge names the date.
    await expect(taskRow(mine, FILM.title)).toContainText(`Crossed out ${monthDay(crossedAt)}`)
    await expect(mine).toContainText('0 of 1 done · 1 crossed out, not counted yet')
    await centerOn(taskRow(mine, FILM.title))
    await snap(lena, 'b25-17-monthly-crossed-out')
  })

  // The pause is lifted (so the week is reviewed too), and both review windows open on the real clock.
  const t1 = Date.now()
  await spaceDoc(SPACE_ID).update({ paused: FieldValue.delete() })
  await weekDoc(SPACE_ID, last).update({ reviewOpenAt: ts(t1 - HOUR), submittedBy: [lenaUid] })
  await monthlyDoc(SPACE_ID, month).update({ reviewOpenAt: ts(t1 - HOUR), submittedBy: [lenaUid] })
  await setReview(SPACE_ID, last, lenaUid, samUid, { [RUN.id]: 1 }, t1 - MINUTE)
  await setMonthlyReview(SPACE_ID, month, lenaUid, samUid, { [BIKE.id]: 1 }, t1 - MINUTE)

  await test.step('Sam reviews her week and her list in one sheet, voting on the crossed-out task', async () => {
    await signIn(sam, SAM, on(last, 4, 10))
    await openSpace(sam)
    await sam.getByRole('button', { name: 'Review Lena', exact: true }).click()
    const form = sheet(sam)
    await expect(shown(form, 'This week', true)).toBeVisible()
    await expect(shown(form, `${M} list`, true)).toBeVisible()
    await expect(shown(form, `Crossed out ${monthDay(crossedAt, true)}: “The festival was cancelled”`, true)).toBeVisible()
    await mark(form, SWIM.title, 'Done')
    await mark(form, EDIT.title, 'Half')
    await vote(form, FILM.title, 'Fair, Skip It')
    await mark(form, READ.title, 'Done')
    await centerOn(form.getByRole('radiogroup', { name: `Vote for ${FILM.title}` }))
    await snap(sam, 'b25-18-review-two-parts-vote')
    await form.getByRole('button', { name: 'Submit Reviews', exact: true }).click()
    await answer(sam, 'Submit')
    await expect(shown(form, 'Reviews in.')).toBeVisible()
    await expect
      .poll(async () => (await monthlyDoc(SPACE_ID, month).collection('reviews').doc(`${samUid}_${lenaUid}`).get()).get('marks'))
      .toEqual({ [FILM.id]: 'fair', [READ.id]: 1 })
  })

  await test.step('The list’s results: the crossed-out task is skipped', async () => {
    await openList(sam, M)
    const hers = card(sam, LENA.name)
    await expect(taskRow(hers, FILM.title)).toContainText('1 of 1 said fair')
    await expect(taskRow(hers, FILM.title)).toContainText('Skipped')
    await expect(hers.locator('.s-mini-score__value')).toHaveText('100%')
  })

  await closeAll(l, s)
})

// =====================================================================================================
// 8. Help (SPEC §10.9)
// =====================================================================================================

test('Help explains crossing out and the vote', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const [lenaUid] = await accounts(t0 - 10 * DAY, LENA)
  await seedSpace([lenaUid], t0 - 5 * DAY)
  const l = await phone(browser)
  await signIn(l.page, LENA)
  await l.page.getByRole('button', { name: 'Help', exact: true }).filter({ visible: true }).first().click()
  const help = l.page.getByRole('dialog', { name: 'Help' })
  await expect(help.getByRole('heading', { name: 'How Stakes Works' })).toBeVisible()
  const cross = shown(help, 'Can’t do a task for reasons outside your control? Cross it out with a reason before reviews open. You can undo that twice.')
  await expect(cross).toBeVisible()
  await expect(shown(help, 'You can add to it until reviews open.')).toBeVisible()
  await expect(shown(help, 'For a crossed-out task, pick Fair, Skip It or Not Done. If most say fair, it doesn’t count.')).toBeVisible()
  await centerOn(cross)
  await snap(l.page, 'b25-19-help')
  await closeAll(l)
})
