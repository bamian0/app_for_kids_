// Batch 3 friends end to end (SPEC §11.2, §11.6, §11.9.1–§11.9.4, §11.11), in iPhone-sized browsers against the
// emulators with the real rules: adding a friend with a code and with a link, the silent decline and the 30-day
// wait after a cancel, removing a friend, the showcase and its editor, People in Your Spaces, the fourth tab with
// its badge and Help, and deleting an account. Accounts, spaces, rings and stats (the job's) are seeded; what
// people do goes through the UI. The phones run on the real clock (rings and earnings name this month and the
// last one), in Rome like every e2e phone.
//
// Run alone:
//   npx firebase emulators:exec --only auth,firestore --project demo-stakes "npx playwright test batch3-friends"
import { expect, test, type Locator, type Page } from '@playwright/test'
import { addMonths, monthIdForWeek, utcOffsetMinutes, weekIdFor, weekIdsInMonth } from '../../src/domain/time.ts'
import { createAccount, db, moneyDoc, resetEmulators, setEarning, setMoneyState, setSpace, ts } from './emulator.ts'
import { addBoughtGoal, friendCodeOf, leftovers, readPair, readShowcase, setFriendCode, setPair, setRing, setStats } from './friends-seed.ts'
import { whenText } from '../../src/screens/friends/copy.ts'
import { centerOn, phone, sheet, shown, snap } from './helpers.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TZ = 'Europe/Rome'

type Who = { name: string; email: string; password: string }
const person = (name: string, email: string): Who => ({ name, email, password: 'secret123' })
const ANA = person('Ana Silva', 'ana@example.com')
const BEN = person('Ben Carter', 'ben@example.com')
const CLEO = person('Cleo Duarte', 'cleo@example.com')
const COLORS: Record<string, string> = { Ana: '#AF52DE', Ben: '#34C759', Cleo: '#FF9500' }

const ANA_CODE = 'ANAS2345'
const BEN_CODE = 'BENC6789'
const CLEO_CODE = 'CLEA4567'
const SPACE_ID = 'film-club'
const SPACE = { name: 'Film Club', reward: 'Dinner on them', penalty: 'Coffee for everyone' }
const SPACE_CODE = 'FCLB2345'

// ---------- Time and words ----------

const MONTH_NAME = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })
const monthName = (monthId: string) => MONTH_NAME.format(Date.UTC(Number(monthId.slice(0, 4)), Number(monthId.slice(5, 7)) - 1, 1))
/** This app-month on the phones' clock (the month of this week's Friday, in Rome). */
const thisMonth = () => monthIdForWeek(weekIdFor(Date.now(), TZ))
/** "Nov 19" on the phones' clock (with the year when it isn't this one). */
function monDay(ms: number): string {
  const sameYear = new Date(ms).getUTCFullYear() === new Date().getUTCFullYear()
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: TZ }).format(ms)
}

// ---------- Seeding ----------

async function accounts(at: number, ...people: Who[]): Promise<string[]> {
  const uids: string[] = []
  for (const who of people) uids.push(await createAccount(who, COLORS[who.name.split(' ')[0]], at))
  return uids
}

function seedSpace(members: string[], at: number) {
  return setSpace(SPACE_ID, { ...SPACE, members, timezone: TZ, utcOffsetMin: utcOffsetMinutes(TZ, Date.now()), inviteCode: SPACE_CODE, at })
}

// ---------- Browser ----------

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })
/** The Friends tab, with or without its badge ("Friends, 2 new"). */
const friendsTab = (page: Page) => page.getByRole('tab', { name: /^Friends/ })
const toast = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text }).first()
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A person's row (its button is named after them, then its line). */
const personRow = (scope: Page | Locator, name: string) => scope.getByRole('button', { name: new RegExp(`^${esc(name)}(,|$)`) }).filter({ visible: true }).first()
/** The visible section with this header. */
const section = (scope: Page | Locator, header: string) => {
  const page = 'goto' in scope ? scope : scope.page()
  return scope
    .locator('.ui-section')
    .filter({ visible: true })
    .filter({ has: page.locator('.ui-section__header-text', { hasText: new RegExp(`^${esc(header)}$`) }) })
    .first()
}

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

async function openAddFriend(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Add Friend', exact: true }).filter({ visible: true }).first().click()
  const add = sheet(page)
  await expect(add.getByRole('heading', { name: 'Add Friend' })).toBeVisible()
  return add
}

async function answer(page: Page, button: string, text?: string): Promise<void> {
  const alert = page.getByRole('alertdialog')
  await expect(alert).toBeVisible()
  if (text) await expect(alert).toContainText(text)
  await alert.getByRole('button', { name: button, exact: true }).click()
  await expect(alert).toHaveCount(0)
}

async function openProfile(page: Page): Promise<Locator> {
  await tab(page, 'Spaces').click()
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  const profile = sheet(page)
  await expect(profile.getByRole('heading', { name: 'Profile' })).toBeVisible()
  return profile
}

test.beforeEach(async () => {
  await resetEmulators()
})

test('a friend request by code: the badge, Accept, and both rings', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [anaUid, benUid] = await accounts(t0, ANA, BEN)
  // The job's rings: Ana at 92% this month so far; Ben has no score yet.
  await setRing(anaUid, { monthId: thisMonth(), score: 92.4, final: false, spaces: 2 })
  const month = monthName(thisMonth())
  const ana = await phone(browser)
  const ben = await phone(browser)

  let code = ''
  await test.step('Ana’s Friends tab starts empty; Add Friend shows her code', async () => {
    await signIn(ana.page, ANA)
    await expect(ana.page.getByRole('tab')).toHaveText(['Spaces', 'Overview', 'Goals', 'Friends'])
    await openFriends(ana.page)
    await expect(shown(ana.page, 'Better with friends', true)).toBeVisible()
    await expect(shown(ana.page, 'Add friends with your link or code. You’ll see how their month is going, and you can fill shared goals together.', true)).toBeVisible()
    await snap(ana.page, 'fr01-empty')
    const add = await openAddFriend(ana.page)
    await expect(add.locator('.fr-code__value')).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    code = (await add.locator('.fr-code__value').innerText()).trim()
    await expect.poll(() => friendCodeOf(anaUid)).toBe(code.replace('-', ''))
    await expect(shown(add, 'Anyone with your link or code can ask to be your friend. Nothing changes until you accept.', true)).toBeVisible()
    await snap(ana.page, 'fr02-add-friend')
    await add.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(ana.page.getByRole('dialog')).toHaveCount(0)
  })

  await test.step('Ben types it with a dash, sees Ana and adds her', async () => {
    await signIn(ben.page, BEN)
    await openFriends(ben.page)
    const add = await openAddFriend(ben.page)
    await add.getByLabel('Friend’s code or link').fill(code.toLowerCase())
    await expect(personRow(add, ANA.name)).toBeVisible()
    await snap(ben.page, 'fr03-code-found')
    await add.getByRole('button', { name: `Add ${ANA.name}`, exact: true }).click()
    await expect(toast(ben.page, 'Request sent')).toBeVisible()
    await expect(toast(ben.page, 'Ana sees it next time they open Stakes.')).toBeVisible()
    await expect(shown(add, 'Requested', true)).toBeVisible()
    await expect.poll(async () => (await readPair(anaUid, benUid))?.state).toBe('asked')
    await add.getByRole('button', { name: 'Done', exact: true }).click()
    // Ben's Sent section has it.
    await expect(shown(section(ben.page, 'Sent'), 'Requested today', true)).toBeVisible()
  })

  await test.step('Ana’s Friends tab shows a badge; she accepts', async () => {
    await tab(ana.page, 'Spaces').click()
    await expect(ana.page.getByRole('tab', { name: 'Friends, 1 new', exact: true })).toBeVisible()
    await expect(ana.page.locator('.ui-tab-bar__badge')).toHaveText('1')
    await snap(ana.page, 'fr04-badge')
    await openFriends(ana.page)
    const requests = section(ana.page, 'Requests')
    await expect(personRow(requests, BEN.name)).toHaveAccessibleName(`${BEN.name}, Wants to be friends · today`)
    await snap(ana.page, 'fr05-request')
    await requests.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(toast(ana.page, 'You and Ben are friends')).toBeVisible()
    await expect(ana.page.getByRole('tab', { name: 'Friends', exact: true })).toBeVisible()
    await expect.poll(async () => (await readPair(anaUid, benUid))?.state).toBe('friends')
  })

  await test.step('Both list each other with rings', async () => {
    const anaFriends = section(ana.page, 'Friends')
    await expect(personRow(anaFriends, BEN.name)).toHaveAccessibleName(`${BEN.name}, No score yet this month`)
    // You first, titled You (as Find My's Me), with your own ring line.
    await expect(personRow(anaFriends, 'You')).toHaveAccessibleName(`You, 92% · ${month} so far`)
    await expect(shown(ana.page, 'Rings show each friend’s score this month so far, across their spaces. They update after each week’s reviews are due.', true)).toBeVisible()
    await snap(ana.page, 'fr06-friends-ana')
    const benFriends = section(ben.page, 'Friends')
    await expect(personRow(benFriends, ANA.name)).toHaveAccessibleName(`${ANA.name}, 92% · ${month} so far`)
    // 92%: the iridescent ring.
    await expect(benFriends.locator('.fr-mini-ring.ui-ring--met')).toHaveCount(1)
    await expect(section(ben.page, 'Sent')).toHaveCount(0)
    await snap(ben.page, 'fr07-friends-ben')
    // Ana's showcase from Ben's list: her ring, across two spaces.
    await personRow(benFriends, ANA.name).click()
    await expect(ben.page.getByRole('heading', { name: ANA.name })).toBeVisible()
    // The number in the ring, the month under it; VoiceOver reads the whole line.
    const ring = ben.page.locator('.fr-ring').filter({ visible: true })
    await expect(ring.getByRole('img', { name: `92% · ${month} so far` })).toBeVisible()
    await expect(ring.locator('.ui-ring__value')).toHaveText('92%')
    await expect(shown(ring, `${month} so far`, true)).toBeVisible()
    await expect(shown(ben.page, 'Across 2 spaces', true)).toBeVisible()
    await expect(shown(ben.page, /^Friends since /)).toBeVisible()
    await snap(ben.page, 'fr08-showcase-friend')
  })

  expect(ana.errors).toEqual([])
  expect(ben.errors).toEqual([])
})

test('a friend link: Welcome, sign-up, Add Friend on the link; a space invite isn’t a friend code', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [anaUid] = await accounts(t0, ANA)
  await setFriendCode(ANA_CODE, anaUid, t0)
  await seedSpace([anaUid], t0)
  const cleo = await phone(browser)
  const ana = await phone(browser)

  await test.step('Signed out, the link says a friend sent it', async () => {
    await cleo.page.goto(`/?friend=${ANA_CODE}`)
    await expect(shown(cleo.page, 'A friend sent you their Stakes link. Sign in or create an account to see who.', true)).toBeVisible()
    // The code leaves the address bar.
    expect(new URL(cleo.page.url()).searchParams.get('friend')).toBeNull()
    await snap(cleo.page, 'fr09-welcome-link')
  })

  await test.step('After sign-up, Friends opens with Add Friend on Ana', async () => {
    await cleo.page.getByRole('button', { name: 'Create Account', exact: true }).click()
    await cleo.page.getByLabel('Name').fill(CLEO.name)
    await cleo.page.getByLabel('Email').fill(CLEO.email)
    await cleo.page.getByLabel('Password').fill(CLEO.password)
    await cleo.page.getByRole('button', { name: 'Create Account', exact: true }).click()
    await expect(friendsTab(cleo.page)).toHaveAttribute('aria-selected', 'true')
    const add = sheet(cleo.page)
    await expect(add.getByLabel('Friend’s code or link')).toHaveValue(`${ANA_CODE.slice(0, 4)}-${ANA_CODE.slice(4)}`)
    await expect(personRow(add, ANA.name)).toBeVisible()
    await snap(cleo.page, 'fr10-link-add')
    await add.getByRole('button', { name: `Add ${ANA.name}`, exact: true }).click()
    await expect(toast(cleo.page, 'Request sent')).toBeVisible()
  })

  await test.step('A space invite in Add Friend points to Spaces', async () => {
    const add = sheet(cleo.page)
    const field = add.getByLabel('Friend’s code or link')
    await field.fill(SPACE_CODE)
    await expect(shown(add, 'That’s a space invite. Join it from Spaces.', true)).toBeVisible()
    await field.fill(`https://stakes.example/?join=${SPACE_CODE}`)
    await expect(shown(add, 'That’s a space invite. Join it from Spaces.', true)).toBeVisible()
    await snap(cleo.page, 'fr11-space-invite')
    await field.fill('ZZZZ-ZZZZ')
    await expect(shown(add, 'No one has that code. Check it and try again.', true)).toBeVisible()
    // A code with a letter codes never use says which.
    await field.fill('anao2345')
    await expect(field).toHaveValue('ANAO-2345')
    await expect(shown(add, 'Codes never use “O”. Check the code with your friend.', true)).toBeVisible()
    await add.getByRole('button', { name: 'Done', exact: true }).click()
  })

  await test.step('Ana accepts', async () => {
    await signIn(ana.page, ANA)
    await openFriends(ana.page)
    await section(ana.page, 'Requests').getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(toast(ana.page, 'You and Cleo are friends')).toBeVisible()
    await expect(personRow(section(cleo.page, 'Friends'), ANA.name)).toBeVisible()
  })

  await test.step('Join with Code knows a friend code', async () => {
    await tab(cleo.page, 'Spaces').click()
    await cleo.page.getByRole('button', { name: 'New space or join' }).click()
    await cleo.page.getByRole('dialog').getByRole('button', { name: 'Join with Code', exact: true }).click()
    const join = sheet(cleo.page)
    await join.getByLabel('Invite code').fill(ANA_CODE)
    await expect(shown(join, 'That’s a friend code. Add them in Friends.', true)).toBeVisible()
  })

  expect(cleo.errors).toEqual([])
  expect(ana.errors).toEqual([])
})

test('a silent decline, a cancel that waits 30 days, and the other side adding instead', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [benUid, cleoUid] = await accounts(t0, BEN, CLEO)
  await setFriendCode(BEN_CODE, benUid, t0)
  await setFriendCode(CLEO_CODE, cleoUid, t0)
  const askedAt = Date.now() - MINUTE
  await setPair(cleoUid, benUid, { by: cleoUid, state: 'asked', at: askedAt })
  const ben = await phone(browser)
  const cleo = await phone(browser)

  await test.step('Ben declines Cleo’s request', async () => {
    await signIn(ben.page, BEN)
    await openFriends(ben.page)
    await section(ben.page, 'Requests').getByRole('button', { name: 'Decline', exact: true }).click()
    await expect(toast(ben.page, 'Request declined')).toBeVisible()
    await expect(toast(ben.page, 'Cleo won’t be told.')).toBeVisible()
    await expect(section(ben.page, 'Requests')).toHaveCount(0)
    await expect.poll(async () => (await readPair(benUid, cleoUid))?.state).toBe('declined')
  })

  await test.step('Cleo still sees Requested, and cancels', async () => {
    await signIn(cleo.page, CLEO)
    await openFriends(cleo.page)
    const sent = section(cleo.page, 'Sent')
    // "today", or "yesterday" when the run starts in the minute after midnight on the phone's clock.
    await expect(personRow(sent, BEN.name)).toHaveAccessibleName(`${BEN.name}, Requested ${whenText(askedAt, Date.now(), TZ)}`)
    await snap(cleo.page, 'fr12-sent')
    await sent.getByRole('button', { name: 'Cancel', exact: true }).click()
    await answer(cleo.page, 'Cancel Request', 'Ben won’t see it anymore. You can ask again in 30 days.')
    await expect(toast(cleo.page, 'Request canceled')).toBeVisible()
    await expect(section(cleo.page, 'Sent')).toHaveCount(0)
    await expect.poll(async () => (await readPair(benUid, cleoUid))?.state).toBe('withdrawn')
  })

  await test.step('Cleo’s Add Friend says when she can ask again; Ben sees nothing', async () => {
    const pair = await readPair(benUid, cleoUid)
    const add = await openAddFriend(cleo.page)
    await add.getByLabel('Friend’s code or link').fill(BEN_CODE)
    await expect(personRow(add, BEN.name)).toBeVisible()
    await expect(shown(add, `Ask again ${monDay((pair?.at ?? 0) + 30 * DAY)}`, true)).toBeVisible()
    await expect(add.getByRole('button', { name: `Add ${BEN.name}` })).toHaveCount(0)
    await snap(cleo.page, 'fr13-ask-again')
    await add.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(section(ben.page, 'Requests')).toHaveCount(0)
    await expect(ben.page.getByRole('tab', { name: 'Friends', exact: true })).toBeVisible()
  })

  await test.step('Ben adds Cleo; she gets his request and accepts', async () => {
    const add = await openAddFriend(ben.page)
    await add.getByLabel('Friend’s code or link').fill(CLEO_CODE)
    await add.getByRole('button', { name: `Add ${CLEO.name}`, exact: true }).click()
    await expect(toast(ben.page, 'Request sent')).toBeVisible()
    await add.getByRole('button', { name: 'Done', exact: true }).click()
    await expect.poll(async () => await readPair(benUid, cleoUid)).toMatchObject({ by: benUid, state: 'asked' })
    await expect(cleo.page.getByRole('tab', { name: 'Friends, 1 new', exact: true })).toBeVisible()
    await section(cleo.page, 'Requests').getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(toast(cleo.page, 'You and Ben are friends')).toBeVisible()
    await expect(personRow(section(ben.page, 'Friends'), CLEO.name)).toBeVisible()
  })

  expect(ben.errors).toEqual([])
  expect(cleo.errors).toEqual([])
})

test('removing a friend from their showcase', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [anaUid, benUid] = await accounts(t0, ANA, BEN)
  await setPair(anaUid, benUid, { by: anaUid, state: 'friends', at: t0 + DAY })
  await setRing(anaUid, { monthId: thisMonth(), score: 80, final: false, spaces: 1 })
  const ana = await phone(browser)
  const ben = await phone(browser)
  await signIn(ana.page, ANA)
  await openFriends(ana.page)
  await expect(personRow(section(ana.page, 'Friends'), BEN.name)).toBeVisible()

  await signIn(ben.page, BEN)
  await openFriends(ben.page)
  await personRow(section(ben.page, 'Friends'), ANA.name).click()
  await expect(ben.page.getByRole('heading', { name: ANA.name })).toBeVisible()
  await ben.page.getByRole('button', { name: 'Remove Friend', exact: true }).click()
  await answer(
    ben.page,
    'Remove',
    'You’ll stop seeing each other’s rings. Shared goals you’re both in stay as they are. Either of you can ask again later.',
  )
  await expect(toast(ben.page, 'Removed Ana')).toBeVisible()
  await expect(ben.page.getByRole('heading', { name: 'Friends', exact: true }).filter({ visible: true })).toBeVisible()
  await expect(shown(ben.page, 'Better with friends', true)).toBeVisible()
  await expect(shown(ana.page, 'Better with friends', true)).toBeVisible()
  expect(await readPair(anaUid, benUid)).toBeNull()
  await snap(ben.page, 'fr14-removed')
  expect(ana.errors).toEqual([])
  expect(ben.errors).toEqual([])
})

test('the showcase: switches, what friends and strangers see, offline', async ({ browser }) => {
  const t0 = Date.now() - 60 * DAY
  const [anaUid, benUid] = await accounts(t0, ANA, BEN, CLEO)
  await setPair(anaUid, benUid, { by: benUid, state: 'friends', at: t0 + DAY })
  await setFriendCode(ANA_CODE, anaUid, t0)
  await setRing(anaUid, { monthId: thisMonth(), score: 95, final: false, spaces: 1 })
  await setStats(anaUid, { monthsCleared: 2, currentStreak: 2, bestStreak: 3, weeksPlayed: 11, finishedMonths: 3, since: '2026-10' })
  // Ana's money: a goal she bought, and what her tasks earned last month (a week whose Friday is in it).
  const lastMonth = addMonths(thisMonth(), -1)
  const lastMonthWeek = weekIdsInMonth(lastMonth)[1]
  await setMoneyState(anaUid, { currency: 'USD', baseline: 100, baselineAt: t0 })
  await addBoughtGoal(anaUid, { name: 'Road bike', amount: 450, at: Date.now() - 5 * DAY })
  await setEarning(anaUid, { spaceId: SPACE_ID, weekId: lastMonthWeek, taskId: 't1', title: 'Tutoring', amount: 321.5, earnedAt: Date.now() - 30 * DAY })
  const last = monthName(lastMonth)
  const ana = await phone(browser)
  const ben = await phone(browser)
  const cleo = await phone(browser)

  await test.step('Ana’s Profile has a Showcase row; the editor turns on achieved goals and earnings', async () => {
    await signIn(ana.page, ANA)
    const profile = await openProfile(ana.page)
    await expect(profile.getByRole('button', { name: /^Showcase/ })).toContainText('Stats')
    await expect(shown(profile, 'Choose what anyone on Stakes can see on your profile.', true)).toBeVisible()
    await profile.getByRole('button', { name: /^Showcase/ }).click()
    await expect(profile.getByRole('heading', { name: 'Showcase' })).toBeVisible()
    await expect(shown(profile, 'Anyone signed in to Stakes can see your showcase.', true)).toBeVisible()
    await expect(shown(profile, `What your tasks earned in ${last}`, true)).toBeVisible()
    await expect(profile.getByRole('switch', { name: 'Stats' })).toBeChecked()
    await snap(ana.page, 'fr15-editor')
    await profile.getByRole('switch', { name: 'Achieved Goals' }).click()
    await answer(ana.page, 'Show', 'Anyone on Stakes can see the names of goals you marked as bought, and when.')
    await expect(profile.getByRole('switch', { name: 'Achieved Goals' })).toBeChecked()
    await expect.poll(async () => (await readShowcase(anaUid))?.items).toEqual(['achieved'])
    await profile.getByRole('switch', { name: 'Last Month’s Earnings' }).click()
    await answer(ana.page, 'Show', `Anyone on Stakes can see what your tasks earned in ${last}.`)
    await expect.poll(async () => (await readShowcase(anaUid))?.items).toEqual(['achieved', 'earnings'])
    await expect(profile.getByRole('switch', { name: 'Last Month’s Earnings' })).toBeChecked()
    await snap(ana.page, 'fr16-editor-on')
  })

  await test.step('Ana sees her own showcase', async () => {
    const profile = sheet(ana.page)
    await profile.getByRole('button', { name: 'See Your Showcase' }).click()
    await expect(shown(profile, 'Your showcase', true)).toBeVisible()
    await expect(shown(profile, 'Only friends see your ring.', true)).toBeVisible()
    await expect(shown(profile, 'Road bike', true)).toBeVisible()
    await snap(ana.page, 'fr17-own-showcase')
    await profile.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(profile.getByRole('heading', { name: 'Showcase' })).toBeVisible()
  })

  await test.step('Ben, a friend, sees her ring, stats, achieved goal and earnings', async () => {
    await signIn(ben.page, BEN)
    await openFriends(ben.page)
    await personRow(section(ben.page, 'Friends'), ANA.name).click()
    await expect(ben.page.getByRole('heading', { name: ANA.name })).toBeVisible()
    await expect(ben.page.locator('.fr-ring').filter({ visible: true })).toHaveCount(1)
    const stats = section(ben.page, 'Stats')
    for (const label of ['Months at 90%+', 'Month streak', 'Best streak', 'Weeks played']) await expect(shown(stats, label, true)).toBeVisible()
    await expect(stats.locator('.fr-stat__value')).toHaveText(['2', '2', '3', '11'])
    await expect(shown(ben.page, 'From finished months since October 2026. Weeks played counts this month too.', true)).toBeVisible()
    await expect(shown(section(ben.page, 'Achieved'), 'Road bike', true)).toBeVisible()
    await expect(shown(section(ben.page, 'Last Month'), `Earned in ${last}`, true)).toBeVisible()
    await expect(shown(section(ben.page, 'Last Month'), '$321.50', true)).toBeVisible()
    await centerOn(section(ben.page, 'Achieved'))
    await snap(ben.page, 'fr18-showcase-money')
  })

  await test.step('Ana turns earnings off; Ben’s view drops it', async () => {
    const profile = sheet(ana.page)
    await profile.getByRole('switch', { name: 'Last Month’s Earnings' }).click()
    // Turning off never asks.
    await expect(ana.page.getByRole('alertdialog')).toHaveCount(0)
    await expect.poll(async () => (await readShowcase(anaUid))?.items).toEqual(['achieved'])
    await expect(section(ben.page, 'Last Month')).toHaveCount(0)
    await expect(shown(section(ben.page, 'Achieved'), 'Road bike', true)).toBeVisible()
  })

  await test.step('Offline, a switch fails and reverts', async () => {
    await ana.context.setOffline(true)
    const profile = sheet(ana.page)
    const goals = profile.getByRole('switch', { name: 'Current Goals' })
    await goals.click()
    await answer(ana.page, 'Show')
    await expect(toast(ana.page, 'Couldn’t update your showcase')).toBeVisible()
    await expect(goals).not.toBeChecked()
    await snap(ana.page, 'fr19-offline')
    await ana.context.setOffline(false)
    expect((await readShowcase(anaUid))?.show).toEqual({ stats: true, achieved: true, goals: false, earnings: false })
  })

  await test.step('A stranger sees the showcase but no ring', async () => {
    await signIn(cleo.page, CLEO)
    await openFriends(cleo.page)
    const add = await openAddFriend(cleo.page)
    await add.getByLabel('Friend’s code or link').fill(ANA_CODE)
    await personRow(add, ANA.name).click()
    await expect(add.getByRole('heading', { name: ANA.name })).toBeVisible()
    await expect(shown(add, 'Road bike', true)).toBeVisible()
    await expect(shown(add, 'Months at 90%+', true)).toBeVisible()
    await expect(add.locator('.fr-ring')).toHaveCount(0)
    await expect(add.getByRole('button', { name: 'Add Friend', exact: true })).toBeVisible()
    await snap(cleo.page, 'fr20-showcase-stranger')
  })

  expect(ana.errors).toEqual([])
  expect(ben.errors).toEqual([])
  expect(cleo.errors).toEqual([])
})

test('People in Your Spaces: space members who aren’t friends can add each other', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [anaUid, benUid] = await accounts(t0, ANA, BEN)
  await seedSpace([anaUid, benUid], t0)
  const ana = await phone(browser)
  const ben = await phone(browser)

  await signIn(ana.page, ANA)
  await openFriends(ana.page)
  await expect(shown(ana.page, 'Add people from your spaces below, or anyone with your link or code. You’ll see how their month is going, and you can fill shared goals together.', true)).toBeVisible()
  const people = section(ana.page, 'People in Your Spaces')
  await expect(personRow(people, BEN.name)).toHaveAccessibleName(`${BEN.name}, In ${SPACE.name}`)
  await expect(shown(ana.page, 'People you share a space with. Add them to see each other’s rings.', true)).toBeVisible()
  await snap(ana.page, 'fr21-people')

  const add = await openAddFriend(ana.page)
  await expect(personRow(section(add, 'People in Your Spaces'), BEN.name)).toBeVisible()
  await add.getByRole('button', { name: `Add ${BEN.name}`, exact: true }).click()
  await expect(toast(ana.page, 'Request sent')).toBeVisible()
  // The row stays in the sheet and says so.
  await expect(shown(section(add, 'People in Your Spaces'), 'Requested', true)).toBeVisible()
  await snap(ana.page, 'fr22-people-sheet')
  await add.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(personRow(section(ana.page, 'Sent'), BEN.name)).toBeVisible()
  await expect(section(ana.page, 'People in Your Spaces')).toHaveCount(0)

  await signIn(ben.page, BEN)
  await openFriends(ben.page)
  await section(ben.page, 'Requests').getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(toast(ben.page, 'You and Ana are friends')).toBeVisible()
  await expect(section(ben.page, 'People in Your Spaces')).toHaveCount(0)
  await expect.poll(async () => (await readPair(anaUid, benUid))?.state).toBe('friends')
  expect(ana.errors).toEqual([])
  expect(ben.errors).toEqual([])
})

test('four tabs, the Friends tab remembered, Help, and no private money on Friends', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [anaUid] = await accounts(t0, ANA)
  // Distinctive private amounts: a balance and an earning this month.
  await setMoneyState(anaUid, { currency: 'USD', baseline: 98765.43, baselineAt: t0 })
  await setEarning(anaUid, { spaceId: SPACE_ID, weekId: weekIdFor(Date.now(), TZ), taskId: 't9', title: 'Design job', amount: 4321.09, earnedAt: Date.now() - HOUR })
  const ana = await phone(browser)
  await signIn(ana.page, ANA)
  await expect(ana.page.getByRole('tab')).toHaveText(['Spaces', 'Overview', 'Goals', 'Friends'])
  await openFriends(ana.page)
  await ana.page.reload()
  await expect(friendsTab(ana.page)).toHaveAttribute('aria-selected', 'true')

  // Help from the Friends tab has the new section.
  await ana.page.getByRole('button', { name: 'Help', exact: true }).filter({ visible: true }).click()
  const help = ana.page.getByRole('dialog', { name: 'Help' })
  await expect(help.getByRole('heading', { name: 'Friends and shared goals' })).toBeVisible()
  await expect(shown(help, 'Your profile shows only what you switch on, to anyone on Stakes.', true)).toBeVisible()
  await help.getByRole('heading', { name: 'Friends and shared goals' }).scrollIntoViewIfNeeded()
  await snap(ana.page, 'fr23-help')
  await help.getByRole('button', { name: 'Done', exact: true }).click()

  // The Goals tab shows the balance (every tab is mounted); the Friends tab shows none of it.
  await tab(ana.page, 'Goals').click()
  await expect(shown(ana.page, /\$103,086\.52/)).toBeVisible()
  await openFriends(ana.page)
  const panel = ana.page.getByRole('tabpanel').filter({ visible: true })
  const text = (await panel.textContent()) ?? ''
  expect(text).not.toMatch(/98,765|4,321|103,086/)
  expect(text).not.toMatch(/\$\s?\d/)
  await snap(ana.page, 'fr24-tabs')
  expect(ana.errors).toEqual([])
})

test('deleting an account leaves friends’ lists clean', async ({ browser }) => {
  const t0 = Date.now() - 40 * DAY
  const [anaUid, benUid] = await accounts(t0, ANA, BEN)
  await setPair(anaUid, benUid, { by: anaUid, state: 'friends', at: t0 + DAY })
  await setRing(anaUid, { monthId: thisMonth(), score: 70, final: false, spaces: 1 })
  await setStats(anaUid, { monthsCleared: 0, currentStreak: 0, bestStreak: 0, weeksPlayed: 2, finishedMonths: 0, since: '2026-10' })
  await setFriendCode(ANA_CODE, anaUid, t0)
  await db.doc(`scores/${anaUid}`).set({ months: {}, updatedAt: ts(t0) })
  const ana = await phone(browser)
  const ben = await phone(browser)
  await signIn(ben.page, BEN)
  await openFriends(ben.page)
  await expect(personRow(section(ben.page, 'Friends'), ANA.name)).toBeVisible()

  await signIn(ana.page, ANA)
  const profile = await openProfile(ana.page)
  await profile.getByRole('button', { name: 'Delete Account' }).click()
  await profile.getByLabel('Password').fill(ANA.password)
  await profile.getByRole('button', { name: 'Delete Account', exact: true }).click()
  await answer(ana.page, 'Delete')
  await expect(ana.page.getByRole('button', { name: 'I Have an Account' })).toBeVisible()

  await expect(personRow(ben.page, ANA.name)).toHaveCount(0)
  await expect(shown(ben.page, 'Better with friends', true)).toBeVisible()
  await expect(shown(ben.page, 'Can’t load your friends', true)).toHaveCount(0)
  await expect.poll(async () => await leftovers(anaUid)).toEqual([])
  expect((await moneyDoc(anaUid, 'money/state').get()).exists).toBe(false)
  await snap(ben.page, 'fr25-after-delete')
  expect(ben.errors).toEqual([])
})
