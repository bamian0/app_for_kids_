// The whole game, end to end, in two iPhone-sized browsers against the emulators with the real rules:
// sign up, create a space, join by code, plan next week, then (seeded) a week in its Friday window
// reviewed through the UI until the reveal, and a finished month with its verdict and Settled switch.
//
// Run (no npm scripts needed; starts the emulators, the Vite dev server and Chromium):
//   npx firebase emulators:exec --only auth,firestore --project demo-stakes "npx playwright test"
// Screenshots (light and dark) of every step go to $E2E_SCREENSHOTS when it is set, plus light
// screenshots at the widths in $E2E_WIDTHS (e.g. "375,430").
import { expect, test, type Locator, type Page } from '@playwright/test'
import { addMonths, monthIdForWeek, weekBounds, weekIdFor, weekIdsInMonth } from '../../src/domain/time.ts'
import { db, resetEmulators, setPlan, setProgress, setReview, setWeek, ts, uidOf, weekDoc, type SeedTask } from './emulator.ts'
import { edgeGlows, phone, score, sheet, shown, snap } from './helpers.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR

const MARCO = { name: 'Marco Rossi', email: 'marco@example.com', password: 'secret123' }
const LENA = { name: 'Lena Fischer', email: 'lena@example.com', password: 'secret123' }
const SPACE = { name: 'Film Crew', reward: 'Dinner at Da Enzo, on them', penalty: 'Coffee for everyone, for a week' }

const MARCO_NEXT = ['Color grade the Nike spot, first pass', 'Send the treatment to the agency', 'Test the anamorphic lenses at night', 'Update the reel']
const LENA_NEXT = ['Finish the Lavazza edit', 'Two gym sessions', 'Pitch deck for the doc series']
const MARCO_NOW: SeedTask[] = [
  { id: 'ma1', title: 'Deliver the Barilla dailies' },
  { id: 'ma2', title: 'Scout two locations in Testaccio' },
  { id: 'ma3', title: 'Invoice September jobs' },
  { id: 'ma4', title: 'Clean and label the lens kit' },
]
const LENA_NOW: SeedTask[] = [
  { id: 'lb1', title: 'Rough cut for the Lavazza spot' },
  { id: 'lb2', title: 'Three gym sessions' },
  { id: 'lb3', title: 'Call the bank about the loan' },
]

/** Same rounding as the app: a floored whole percent, so 89.96 never reads as 90%. */
function pct(score: number): string {
  return `${Math.floor(score + 1e-6)}%`
}

async function signUp(page: Page, who: typeof MARCO): Promise<void> {
  await page.getByRole('button', { name: 'Create Account', exact: true }).click()
  await page.getByLabel('Name').fill(who.name)
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
}

async function addTasks(page: Page, titles: string[]): Promise<void> {
  const input = page.getByLabel('New task')
  for (const title of titles) {
    await input.fill(title)
    await input.press('Enter')
  }
  await input.blur()
  await expect(page.getByLabel(`Task ${titles.length}`)).toHaveValue(titles[titles.length - 1])
}

async function planOf(spaceId: string, weekId: string, uid: string): Promise<string[]> {
  const snap = await weekDoc(spaceId, weekId).collection('plans').doc(uid).get()
  return ((snap.get('tasks') as SeedTask[] | undefined) ?? []).map((t) => t.title)
}

async function mark(dialog: Locator, title: string, label: 'Done' | 'Half' | 'Not done'): Promise<void> {
  await dialog.getByRole('radiogroup', { name: `Mark for ${title}` }).getByRole('radio', { name: label, exact: true }).click()
}

test('two friends plan, review blind on Friday, and settle the month', async ({ browser }) => {
  await resetEmulators()
  const a = await phone(browser)
  const b = await phone(browser)
  const marco = a.page
  const lena = b.page

  await test.step('Marco signs up and creates a space', async () => {
    await marco.goto('/')
    await expect(marco.getByRole('button', { name: 'I Have an Account' })).toBeVisible()
    await snap(marco, '01-welcome', 1500)
    await signUp(marco, MARCO)
    await snap(marco, '02-sign-up')
    await marco.getByRole('button', { name: 'Create Account', exact: true }).click()
    await expect(shown(marco, 'No spaces yet')).toBeVisible()
    await snap(marco, '03-spaces-empty')

    await marco.getByRole('button', { name: 'New Space', exact: true }).click()
    const form = sheet(marco)
    await form.getByLabel('Space name').fill(SPACE.name)
    await form.getByLabel('Reward').fill(SPACE.reward)
    await form.getByLabel('Penalty').fill(SPACE.penalty)
    await snap(marco, '04-create-space')
    // One confirm action, the checkmark in the bar.
    await expect(form.getByRole('button', { name: 'Create Space', exact: true })).toHaveCount(0)
    await form.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(shown(form, `${SPACE.name} is live.`)).toBeVisible()
    await snap(marco, '05-invite-sheet')
  })

  const code = (await sheet(marco).locator('.s-invite__code').innerText()).trim()
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)

  const marcoUid = await uidOf(MARCO.email)
  const spaces = await db.collection('spaces').where('memberIds', 'array-contains', marcoUid).get()
  expect(spaces.size).toBe(1)
  const spaceId = spaces.docs[0].id
  const tz = spaces.docs[0].get('timezone') as string
  expect(tz).toBe('Europe/Rome')
  const thisWeek = weekIdFor(Date.now(), tz)
  const nextWeek = weekIdFor(Date.now() + 7 * DAY, tz)

  await test.step('Marco plans next week', async () => {
    await sheet(marco).getByRole('button', { name: 'Done', exact: true }).click()
    await expect(marco.getByRole('heading', { name: SPACE.name })).toBeVisible()
    await marco.getByRole('radio', { name: 'Next Week' }).click()
    await addTasks(marco, MARCO_NEXT)
    await expect.poll(() => planOf(spaceId, nextWeek, marcoUid)).toEqual(MARCO_NEXT)
  })

  await test.step('Lena opens the invite link, signs up and joins', async () => {
    await lena.goto(`/?join=${code.replace('-', '')}`)
    // Signed out, the invite already shows who, what and for which stakes, plus the code to type in the app.
    await expect(shown(lena, `${MARCO.name} invited you to ${SPACE.name}`)).toBeVisible()
    await expect(shown(lena, SPACE.reward)).toBeVisible()
    await expect(shown(lena, SPACE.penalty)).toBeVisible()
    await expect(lena.locator('.s-invite__code')).toHaveText(code)
    await expect(lena.getByRole('button', { name: 'I Have an Account' })).toBeInViewport()
    await snap(lena, '05b-welcome-invited', 1200)
    await signUp(lena, LENA)
    await lena.getByRole('button', { name: 'Create Account', exact: true }).click()
    const join = sheet(lena)
    await expect(join.getByLabel('Invite code')).toHaveValue(code)
    // Typed the way a friend reads it out: lower case, no dash.
    await join.getByLabel('Invite code').fill(code.replace('-', '').toLowerCase())
    await expect(join.getByLabel('Invite code')).toHaveValue(code)
    await expect(join.locator('.s-join-preview__title')).toHaveText(`Join ${SPACE.name}`)
    await expect(shown(join, `Invited by ${MARCO.name}`)).toBeVisible()
    await expect(shown(join, SPACE.penalty)).toBeVisible()
    await snap(lena, '06-join-sheet')
    await join.getByRole('button', { name: `Join ${SPACE.name}`, exact: true }).click()
    await expect(lena.getByRole('heading', { name: SPACE.name })).toBeVisible()
    // In a Safari tab, joining leads straight to installing the app (reminders need it).
    const guide = lena.getByRole('dialog').filter({ hasText: `You’re in ${SPACE.name}.` })
    await expect(guide).toBeVisible()
    await snap(lena, '06b-install-after-join')
    await guide.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(guide).toHaveCount(0)
  })

  const lenaUid = await uidOf(LENA.email)
  expect((await db.doc(`spaces/${spaceId}`).get()).get('memberIds')).toEqual([marcoUid, lenaUid])

  await test.step('Lena plans next week and Marco sees it live', async () => {
    await lena.getByRole('radio', { name: 'Next Week' }).click()
    await addTasks(lena, LENA_NEXT)
    await expect.poll(() => planOf(spaceId, nextWeek, lenaUid)).toEqual(LENA_NEXT)
    for (const title of LENA_NEXT) await expect(shown(marco, title, true)).toBeVisible()
    const week = await weekDoc(spaceId, nextWeek).get()
    expect(week.get('members')).toEqual([marcoUid, lenaUid])
    expect(week.get('submittedBy')).toEqual([])
    // Nothing is ticked off before the week starts.
    expect((await weekDoc(spaceId, nextWeek).collection('progress').get()).size).toBe(0)
    await snap(marco, '07-week-planning')
  })

  await test.step('The spaces list shows the new space', async () => {
    await marco.getByRole('button', { name: 'Back to Spaces' }).click()
    await expect(marco.getByRole('button', { name: new RegExp(SPACE.name) })).toBeVisible()
    await snap(marco, '08-spaces-populated', 1200)
    await marco.getByRole('button', { name: new RegExp(SPACE.name) }).click()
    await expect(marco.getByRole('heading', { name: SPACE.name })).toBeVisible()
  })

  // The current week, seeded mid-week: lists locked, review window still ahead.
  const t0 = Date.now()
  await setWeek(spaceId, thisWeek, {
    startAt: t0 - 5 * DAY,
    lockAt: t0 - 4 * DAY,
    reviewOpenAt: t0 + DAY,
    deadlineAt: t0 + 2 * DAY,
    members: [marcoUid, lenaUid],
    submittedBy: [],
  })
  await setPlan(spaceId, thisWeek, marcoUid, MARCO_NOW, t0 - 5 * DAY)
  await setPlan(spaceId, thisWeek, lenaUid, LENA_NOW, t0 - 5 * DAY)
  await setProgress(spaceId, thisWeek, lenaUid, { lb1: true, lb2: true }, t0 - DAY)

  await test.step('Mid-week, Marco ticks tasks off', async () => {
    await marco.getByRole('radio', { name: 'This Week' }).click()
    await marco.getByRole('checkbox', { name: MARCO_NOW[0].title }).click()
    await marco.getByRole('checkbox', { name: MARCO_NOW[1].title }).click()
    await expect(marco.getByRole('checkbox', { name: MARCO_NOW[1].title })).toBeChecked()
    await expect
      .poll(async () => (await weekDoc(spaceId, thisWeek).collection('progress').doc(marcoUid).get()).get('done'))
      .toEqual({ ma1: true, ma2: true })
    await expect(shown(marco, '2 of 4 done')).toBeVisible()
    await snap(marco, '09-week-active', 300)
  })

  // Friday: the review window opened two hours ago and closes in six.
  const t1 = Date.now()
  await weekDoc(spaceId, thisWeek).update({ reviewOpenAt: ts(t1 - 2 * HOUR), deadlineAt: ts(t1 + 6 * HOUR) })

  await test.step('Marco reviews Lena', async () => {
    const cta = marco.getByRole('button', { name: 'Review Lena', exact: true })
    await expect(cta).toBeVisible()
    await expect(shown(marco, 'Your review is due')).toBeVisible()
    await snap(marco, '10-week-review-cta')
    await cta.click()
    const review = sheet(marco)
    await expect(shown(review, 'Lena Fischer', true)).toBeVisible()
    await mark(review, LENA_NOW[0].title, 'Done')
    await snap(marco, '11-review-sheet')
    await mark(review, LENA_NOW[1].title, 'Half')
    await mark(review, LENA_NOW[2].title, 'Done')
    await review.getByRole('button', { name: 'Submit Reviews', exact: true }).click()
    const confirm = marco.getByRole('alertdialog')
    await expect(confirm).toBeVisible()
    await snap(marco, '12-review-confirm', 500)
    await confirm.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(shown(review, 'Reviews in.')).toBeVisible()
    await expect(shown(review, /Waiting for Lena/)).toBeVisible()
    await snap(marco, '13-review-submitted', 1000)
    await review.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(shown(marco, 'Submitted. Waiting for 1')).toBeVisible()
    await snap(marco, '14-review-waiting')
  })

  // Blind: Marco's own review is all he can read, so nobody's score is out yet.
  expect((await weekDoc(spaceId, thisWeek).get()).get('submittedBy')).toEqual([marcoUid])
  expect(await edgeGlows(marco)).toBe(0)

  await test.step('Lena reviews Marco, and the results are revealed', async () => {
    await lena.getByRole('radio', { name: 'This Week' }).click()
    await lena.getByRole('button', { name: 'Review Marco', exact: true }).click()
    const review = sheet(lena)
    await mark(review, MARCO_NOW[0].title, 'Done')
    await mark(review, MARCO_NOW[1].title, 'Done')
    await mark(review, MARCO_NOW[2].title, 'Half')
    await mark(review, MARCO_NOW[3].title, 'Not done')
    await review.getByRole('button', { name: 'Submit Reviews', exact: true }).click()
    await lena.getByRole('alertdialog').getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(shown(review, 'Everyone’s in. Results are live.')).toBeVisible()

    // The reveal plays the edge glow once, on both phones.
    await expect.poll(() => edgeGlows(marco)).toBe(1)
    await expect.poll(() => edgeGlows(lena)).toBe(1)
    await snap(marco, '15-revealed-glow', 400)
    await review.getByRole('button', { name: 'Done', exact: true }).click()
  })

  // Marco: Lena gave 1 + 1 + 0.5 + 0 over 4 tasks. Lena: Marco gave 1 + 0.5 + 1 over 3.
  const marcoScoreThisWeek = pct((100 * 2.5) / 4)
  await test.step('Scores follow the marks', async () => {
    const marcoScore = marcoScoreThisWeek
    const lenaScore = pct((100 * 2.5) / 3)
    expect([marcoScore, lenaScore]).toEqual(['62%', '83%'])
    for (const page of [marco, lena]) {
      await expect(score(page, marcoScore)).toBeVisible()
      await expect(score(page, lenaScore)).toBeVisible()
    }
    for (const text of ['Reviewed by Lena', 'Reviewed by you', 'Lena: Half', 'You: Half']) await expect(shown(marco, text, true)).toBeVisible()
    for (const text of ['Reviewed by Marco', 'Reviewed by you', 'Marco: Half', 'You: Half']) await expect(shown(lena, text, true)).toBeVisible()
    // Everyone is in before the deadline, so the countdown gives way to the results.
    await expect(shown(marco, 'Results are in', true)).toBeVisible()
    await expect(marco.locator('.ui-edge-glow')).toHaveCount(0, { timeout: 10_000 })
    await snap(marco, '16-revealed-results')
    await snap(lena, '16b-revealed-results-lena')
    const reviews = await weekDoc(spaceId, thisWeek).collection('reviews').get()
    expect(reviews.docs.map((d) => d.id).sort()).toEqual([`${lenaUid}_${marcoUid}`, `${marcoUid}_${lenaUid}`].sort())
  })

  // Last month, finished: four or five weeks, Marco clears the bar, Lena misses it and one review.
  const lastMonth = addMonths(monthIdForWeek(thisWeek), -1)
  const pastWeeks = weekIdsInMonth(lastMonth)
  const marcoPast: SeedTask[] = MARCO_NOW
  const lenaPast: SeedTask[] = LENA_NOW
  const marcoScores: number[] = []
  for (const [i, weekId] of pastWeeks.entries()) {
    const w = weekBounds(weekId, tz)
    const last = i === pastWeeks.length - 1
    await setWeek(spaceId, weekId, { ...w, members: [marcoUid, lenaUid], submittedBy: last ? [marcoUid] : [marcoUid, lenaUid] })
    await setPlan(spaceId, weekId, marcoUid, marcoPast, w.startAt)
    await setPlan(spaceId, weekId, lenaUid, lenaPast, w.startAt)
    await setProgress(spaceId, weekId, marcoUid, { ma1: true, ma2: true, ma3: true, ma4: true }, w.reviewOpenAt)
    await setProgress(spaceId, weekId, lenaUid, { lb1: true, lb2: true }, w.reviewOpenAt)
    await setReview(spaceId, weekId, marcoUid, lenaUid, { lb1: 1, lb2: 1, lb3: 0.5 }, w.reviewOpenAt + HOUR)
    // Lena never reviewed Marco in the last week: his check-offs count, and she loses 5 points.
    if (!last) await setReview(spaceId, weekId, lenaUid, marcoUid, i === 0 ? { ma1: 1, ma2: 1, ma3: 1, ma4: 0.5 } : { ma1: 1, ma2: 1, ma3: 1, ma4: 1 }, w.reviewOpenAt + 2 * HOUR)
    marcoScores.push(i === 0 ? 87.5 : 100)
  }
  // The space has to be older than last month for the month switcher to go back to it.
  await db.doc(`spaces/${spaceId}`).update({ createdAt: ts(weekBounds(pastWeeks[0], tz).startAt - 7 * DAY) })
  const marcoMonth = pct(marcoScores.reduce((s, x) => s + x, 0) / marcoScores.length)
  const lenaMonth = pct((100 * 2.5) / 3 - 5)

  await test.step('Month: in progress, then last month’s verdict', async () => {
    await marco.getByRole('radio', { name: 'Month' }).click()
    await expect(marco.locator('.s-month-switch__sub')).toHaveText('In progress')
    // This week's row: revealed, still before the deadline.
    await expect(shown(marco, `${marcoScoreThisWeek} so far`, true)).toBeVisible()
    await expect(marco.getByText('Can’t load this month')).toHaveCount(0)
    await snap(marco, '17-month-in-progress')
    const glowsBefore = await edgeGlows(marco)
    await marco.getByRole('button', { name: 'Previous month' }).click()
    await expect(marco.locator('.s-month-switch__sub')).toHaveText('Final')
    await expect(marco.locator('.s-hero-score')).toHaveText(marcoMonth)
    await expect(shown(marco, 'You cleared the bar')).toBeVisible()
    await expect(shown(marco, `Lena owes you: ${SPACE.reward}`)).toBeVisible()
    await expect(shown(marco, `Lena owes you: ${SPACE.penalty}`)).toBeVisible()
    await expect(score(marco, lenaMonth)).toBeVisible()
    await expect(shown(marco, '1 missed review')).toBeVisible()
    await expect.poll(() => edgeGlows(marco)).toBe(glowsBefore + 1)
    await expect(marco.locator('.ui-edge-glow')).toHaveCount(0, { timeout: 10_000 })

    const settled = marco.getByRole('switch', { name: 'Settled' }).first()
    await expect(settled).not.toBeChecked()
    await settled.click()
    await expect(settled).toBeChecked()
    await expect
      .poll(async () => (await db.doc(`spaces/${spaceId}/settlements/${lastMonth}_${marcoUid}`).get()).data())
      .toMatchObject({ monthId: lastMonth, uid: marcoUid, settled: true, settledBy: marcoUid })
    await expect(shown(marco, 'Marked by you')).toBeVisible()
    await snap(marco, '18-month-verdict')
    // Lena sees the switch flip live, and who flipped it. She missed: no glow, and she can't mark her own debt.
    const lenaGlows = await edgeGlows(lena)
    await lena.getByRole('radio', { name: 'Month' }).click()
    await lena.getByRole('button', { name: 'Previous month' }).click()
    await expect(shown(lena, `You owe Marco: ${SPACE.penalty}`)).toBeVisible()
    await expect(shown(lena, 'Marked by Marco')).toBeVisible()
    await expect(shown(lena, 'Only the people you owe can mark this.')).toBeVisible()
    // Neither row is hers to mark: Marco is owed his reward, and she can't settle her own debt.
    await expect(lena.getByRole('switch', { name: 'Settled' })).toHaveCount(0)
    await lena.waitForTimeout(1000)
    expect(await edgeGlows(lena)).toBe(lenaGlows)
    await snap(lena, '18b-month-verdict-lena')
  })

  await test.step('Settings, the rules, and the profile', async () => {
    await marco.getByRole('button', { name: 'Space settings' }).click()
    await expect(shown(marco, 'Members · 2 of 8')).toBeVisible()
    await snap(marco, '19-space-settings')
    // The owner resets the invite code: the old one stops working.
    await marco.getByRole('button', { name: 'Reset Invite Code' }).click()
    await marco.getByRole('alertdialog').getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(marco.locator('.s-invite__code').filter({ visible: true })).not.toHaveText(code)
    // The screen updates before the server has the write.
    await expect.poll(async () => (await db.doc(`invites/${code.replace('-', '')}`).get()).exists).toBe(false)
    const newCode = (await db.doc(`spaces/${spaceId}`).get()).get('inviteCode') as string
    expect(newCode).not.toBe(code.replace('-', ''))
    expect((await db.doc(`invites/${newCode}`).get()).get('spaceId')).toBe(spaceId)
    await marco.getByRole('button', { name: 'How Stakes Works' }).click()
    await expect(marco.getByRole('heading', { name: 'How Stakes Works' })).toBeVisible()
    await snap(marco, '20-rules')
    await marco.getByRole('button', { name: /^Back/ }).click()
    await marco.getByRole('button', { name: /^Back/ }).click()
    await marco.getByRole('button', { name: 'Back to Spaces' }).click()
    await expect(marco.locator('.s-space-card')).toBeVisible()
    await snap(marco, '21-spaces-final', 1200)
    await marco.getByRole('button', { name: 'Profile' }).click()
    await expect(shown(sheet(marco), MARCO.email)).toBeVisible()
    await snap(marco, '22-profile')
    await sheet(marco).getByRole('button', { name: 'Done', exact: true }).click()
  })

  await test.step('The verdict notification opens last month', async () => {
    await marco.goto(`/?space=${spaceId}&month=${lastMonth}`)
    await expect(marco.locator('.s-month-switch__sub')).toHaveText('Final')
    await expect(shown(marco, `Lena owes you: ${SPACE.reward}`)).toBeVisible()
    expect(new URL(marco.url()).searchParams.has('space')).toBe(false)
  })

  await test.step('The owner removes a member', async () => {
    await marco.getByRole('button', { name: 'Space settings' }).click()
    await marco.getByRole('button', { name: new RegExp(LENA.name) }).filter({ visible: true }).click()
    await snap(marco, '23-remove-member', 500)
    await marco.getByRole('button', { name: 'Remove from Space', exact: true }).click()
    await expect(shown(marco, 'Members · 1 of 8')).toBeVisible()
    await expect.poll(async () => (await db.doc(`spaces/${spaceId}`).get()).get('memberIds')).toEqual([marcoUid])
    // Lena's open space turns into the "not in this space" state.
    await expect(shown(lena, 'You’re not in this space')).toBeVisible()
  })

  expect(a.errors).toEqual([])
  expect(b.errors).toEqual([])
  await a.context.close()
  await b.context.close()
})
