// Screenshots of batch 2 states the scenario specs don't pass through (build plan §5 item 11): the worst-case
// Space screen top at 375 × 667, the stakes card's leaver line, the Stakes screen with new stakes waiting, the
// editor in every mode, the Agree alert's other wordings, the asker's lapsed pause, Space Settings for a judge
// who isn't the owner, the Spaces cards, Overview with a paused space and a judge's month, and Create and Join
// with Only Rate Friends. Nothing here writes: every state is seeded, and the phone only looks.
//
// It runs only when screenshots are asked for:
//   E2E_SCREENSHOTS=<dir> E2E_WIDTHS=375,430 npx firebase emulators:exec --only auth,firestore \
//     --project demo-stakes "npx playwright test screens"
import { expect, test, type Locator, type Page } from '@playwright/test'
import { addMonths, momentAt, monthIdForWeek, utcOffsetMinutes, weekBounds, weekIdFor, weekIdsInMonth } from '../../src/domain/time.ts'
import type { WeekSchedule } from '../../src/domain/types.ts'
import { createAccount, pairOf, resetEmulators, setPlan, setPlayedWeek, setSpace, setStakes, setWeek, spaceDoc, ts, type SeedStakes } from './emulator.ts'
import { centerOn, phone, sheet, shown, snap } from './helpers.ts'

test.skip(!process.env.E2E_SCREENSHOTS, 'Screenshots only: set E2E_SCREENSHOTS to a folder.')

const HOUR = 3_600_000
const DAY = 24 * HOUR
const TZ = 'Europe/Rome'

type Who = { name: string; email: string; password: string }
const person = (name: string, email: string): Who => ({ name, email, password: 'secret123' })
const MARCO = person('Marco Rossi', 'marco@example.com')
const LENA = person('Lena Fischer', 'lena@example.com')
const SAM = person('Sam Okafor', 'sam@example.com')
const KIM = person('Kim Park', 'kim@example.com')
const BEN = person('Ben Carter', 'ben@example.com')
const COLORS: Record<string, string> = { Marco: '#FF9500', Lena: '#AF52DE', Sam: '#34C759', Kim: '#FF2D55', Ben: '#FFCC00' }

const HOUSE = { reward: 'Dinner at Da Enzo, on them', penalty: 'Coffee for everyone, for a week' }
const TASKS = [
  { id: 't1', title: 'Finish the Lavazza edit' },
  { id: 't2', title: 'Two gym sessions' },
]

const iso = (ms: number) => new Date(ms).toISOString()
const on = (weekId: string, day: number, hour: number) => momentAt(weekId, TZ, day * 1440 + hour * 60)
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })
const stakesCard = (page: Page) => page.locator('.sk-card').filter({ visible: true }).first()
const section = (scope: Page | Locator, text: string | RegExp) => scope.locator('.ui-section').filter({ visible: true }).filter({ hasText: text }).first()

async function signIn(page: Page, who: Who, nowMs: number): Promise<void> {
  await page.goto(`/?now=${iso(nowMs)}`)
  await page.getByRole('button', { name: 'I Have an Account' }).click()
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await expect(tab(page, 'Spaces')).toHaveAttribute('aria-selected', 'true')
}

async function travel(page: Page, nowMs: number): Promise<void> {
  await page.goto(`/?now=${iso(nowMs)}`)
  await expect(tab(page, 'Spaces')).toHaveAttribute('aria-selected', 'true')
}

async function openSpace(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(name) }).first().click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

async function back(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Back/ }).filter({ visible: true }).first().click()
}

test('batch 2 screens the scenarios don’t reach', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const at = t0 - 120 * DAY
  const [marco, lena, sam, kim, ben] = await Promise.all([MARCO, LENA, SAM, KIM, BEN].map((w) => createAccount(w, COLORS[w.name.split(' ')[0]], at)))
  const offset = utcOffsetMinutes(TZ, t0)

  // The month after the real one, so every seeded time is ahead of the server's clock; Wednesday noon of its
  // second week.
  const month = addMonths(monthIdForWeek(weekIdFor(t0, TZ)), 1)
  const weeks = weekIdsInMonth(month)
  const [w0, w1, w2] = weeks
  const now = on(w1, 2, 12)
  const firstLock = weekBounds(w0, TZ).lockAt
  const space = (id: string, name: string, members: string[], more: Partial<Parameters<typeof setSpace>[1]> = {}) =>
    setSpace(id, { name, ...HOUSE, members, timezone: TZ, utcOffsetMin: offset, inviteCode: `${(id.toUpperCase() + 'ABCD').slice(0, 4)}2345`.replace(/[^A-HJ-NP-Z2-9]/g, 'X'), at, ...more })
  const weeksOf = async (id: string, members: string[], judges?: string[]) => {
    for (const w of [w0, w1, w2]) await setWeek(id, w, { ...weekBounds(w, TZ), members, submittedBy: [], ...(judges ? { judges } : {}) })
  }

  // Film Crew: Lena asks to pause next week; Ben left this month before agreeing to Marco's shared stakes.
  await space('film', 'Film Crew', [marco, lena, sam], { leftAt: { [ben]: firstLock + DAY } })
  await setWeek('film', w0, { ...weekBounds(w0, TZ), members: [marco, lena, sam, ben], submittedBy: [] })
  for (const w of [w1, w2]) await setWeek('film', w, { ...weekBounds(w, TZ), members: [marco, lena, sam], submittedBy: [] })
  await setPlan('film', w1, marco, TASKS, firstLock - DAY)
  await spaceDoc('film').update({ pause: { weekId: w2, by: lena, at: ts(now - HOUR), oks: [lena] } })
  // Lena and Sam agreed while Ben was still in; he left without agreeing, so the shared lines wait for him.
  const shared: SeedStakes = { rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner, on you', penalty: 'A round of coffee', updatedAt: firstLock - DAY }
  const agreedAt = firstLock + 6 * HOUR
  await setStakes('film', marco, { ...shared, agreed: { [lena]: { at: agreedAt, terms: pairOf(shared, lena) }, [sam]: { at: agreedAt, terms: pairOf(shared, sam) } } })

  // Studio: Marco changed his stakes (reward for everyone, a penalty per friend) after everyone agreed to the old
  // ones; Sam's stakes wait only for Lena; Kim's wait for Lena and Sam.
  await space('studio', 'Studio', [marco, lena, sam, kim])
  await weeksOf('studio', [marco, lena, sam, kim])
  for (const uid of [marco, lena, sam, kim]) await setPlan('studio', w1, uid, TASKS, firstLock - DAY)
  const old: SeedStakes = { rewardMode: 'group', penaltyMode: 'group', reward: 'Dinner, on you', penalty: 'A round of coffee', updatedAt: now - 12 * DAY }
  const next: SeedStakes = {
    rewardMode: 'group',
    penaltyMode: 'each',
    reward: 'Pizza night, on you',
    penalty: '',
    per: { [lena]: { reward: '', penalty: 'A beer' }, [sam]: { reward: '', penalty: 'A paperback' }, [kim]: { reward: '', penalty: 'Flowers' } },
    tiers: [{ months: 3, reward: 'Weekend away' }],
    updatedAt: now - DAY,
  }
  await setStakes('studio', marco, { ...next, agreed: Object.fromEntries([lena, sam, kim].map((f) => [f, { at: now - 10 * DAY, terms: pairOf(old, f) }])) })
  const samStakes: SeedStakes = { rewardMode: 'group', penaltyMode: 'group', reward: 'Lunch, on you', penalty: 'Tea for everyone', updatedAt: now - 3 * DAY }
  await setStakes('studio', sam, { ...samStakes, agreed: { [marco]: { at: now - 2 * DAY, terms: pairOf(samStakes, marco) }, [kim]: { at: now - 2 * DAY, terms: pairOf(samStakes, kim) } } })
  const kimStakes: SeedStakes = { rewardMode: 'group', penaltyMode: 'group', reward: 'A movie night', penalty: 'Cake for the group', updatedAt: now - 2 * DAY }
  await setStakes('studio', kim, { ...kimStakes, agreed: { [marco]: { at: now - DAY, terms: pairOf(kimStakes, marco) } } })

  // Choir (Lena's): new times from next week, and Marco's request to pause this week, which nobody answered.
  const custom: WeekSchedule = { lock: 2640, reviewOpen: 5760, deadline: 7200 }
  await space('choir', 'Choir', [lena, marco], { schedule: custom })
  await spaceDoc('choir').update({
    scheduleNote: { by: lena, at: ts(now - 2 * DAY), fromWeek: w2, before: { lock: 1440, reviewOpen: 5760, deadline: 7200 } },
    pause: { weekId: w1, by: marco, at: ts(now - DAY), oks: [marco] },
  })
  for (const w of [w0, w1]) await setWeek('choir', w, { ...weekBounds(w, TZ), members: [lena, marco], submittedBy: [] })
  for (const uid of [lena, marco]) await setPlan('choir', w1, uid, TASKS, firstLock - DAY)

  // Run Club (Lena's): Marco only rates.
  await space('run', 'Run Club', [lena, sam, marco], { judges: [marco] })
  await setPlayedWeek('run', w0, weekBounds(w0, TZ), { [lena]: TASKS, [sam]: TASKS }, { judges: [marco], skip: [marco] })
  for (const w of [w1, w2]) await setWeek('run', w, { ...weekBounds(w, TZ), members: [lena, sam, marco], submittedBy: [], judges: [marco] })
  for (const uid of [lena, sam]) await setPlan('run', w1, uid, TASKS, firstLock)

  // Book Club: this week is paused.
  await space('book', 'Book Club', [marco, kim], { paused: { [month]: w1 } })
  await weeksOf('book', [marco, kim])
  await setPlan('book', w1, marco, TASKS, firstLock)

  // Garden Club (Kim's): Marco joins it with a code.
  await space('garden', 'Garden Club', [kim])

  const m = await phone(browser)
  const l = await phone(browser)
  const [mp, lp] = [m.page, l.page]

  await test.step('Spaces: a pause to answer, new times, judging, a paused week', async () => {
    await signIn(mp, MARCO, now)
    await expect(mp.getByRole('button', { name: /Film Crew/ }).first()).toContainText('Lena asks to pause next week')
    await expect(mp.getByRole('button', { name: /Choir/ }).first()).toContainText('New times from next week')
    await expect(mp.getByRole('button', { name: /Run Club/ }).first()).toContainText('Judging this week')
    await snap(mp, 's-01-spaces-cards', 1200)
    await centerOn(mp.getByRole('button', { name: /Run Club/ }).first())
    await snap(mp, 's-02-spaces-cards-more')
  })

  await test.step('The worst-case Space screen top: a pause to answer over the stakes card, on the smallest iPhone', async () => {
    await openSpace(mp, 'Film Crew')
    await expect(section(mp, 'Pause next week?')).toBeVisible()
    await expect(stakesCard(mp)).toContainText('Ben left before agreeing')
    await snap(mp, 's-03-space-top-worst', 700, { width: 375, height: 667 })
    await centerOn(stakesCard(mp))
    await snap(mp, 's-04-card-leaver')
    await stakesCard(mp).getByRole('button', { name: /they owe you/ }).click()
    await expect(mp.getByRole('heading', { name: 'Stakes', exact: true })).toBeVisible()
    await snap(mp, 's-05-stakes-screen-leaver')
    await back(mp)
    await back(mp)
  })

  await test.step('The Stakes screen with new stakes waiting, and the editor in every mode', async () => {
    await openSpace(mp, 'Studio')
    await expect(stakesCard(mp)).toContainText('Your new stakes: waiting for')
    await centerOn(stakesCard(mp))
    await snap(mp, 's-06-card-waiting-three')
    await stakesCard(mp).getByRole('button', { name: /they owe you/ }).click()
    await expect(shown(mp, 'Your new stakes')).toBeVisible()
    await snap(mp, 's-07-stakes-screen-new')
    await centerOn(shown(mp, 'Your new stakes'))
    await snap(mp, 's-08-stakes-screen-new-rows')
    await mp.getByRole('button', { name: 'Edit', exact: true }).click()
    const form = mp.getByRole('dialog').filter({ has: mp.getByRole('heading', { name: 'Your Stakes' }) })
    const mode = (line: 'Reward' | 'Penalty', name: 'Same for Everyone' | 'Different per Friend') =>
      form.getByRole('radiogroup', { name: line }).getByRole('radio', { name })
    await expect(mode('Penalty', 'Different per Friend')).toBeChecked()
    await snap(mp, 's-09-editor-reward-same-penalty-each')
    await mode('Reward', 'Different per Friend').click()
    await snap(mp, 's-10-editor-both-each')
    await mode('Penalty', 'Same for Everyone').click()
    await snap(mp, 's-11-editor-reward-each-penalty-same')
    await mode('Reward', 'Same for Everyone').click()
    await snap(mp, 's-12-editor-both-same')
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    const discard = mp.getByRole('button', { name: 'Discard Changes', exact: true })
    if (await discard.isVisible().catch(() => false)) await discard.click()
    await expect(form).toHaveCount(0)
  })

  await test.step('The Agree alert: counts now, and once someone else agrees too', async () => {
    await signIn(lp, LENA, now)
    await openSpace(lp, 'Studio')
    await expect(stakesCard(lp)).toContainText('New stakes from')
    await centerOn(stakesCard(lp))
    await snap(lp, 's-13-card-new-from-three')
    await stakesCard(lp).getByRole('button', { name: /Take a Look/ }).click()
    await expect(lp.getByRole('heading', { name: 'Stakes', exact: true })).toBeVisible()
    const alert = lp.getByRole('alertdialog')
    await lp.getByRole('button', { name: 'Agree to Sam’s Stakes' }).click()
    await expect(alert).toContainText('They count right away.')
    await snap(lp, 's-14-agree-now', 400)
    await alert.getByRole('button', { name: 'Cancel', exact: true }).click()
    await lp.getByRole('button', { name: 'Agree to Kim’s Stakes' }).click()
    await expect(alert).toContainText('They count once Sam agrees too.')
    await snap(lp, 's-15-agree-once-sam', 400)
    await alert.getByRole('button', { name: 'Cancel', exact: true }).click()
  })

  await test.step('The asker’s pause that didn’t happen', async () => {
    await travel(mp, on(w1, 4, 10))
    await openSpace(mp, 'Choir')
    await expect(section(mp, 'Your pause didn’t happen')).toBeVisible()
    await expect(stakesCard(mp)).toContainText('Same stakes for everyone, for now.')
    await snap(mp, 's-16-pause-lapsed')
  })

  await test.step('Space Settings for a judge who isn’t the owner', async () => {
    await travel(mp, now)
    await openSpace(mp, 'Run Club')
    await mp.getByRole('button', { name: 'Space settings' }).click()
    await expect(mp.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await expect(mp.getByRole('switch', { name: 'Only Rate Friends' })).toBeChecked()
    await snap(mp, 's-17-settings-judge')
    await centerOn(mp.getByRole('button', { name: /^Pause a Week/ }))
    await snap(mp, 's-18-settings-judge-more')
    await back(mp)
    await back(mp)
  })

  await test.step('Overview: a paused space, a judge, and the judge’s month', async () => {
    await tab(mp, 'Overview').click()
    await expect(shown(mp, 'Judge · no score this month')).toBeVisible()
    await snap(mp, 's-19-overview', 1200)
    await centerOn(shown(mp, 'Judge · no score this month'))
    await snap(mp, 's-20-overview-month')
    await tab(mp, 'Spaces').click()
  })

  await test.step('Create and Join with Only Rate Friends', async () => {
    await mp.getByRole('button', { name: 'New Space', exact: true }).filter({ visible: true }).first().click()
    const create = sheet(mp)
    await create.getByLabel('Space name').fill('Climbing Crew')
    await create.getByLabel('Reward').fill('Ramen, on them')
    await create.getByLabel('Penalty').fill('Chalk for everyone')
    await create.getByRole('switch', { name: 'Only Rate Friends' }).click()
    await create.getByLabel('Penalty').blur()
    await snap(mp, 's-21-create-judge')
    await create.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(create).toHaveCount(0)
    await mp.getByRole('button', { name: 'Join with Code', exact: true }).filter({ visible: true }).first().click()
    const join = sheet(mp)
    await join.getByLabel('Invite code').fill('GARD2345')
    await expect(join.getByRole('button', { name: 'Join Garden Club', exact: true })).toBeVisible()
    await join.getByRole('switch', { name: 'Only Rate Friends' }).click()
    await join.getByLabel('Invite code').blur()
    await snap(mp, 's-22-join-judge')
  })

  for (const p of [m, l]) await p.context.close()
})
