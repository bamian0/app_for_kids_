// Batch 3 shared goals end to end (SPEC §11.9.5), in iPhone-sized browsers against the emulators with the real
// rules: creating a goal and joining it, checking in (decimals, edits), reaching the target with its moment, Keep
// Going and Finish, leaving (the owner hands on, the last one deletes it), the ?goal= link, and the limits
// (offline, an ended goal, an invitee's view, a leaver's check-in, a sheet that outlives its week). Accounts,
// friendships and some goals are seeded; what people do goes through the UI. The phones run in Rome on the real
// clock (one test moves its clock with ?now=, which the server never sees).
//
// Run alone:
//   npx firebase emulators:exec --only auth,firestore --project demo-stakes "npx playwright test batch3-shared"
import { expect, test, type Locator, type Page } from '@playwright/test'
import { goalWeek } from '../../src/domain/shared.ts'
import { addWeeks, momentAt, utcOffsetMinutes, weekIdFor } from '../../src/domain/time.ts'
import { checkinHeader, thisWeekHeader } from '../../src/screens/shared/copy.ts'
import { createAccount } from './emulator.ts'
import { befriend, goalIdsNamed, hasCheckin, readGoal, setCheckin, setGoal } from './shared-seed.ts'
import { centerOn, phone, sheet, shown, snap } from './helpers.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TZ = 'Europe/Rome'

type Who = { name: string; email: string; password: string }
const person = (name: string, email: string): Who => ({
  name,
  email,
  password: 'secret123',
})
const ANA = person('Ana Silva', 'ana@example.com')
const BEN = person('Ben Carter', 'ben@example.com')
const CLEO = person('Cleo Duarte', 'cleo@example.com')
const COLORS: Record<string, string> = {
  Ana: '#AF52DE',
  Ben: '#34C759',
  Cleo: '#FF9500',
}

// ---------- Time and words ----------

const iso = (ms: number) => new Date(ms).toISOString()
/** This week in Rome (the goals' zone and the phones'). */
const thisWeek = () => weekIdFor(Date.now(), TZ)
/** "Oct 18" on the phones' clock (with the year when it isn't this one). */
function monDay(ms: number): string {
  const sameYear = new Date(ms).getUTCFullYear() === new Date().getUTCFullYear()
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: TZ,
  }).format(ms)
}
/** 'YYYY-MM-DD' in Rome. */
function dayId(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: TZ,
  }).formatToParts(ms)
  const get = (type: string) => parts.find((p) => p.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

// ---------- Seeding ----------

async function accounts(at: number, ...people: Who[]): Promise<string[]> {
  const uids: string[] = []
  for (const who of people) uids.push(await createAccount(who, COLORS[who.name.split(' ')[0]], at))
  return uids
}

/** Everyone friends with everyone. */
async function friends(uids: string[], at: number): Promise<void> {
  for (let i = 0; i < uids.length; i++) for (let j = i + 1; j < uids.length; j++) await befriend(uids[i], uids[j], at)
}

// ---------- Browser ----------

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })
const friendsTab = (page: Page) => page.getByRole('tab', { name: /^Friends/ })
const toast = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text }).first()
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The visible section with this header. */
const section = (scope: Page | Locator, header: string) => {
  const page = 'goto' in scope ? scope : scope.page()
  return scope
    .locator('.ui-section')
    .filter({ visible: true })
    .filter({
      has: page.locator('.ui-section__header-text', {
        hasText: new RegExp(`^${esc(header)}$`),
      }),
    })
    .first()
}
/** A goal's row in Shared Goals (its button is named after it, then its line). */
const goalRow = (scope: Page | Locator, name: string) =>
  scope
    .getByRole('button', { name: new RegExp(`^${esc(name)}, `) })
    .filter({ visible: true })
    .first()
const heroBar = (page: Page) => page.locator('.sg-bar--hero').filter({ visible: true }).first()
const button = (scope: Page | Locator, name: string) => scope.getByRole('button', { name, exact: true }).filter({ visible: true }).first()

async function signIn(page: Page, who: Who, path = '/'): Promise<void> {
  await page.goto(path)
  await page.getByRole('button', { name: 'I Have an Account' }).click()
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await expect(tab(page, 'Spaces')).toBeVisible()
}

async function openFriends(page: Page): Promise<void> {
  await friendsTab(page).click()
  await expect(friendsTab(page)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: 'Friends', exact: true }).filter({ visible: true }).first()).toBeVisible()
}

/** From the Friends root: the goal's screen. */
async function openGoal(page: Page, name: string): Promise<void> {
  await goalRow(section(page, 'Shared Goals'), name).click()
  await expect(page.getByRole('heading', { name, exact: true }).filter({ visible: true }).first()).toBeVisible()
}

async function back(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Back/ }).filter({ visible: true }).first().click()
}

async function answer(page: Page, label: string, text?: string): Promise<void> {
  const alert = page.getByRole('alertdialog')
  await expect(alert).toBeVisible()
  if (text) await expect(alert).toContainText(text)
  await alert.getByRole('button', { name: label, exact: true }).click()
  await expect(alert).toHaveCount(0)
}

/** The goal screen's ellipsis menu, then one of its actions. */
async function menu(page: Page, action: string): Promise<void> {
  await button(page, 'Goal options').click()
  await page.getByRole('dialog').last().getByRole('button', { name: action, exact: true }).click()
}

/** Check In (or Edit Check-In) on the goal screen: types the amount and note, saves. */
async function checkIn(page: Page, amount: string, note?: string, label = 'Check In'): Promise<Locator> {
  await button(page, label).click()
  const s = sheet(page)
  await expect(s.getByRole('heading', { name: 'Check In' })).toBeVisible()
  await s.locator('.sg-amount__input').fill(amount)
  if (note !== undefined) await s.getByLabel('Note').fill(note)
  return s
}

test.beforeEach(async () => {
  const { resetEmulators } = await import('./emulator.ts')
  await resetEmulators()
})

test('create a goal and invite a friend; the invitation counts in the badge; Join', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [anaUid, benUid] = await accounts(t0, ANA, BEN)
  await friends([anaUid, benUid], t0)
  const ana = await phone(browser)
  const ben = await phone(browser)
  let goalId = ''

  await test.step('Ana creates “Run 100 km”, inviting Ben', async () => {
    await signIn(ana.page, ANA)
    await openFriends(ana.page)
    await expect(shown(ana.page, 'Fill a target together, like 100 km or 20 books. Everyone checks in their part each week.', true)).toBeVisible()
    await snap(ana.page, 'sg01-section-empty')
    await button(ana.page, 'Add friend or new shared goal').click()
    await ana.page.getByRole('dialog').last().getByRole('button', { name: 'New Shared Goal', exact: true }).click()
    const s = sheet(ana.page)
    await expect(s.getByRole('heading', { name: 'New Shared Goal' })).toBeVisible()
    await expect(shown(s, '0 of 7 spots. They can join or decline.', true)).toBeVisible()
    await s.getByLabel('Goal name').fill('Run 100 km')
    await s.getByLabel('Amount', { exact: true }).fill('100')
    await s.getByRole('button', { name: 'km', exact: true }).click()
    await expect(s.getByLabel('Unit', { exact: true })).toHaveValue('km')
    await s.getByRole('button', { name: BEN.name, exact: true }).click()
    await expect(shown(s, '1 of 7 spots. They can join or decline.', true)).toBeVisible()
    await snap(ana.page, 'sg02-new-goal')
    // An end date: today or later.
    await s.getByRole('switch', { name: 'End Date' }).click()
    await expect(s.getByLabel('Last day')).toHaveValue(dayId(Date.now()))
    await centerOn(s.getByLabel('Last day'))
    await snap(ana.page, 'sg03-new-goal-end-date')
    // …off again: no end date.
    await s.getByRole('switch', { name: 'End Date' }).click()
    await s.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(toast(ana.page, 'Goal created')).toBeVisible()
    await expect(toast(ana.page, 'Invites sent')).toBeVisible()
    await expect(ana.page.getByRole('heading', { name: 'Run 100 km', exact: true }).filter({ visible: true })).toBeVisible()
    await expect(heroBar(ana.page)).toHaveAttribute('aria-label', '0 of 100 km')
    await expect(shown(ana.page, '100 km to go', true)).toBeVisible()
    const ids = await goalIdsNamed('Run 100 km')
    expect(ids).toHaveLength(1)
    goalId = ids[0]
    await expect
      .poll(() => readGoal(goalId))
      .toMatchObject({
        memberIds: [anaUid],
        invited: [benUid],
        zones: { [anaUid]: TZ },
      })
    // Everyone's part lists Ben as invited.
    await expect(shown(section(ana.page, 'Everyone’s part'), 'Invited', true)).toBeVisible()
    await snap(ana.page, 'sg04-goal-new')
  })

  await test.step('Ben’s Friends tab counts the invitation; he joins', async () => {
    await signIn(ben.page, BEN)
    await expect(ben.page.getByRole('tab', { name: 'Friends, 1 new', exact: true })).toBeVisible()
    await openFriends(ben.page)
    const shared = section(ben.page, 'Shared Goals')
    await expect(goalRow(shared, 'Run 100 km')).toHaveAccessibleName('Run 100 km, Ana invited you · 0 of 100 km')
    await snap(ben.page, 'sg05-invitation')
    await button(shared, 'Join').click()
    await expect(toast(ben.page, 'You joined Run 100 km')).toBeVisible()
    await expect(toast(ben.page, 'Check in your part each week.')).toBeVisible()
    await expect(ben.page.getByRole('tab', { name: 'Friends', exact: true })).toBeVisible()
    await expect(goalRow(shared, 'Run 100 km')).toHaveAccessibleName('Run 100 km, 0 of 100 km · 2 people')
    await expect(button(shared, 'Check In')).toBeVisible()
    await expect
      .poll(() => readGoal(goalId))
      .toMatchObject({
        memberIds: [anaUid, benUid],
        invited: [],
        zones: { [anaUid]: TZ, [benUid]: TZ },
      })
    await snap(ben.page, 'sg06-joined')
  })

  expect(ana.errors).toEqual([])
  expect(ben.errors).toEqual([])
})

test('check in, edit, decimals; reach together; Keep Going; Finish', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [anaUid, benUid] = await accounts(t0, ANA, BEN)
  await friends([anaUid, benUid], t0)
  const goalId = 'run100'
  await setGoal(goalId, {
    name: 'Run 100 km',
    unit: 'km',
    target: 100,
    members: [anaUid, benUid],
    timezone: TZ,
    createdAt: Date.now() - 3 * DAY,
  })
  const week = thisWeek()
  const ana = await phone(browser)
  const ben = await phone(browser)

  await test.step('Ana checks in 30 km with a note', async () => {
    await signIn(ana.page, ANA)
    await openFriends(ana.page)
    await snap(ana.page, 'sg07-section-goal')
    await openGoal(ana.page, 'Run 100 km')
    await snap(ana.page, 'sg08-goal-empty')
    const s = await checkIn(ana.page, '30', 'Long run on Sunday')
    await expect(shown(s, checkinHeader('Run 100 km', week), true)).toBeVisible()
    await expect(shown(s, 'Your part this week. Missed a week? Add it here. The team will be at 30 of 100 km.', true)).toBeVisible()
    await snap(ana.page, 'sg09-check-in')
    await button(s, 'Save').click()
    await expect(toast(ana.page, 'Checked in')).toBeVisible()
    await expect(toast(ana.page, 'The team is at 30 of 100 km.')).toBeVisible()
    await expect(heroBar(ana.page)).toHaveAttribute('aria-label', '30 of 100 km')
    await expect(button(ana.page, 'Edit Check-In')).toBeVisible()
  })

  await test.step('Ben checks in 25 from the Friends root', async () => {
    await signIn(ben.page, BEN)
    await openFriends(ben.page)
    const shared = section(ben.page, 'Shared Goals')
    await button(shared, 'Check In').click()
    const s = sheet(ben.page)
    await s.locator('.sg-amount__input').fill('25')
    await s.getByLabel('Note').fill('Two easy runs')
    await expect(shown(s, 'The team will be at 55 of 100 km.')).toBeVisible()
    await button(s, 'Save').click()
    await expect(toast(ben.page, 'The team is at 55 of 100 km.')).toBeVisible()
    // Checked in: the capsule gives way to the chevron.
    await expect(shared.getByRole('button', { name: 'Check In', exact: true })).toHaveCount(0)
    await expect(goalRow(shared, 'Run 100 km')).toHaveAccessibleName('Run 100 km, 55 of 100 km · 2 people')
  })

  await test.step('One bar, two segments; this week lists both with their notes', async () => {
    await expect(heroBar(ana.page)).toHaveAttribute('aria-label', '55 of 100 km')
    await expect(heroBar(ana.page).locator('.sg-bar__seg')).toHaveCount(2)
    const thisWeekSection = section(ana.page, thisWeekHeader(week))
    await expect(shown(thisWeekSection, '30 km', true)).toBeVisible()
    await expect(shown(thisWeekSection, '25 km', true)).toBeVisible()
    await expect(shown(thisWeekSection, '“Long run on Sunday”', true)).toBeVisible()
    await expect(shown(thisWeekSection, '“Two easy runs”', true)).toBeVisible()
    const parts = section(ana.page, 'Everyone’s part')
    await expect(shown(parts, '55%', true)).toBeVisible()
    await expect(shown(parts, '45%', true)).toBeVisible()
    await snap(ana.page, 'sg10-goal-two')
    await centerOn(section(ana.page, 'Details'), 'end')
    await snap(ana.page, 'sg11-goal-details')
  })

  await test.step('Ana edits hers to 40, then to 12.5', async () => {
    let s = await checkIn(ana.page, '40', undefined, 'Edit Check-In')
    await expect(shown(s, /^You checked in 30 km \w+day\. Saving replaces it\. The team will be at 65 of 100 km\.$/)).toBeVisible()
    await snap(ana.page, 'sg12-edit-check-in')
    await button(s, 'Save').click()
    await expect(heroBar(ana.page)).toHaveAttribute('aria-label', '65 of 100 km')
    s = await checkIn(ana.page, '12.5', undefined, 'Edit Check-In')
    await button(s, 'Save').click()
    await expect(heroBar(ana.page)).toHaveAttribute('aria-label', '37.5 of 100 km')
    await expect(shown(section(ana.page, thisWeekHeader(week)), '12.5 km', true)).toBeVisible()
    await expect.poll(async () => (await readGoal(goalId))?.totals100).toEqual({ [anaUid]: 1250, [benUid]: 2500 })
  })

  await test.step('Ben passes 100: the moment, on both phones', async () => {
    await openGoal(ben.page, 'Run 100 km')
    const s = await checkIn(ben.page, '90', undefined, 'Edit Check-In')
    await button(s, 'Save').click()
    for (const p of [ben.page, ana.page]) {
      await expect(shown(p, 'You did it together', true)).toBeVisible()
      await expect(shown(p, 'Run 100 km: 102.5 of 100 km.', true)).toBeVisible()
      await expect(shown(p, `Reached ${monDay(Date.now())} · 102.5 of 100 km`, true)).toBeVisible()
      // The bar swept once, and is full with the sheen.
      await expect(p.locator('.sg-bar-shimmer .ui-shimmer__sweep').filter({ visible: true })).toHaveCount(1)
      await expect(heroBar(p)).toHaveClass(/is-reached/)
    }
    await expect(toast(ben.page, 'Checked in')).toHaveCount(0)
    await expect(shown(ben.page, 'Keep checking in, or Ana can finish it.', true)).toBeVisible()
    await expect.poll(async () => (await readGoal(goalId))?.reached).toBe(true)
    await snap(ana.page, 'sg13-reached-owner')
    await snap(ben.page, 'sg14-reached-member')
  })

  await test.step('Only once per phone', async () => {
    await ana.page.reload()
    await openFriends(ana.page)
    await expect(goalRow(section(ana.page, 'Shared Goals'), 'Run 100 km')).toHaveAccessibleName('Run 100 km, Reached · 102.5 of 100 km · 2 people')
    await openGoal(ana.page, 'Run 100 km')
    await expect(shown(ana.page, 'You did it together', true)).toBeVisible()
    await expect(ana.page.locator('.sg-bar-shimmer .ui-shimmer__sweep')).toHaveCount(0)
  })

  await test.step('Ana keeps going: a target of 150', async () => {
    await button(ana.page, 'Keep Going').click()
    const s = sheet(ana.page)
    await expect(s.getByRole('heading', { name: 'Edit Goal' })).toBeVisible()
    await expect(shown(s, 'Raise the target to keep going.', true)).toBeVisible()
    await s.getByLabel('Amount', { exact: true }).fill('150')
    await expect(shown(s, 'It won’t show as reached until you get there.', true)).toBeVisible()
    await snap(ana.page, 'sg15-keep-going')
    await button(s, 'Save').click()
    await expect(ana.page.getByRole('dialog')).toHaveCount(0)
    await expect(heroBar(ana.page)).toHaveAttribute('aria-label', '102.5 of 150 km')
    await expect(shown(ana.page, '47.5 km to go', true)).toBeVisible()
    await expect(shown(ana.page, 'You did it together', true)).toHaveCount(0)
    await expect(shown(ben.page, 'You did it together', true)).toHaveCount(0)
    await expect.poll(async () => (await readGoal(goalId))?.reached).toBe(false)
  })

  await test.step('Ana finishes it: read-only, in Finished', async () => {
    await menu(ana.page, 'Finish Goal')
    await answer(ana.page, 'Finish', 'Check-ins stop and it moves to Finished. This can’t be undone.')
    await expect(toast(ana.page, 'Goal finished')).toBeVisible()
    await expect(shown(ana.page, `Finished ${monDay(Date.now())}`, true)).toBeVisible()
    await expect(button(ana.page, 'Edit Check-In')).toHaveCount(0)
    await expect(button(ana.page, 'Check In')).toHaveCount(0)
    await expect(section(ana.page, thisWeekHeader(week))).toHaveCount(0)
    await snap(ana.page, 'sg16-finished-goal')
    await back(ana.page)
    const shared = section(ana.page, 'Shared Goals')
    await expect(goalRow(shared, 'Run 100 km')).toHaveCount(0)
    await expect(shared.getByRole('button', { name: /^Finished/ })).toBeVisible()
    await shared.getByRole('button', { name: /^Finished/ }).click()
    await expect(ana.page.getByRole('heading', { name: 'Finished', exact: true }).filter({ visible: true })).toBeVisible()
    await expect(shown(ana.page, `102.5 of 150 km · Finished ${monDay(Date.now())}`, true)).toBeVisible()
    await snap(ana.page, 'sg17-finished-list')
    // Ben's goal screen turned read-only too.
    await expect(button(ben.page, 'Edit Check-In')).toHaveCount(0)
    await expect(shown(ben.page, `Finished ${monDay(Date.now())}`, true)).toBeVisible()
  })

  expect(ana.errors).toEqual([])
  expect(ben.errors).toEqual([])
})

test('leaving: a member’s check-in goes and their part stays; the owner hands on; the last one deletes it', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [anaUid, benUid, cleoUid] = await accounts(t0, ANA, BEN, CLEO)
  await friends([anaUid, benUid, cleoUid], t0)
  const goalId = 'read20'
  const week = thisWeek()
  // Joined in this order: Ana (owner), Cleo, Ben.
  await setGoal(goalId, {
    name: 'Read 20 books',
    unit: 'books',
    target: 20,
    members: [anaUid, cleoUid, benUid],
    timezone: TZ,
    totals: { [anaUid]: 3, [cleoUid]: 2, [benUid]: 4 },
    createdAt: Date.now() - 20 * DAY,
  })
  await setCheckin(goalId, week, anaUid, {
    amount: 1,
    note: 'Dune',
    at: Date.now() - HOUR,
  })
  await setCheckin(goalId, week, benUid, {
    amount: 2,
    note: 'Two thrillers',
    at: Date.now() - HOUR,
  })
  const ana = await phone(browser)
  const ben = await phone(browser)
  const cleo = await phone(browser)

  await test.step('Ben leaves', async () => {
    await signIn(ana.page, ANA)
    await openFriends(ana.page)
    await openGoal(ana.page, 'Read 20 books')
    await expect(shown(section(ana.page, thisWeekHeader(week)), '“Two thrillers”', true)).toBeVisible()
    await signIn(ben.page, BEN)
    await openFriends(ben.page)
    await openGoal(ben.page, 'Read 20 books')
    // Not the owner: no Edit Goal.
    await button(ben.page, 'Goal options').click()
    const actions = ben.page.getByRole('dialog').last()
    await expect(actions.getByRole('button', { name: 'Edit Goal', exact: true })).toHaveCount(0)
    await actions.getByRole('button', { name: 'Leave Goal', exact: true }).click()
    await answer(ben.page, 'Leave', 'Your part stays in the total. To come back, you’ll need a new invite.')
    await expect(toast(ben.page, 'You left Read 20 books')).toBeVisible()
    await expect(goalRow(section(ben.page, 'Shared Goals'), 'Read 20 books')).toHaveCount(0)
    await expect.poll(() => hasCheckin(goalId, week, benUid)).toBe(false)
  })

  await test.step('On Ana’s phone his check-in is gone from this week; his part stays', async () => {
    const thisWeekSection = section(ana.page, thisWeekHeader(week))
    await expect(shown(thisWeekSection, '“Two thrillers”', true)).toHaveCount(0)
    await expect(shown(thisWeekSection, BEN.name, true)).toHaveCount(0)
    const parts = section(ana.page, 'Everyone’s part')
    await expect(shown(parts, BEN.name, true)).toBeVisible()
    await expect(shown(parts, '44% · Left', true)).toBeVisible()
    await expect(heroBar(ana.page)).toHaveAttribute('aria-label', '9 of 20 books')
    await expect(heroBar(ana.page).locator('.sg-bar__seg.is-former')).toHaveCount(1)
    await snap(ana.page, 'sg18-member-left')
  })

  await test.step('Ana (owner) leaves: Cleo, the earliest to join, becomes the owner', async () => {
    await signIn(cleo.page, CLEO)
    await openFriends(cleo.page)
    await openGoal(cleo.page, 'Read 20 books')
    await menu(ana.page, 'Leave Goal')
    await answer(ana.page, 'Leave', 'Cleo becomes the owner.')
    await expect(toast(ana.page, 'You left Read 20 books')).toBeVisible()
    await expect.poll(async () => (await readGoal(goalId))?.ownerId).toBe(cleoUid)
    await expect.poll(() => hasCheckin(goalId, week, anaUid)).toBe(false)
    await button(cleo.page, 'Goal options').click()
    const actions = cleo.page.getByRole('dialog').last()
    await expect(actions.getByRole('button', { name: 'Edit Goal', exact: true })).toBeVisible()
    await expect(actions.getByRole('button', { name: 'Invite Friends', exact: true })).toBeVisible()
    await snap(cleo.page, 'sg19-new-owner-menu')
    await actions.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(shown(section(cleo.page, 'Details'), CLEO.name, true)).toBeVisible()
  })

  await test.step('Cleo invites Ben back, then cancels the invite', async () => {
    await menu(cleo.page, 'Invite Friends')
    const s = sheet(cleo.page)
    await expect(s.getByRole('heading', { name: 'Invite Friends' })).toBeVisible()
    await expect(shown(s, '7 spots left. Only friends can be invited.', true)).toBeVisible()
    await s.getByRole('button', { name: BEN.name, exact: true }).click()
    await expect(shown(s, '6 spots left. Only friends can be invited.', true)).toBeVisible()
    await snap(cleo.page, 'sg20a-invite-friends')
    await button(s, 'Invite').click()
    await expect(toast(cleo.page, 'Invites sent')).toBeVisible()
    await expect.poll(async () => (await readGoal(goalId))?.invited).toEqual([benUid])
    // Ben's former part stays; his new invitation is its own row. The owner can take it back.
    const parts = section(cleo.page, 'Everyone’s part')
    await parts.getByRole('button', { name: `${BEN.name}, Invited`, exact: true }).click()
    await cleo.page.getByRole('dialog').last().getByRole('button', { name: 'Cancel Invite', exact: true }).click()
    await expect.poll(async () => (await readGoal(goalId))?.invited).toEqual([])
    await expect(shown(parts, 'Invited', true)).toHaveCount(0)
  })

  await test.step('Cleo, the last one, leaves: the goal is gone', async () => {
    await menu(cleo.page, 'Leave Goal')
    await answer(cleo.page, 'Leave', 'You’re the last one here. The goal and its check-ins will be gone.')
    await expect(toast(cleo.page, 'You left Read 20 books')).toBeVisible()
    await expect.poll(() => readGoal(goalId)).toBeNull()
  })

  expect(ana.errors).toEqual([])
  expect(ben.errors).toEqual([])
  expect(cleo.errors).toEqual([])
})

test('a check-in push’s link opens the goal on the Friends tab', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [anaUid, benUid] = await accounts(t0, ANA, BEN)
  await friends([anaUid, benUid], t0)
  const goalId = 'books20goal'
  await setGoal(goalId, {
    name: '20 books',
    unit: 'books',
    target: 20,
    members: [anaUid, benUid],
    timezone: TZ,
    totals: { [benUid]: 6 },
    createdAt: Date.now() - 9 * DAY,
  })
  const ana = await phone(browser)
  await signIn(ana.page, ANA)
  await ana.page.goto(`/?goal=${goalId}`)
  // On the Friends tab (its bar hides while a screen is pushed).
  await expect(ana.page.getByRole('tabpanel', { name: 'Friends' })).toBeVisible()
  await expect(ana.page.getByRole('heading', { name: '20 books', exact: true }).filter({ visible: true })).toBeVisible()
  await expect(heroBar(ana.page)).toHaveAttribute('aria-label', '6 of 20 books')
  expect(new URL(ana.page.url()).searchParams.get('goal')).toBeNull()
  await expect(button(ana.page, 'Check In')).toBeVisible()
  expect(ana.errors).toEqual([])
})

test('limits: offline, an ended goal, an invitee’s view', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [anaUid, benUid] = await accounts(t0, ANA, BEN)
  await friends([anaUid, benUid], t0)
  const week = thisWeek()
  // Ana's goal Ben is invited to, with this week's check-in.
  await setGoal('cycle', {
    name: 'Cycle 500 km',
    unit: 'km',
    target: 500,
    members: [anaUid],
    invited: [benUid],
    timezone: TZ,
    totals: { [anaUid]: 120 },
    createdAt: Date.now() - 10 * DAY,
  })
  await setCheckin('cycle', week, anaUid, {
    amount: 40,
    note: 'Hills',
    at: Date.now() - HOUR,
  })
  // A goal whose last day has passed: Ana is in it, Ben's invitation no longer counts.
  const lastDay = dayId(Date.now() - 3 * DAY)
  await setGoal('trip', {
    name: 'Trip fund',
    unit: 'USD',
    target: 5000,
    members: [anaUid],
    invited: [benUid],
    timezone: TZ,
    endsOn: lastDay,
    totals: { [anaUid]: 4200.5 },
    createdAt: Date.now() - 30 * DAY,
  })
  const ana = await phone(browser)
  const ben = await phone(browser)

  await test.step('Offline, a check-in fails and says so', async () => {
    await signIn(ana.page, ANA)
    await openFriends(ana.page)
    await openGoal(ana.page, 'Cycle 500 km')
    await ana.context.setOffline(true)
    const s = await checkIn(ana.page, '15', undefined, 'Edit Check-In')
    await button(s, 'Save').click()
    await expect(shown(s, 'You’re offline. Check your connection and try again.', true)).toBeVisible()
    await snap(ana.page, 'sg20-offline')
    await button(s, 'Cancel').click()
    await ana.context.setOffline(false)
    await expect(heroBar(ana.page)).toHaveAttribute('aria-label', '120 of 500 km')
  })

  await test.step('An ended goal is read-only and sits in Finished', async () => {
    await back(ana.page)
    await expect(goalRow(section(ana.page, 'Shared Goals'), 'Trip fund')).toHaveCount(0)
    await section(ana.page, 'Shared Goals')
      .getByRole('button', { name: /^Finished/ })
      .click()
    const endedLine = `$4,200.50 of $5,000 · Ended ${monDay(Date.parse(`${lastDay}T12:00:00Z`))}`
    await expect(shown(ana.page, endedLine, true)).toBeVisible()
    await ana.page
      .getByRole('button', { name: /^Trip fund/ })
      .filter({ visible: true })
      .first()
      .click()
    await expect(shown(ana.page, `Ended ${monDay(Date.parse(`${lastDay}T12:00:00Z`))}`, true)).toBeVisible()
    await expect(shown(ana.page, '$4,200.50', true)).toBeVisible()
    await expect(button(ana.page, 'Check In')).toHaveCount(0)
    await expect(section(ana.page, thisWeekHeader(week))).toHaveCount(0)
    await snap(ana.page, 'sg21-ended')
  })

  await test.step('Ben: the ended invitation isn’t counted or listed; the open one is', async () => {
    await signIn(ben.page, BEN)
    await expect(ben.page.getByRole('tab', { name: 'Friends, 1 new', exact: true })).toBeVisible()
    await openFriends(ben.page)
    const shared = section(ben.page, 'Shared Goals')
    await expect(goalRow(shared, 'Cycle 500 km')).toBeVisible()
    await expect(goalRow(shared, 'Trip fund')).toHaveCount(0)
  })

  await test.step('An invitee sees the goal, not its check-ins', async () => {
    await goalRow(section(ben.page, 'Shared Goals'), 'Cycle 500 km').click()
    await expect(ben.page.getByRole('heading', { name: 'Cycle 500 km', exact: true }).filter({ visible: true })).toBeVisible()
    await expect(shown(ben.page, 'Ana invited you.', true)).toBeVisible()
    await expect(button(ben.page, 'Join')).toBeVisible()
    await expect(button(ben.page, 'Decline')).toBeVisible()
    await expect(section(ben.page, thisWeekHeader(week))).toHaveCount(0)
    await expect(shown(ben.page, '“Hills”', true)).toHaveCount(0)
    await expect(shown(section(ben.page, 'Everyone’s part'), '120 km', true)).toBeVisible()
    await snap(ben.page, 'sg22-invitee')
  })

  await test.step('The ended goal’s invitation, opened by its link, offers Decline only', async () => {
    await ben.page.goto('/?goal=trip')
    await expect(ben.page.getByRole('heading', { name: 'Trip fund', exact: true }).filter({ visible: true })).toBeVisible()
    await expect(button(ben.page, 'Decline')).toBeVisible()
    await expect(button(ben.page, 'Join')).toHaveCount(0)
    await button(ben.page, 'Decline').click()
    await expect(toast(ben.page, 'Invitation declined')).toBeVisible()
    await expect.poll(async () => (await readGoal('trip'))?.invited).toEqual([])
  })

  expect(ana.errors).toEqual([])
  expect(ben.errors).toEqual([])
})

test('a check-in sheet that outlives its week moves to the new one, keeping what was typed', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [anaUid] = await accounts(t0, ANA)
  // The phone's clock: 75 seconds before this week ends in Rome. The goal's stored offset puts the rules' bound
  // (checkinClosesAt) exactly at that end, so the sheet's save is refused on the phone right after it.
  const week = thisWeek()
  const end = momentAt(addWeeks(week, 1), TZ, 0)
  const offEnd = utcOffsetMinutes(TZ, end)
  await setGoal('swim', {
    name: 'Swim 10 km',
    unit: 'km',
    target: 10,
    members: [anaUid],
    timezone: TZ,
    createdAt: Date.now() - 5 * DAY,
  })
  const { db } = await import('./emulator.ts')
  await db.doc('sharedGoals/swim').update({ utcOffsetMin: offEnd + 60 })
  const ana = await phone(browser)
  const start = Date.now()
  const phoneNow = end - 75_000
  await signIn(ana.page, ANA, `/?now=${iso(phoneNow)}`)
  await openFriends(ana.page)
  await openGoal(ana.page, 'Swim 10 km')
  const s = await checkIn(ana.page, '2.5', 'Pool')
  await expect(shown(s, checkinHeader('Swim 10 km', week), true)).toBeVisible()
  // Wait for the phone's clock to pass the week's end.
  const left = end + 2_000 - (phoneNow + (Date.now() - start))
  if (left > 0) await ana.page.waitForTimeout(left)
  await button(s, 'Save').click()
  await expect(shown(s, 'That week just ended. Check in for this week instead.', true)).toBeVisible()
  const next = goalWeek({ timezone: TZ }, end + 60_000)
  await expect(shown(s, checkinHeader('Swim 10 km', next), true)).toBeVisible()
  await expect(s.locator('.sg-amount__input')).toHaveValue('2.5')
  await expect(s.getByLabel('Note')).toHaveValue('Pool')
  await snap(ana.page, 'sg23-week-ended')
  expect(ana.errors).toEqual([])
})
