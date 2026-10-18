// The second round end to end, in two iPhone-sized browsers against the emulators with the real rules:
// a task with steps and revenue planned in the task sheet and ticked step by step until it earns, a
// task added after the lock that the friend sees (with its day and steps) up to the Friday review,
// Overview and Goals with real money moves, the tab bar, and money staying private.
// Accounts, the space and the week's stored timeline are seeded; everything else goes through the UI.
//
// Run with flow.spec.ts (see there), or alone:
//   npx firebase emulators:exec --only auth,firestore --project demo-stakes "npx playwright test features"
import { expect, test, type Locator, type Page } from '@playwright/test'
import { weekIdFor } from '../../src/domain/time.ts'
import { createAccount, db, moneyDoc, readAs, resetEmulators, setPlan, setSpace, setWeek, ts, weekDoc, type SeedTask } from './emulator.ts'
import { phone, sheet, shown, snap } from './helpers.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TZ = 'Europe/Rome'

const MARCO = { name: 'Marco Rossi', email: 'marco@example.com', password: 'secret123' }
const LENA = { name: 'Lena Fischer', email: 'lena@example.com', password: 'secret123' }
const SPACE_ID = 'film-crew'
const SPACE = { name: 'Film Crew', reward: 'Dinner at Da Enzo, on them', penalty: 'Coffee for everyone, for a week' }

const SHOOT = { title: 'Client shoot for Lavazza', steps: ['Prep the gear', 'Shoot the spot', 'Deliver selects'] }
const GRADE = { title: 'Color grade the teaser', steps: ['Rough grade', 'Final grade'] }
const LENA_TASKS: SeedTask[] = [
  { id: 'lb1', title: 'Finish the Lavazza edit', subs: ['ls1|Assembly', 'ls2|Music and mix'] },
  { id: 'lb2', title: 'Two gym sessions' },
]

interface StoredTask {
  id: string
  title: string
  subs?: string[]
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })
const tabBar = (page: Page) => page.locator('.ui-tab-bar')
/** The root screen's scroll view in one tab (0 Spaces, 1 Overview, 2 Goals); other tabs stay mounted. */
const tabScroll = (page: Page, index: number) => page.locator('.ui-tabs__panel').nth(index).locator('.ui-screen__scroll').first()

async function signIn(page: Page, who: typeof MARCO): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'I Have an Account' }).click()
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await expect(tab(page, 'Spaces')).toHaveAttribute('aria-selected', 'true')
}

/** Types a task into the open task sheet: title, steps (Return adds the next one), and its revenue. */
async function fillTask(form: Locator, task: { title: string; steps: string[] }, amount: string, opts: { returnStartsSteps?: boolean } = {}): Promise<void> {
  const title = form.getByLabel('Title', { exact: true })
  await title.fill(task.title)
  // From Add Task with Steps, Return on the title starts the first step, like Reminders.
  if (opts.returnStartsSteps) await title.press('Enter')
  else await form.getByRole('button', { name: 'Add Step', exact: true }).click()
  for (const [i, step] of task.steps.entries()) {
    const field = form.getByLabel(`Step ${i + 1}`, { exact: true })
    await expect(field).toBeFocused()
    await field.fill(step)
    if (i < task.steps.length - 1) await field.press('Enter')
  }
  await form.getByRole('switch', { name: 'Generates revenue' }).click()
  await form.getByLabel('Amount in USD').fill(amount)
}

const planDoc = (uid: string, weekId: string) => weekDoc(SPACE_ID, weekId).collection('plans').doc(uid)
const doneOf = async (uid: string, weekId: string) => (await weekDoc(SPACE_ID, weekId).collection('progress').doc(uid).get()).get('done') as Record<string, boolean>
const earningOf = async (uid: string, weekId: string, taskId: string) => (await moneyDoc(uid, `earnings/${SPACE_ID}_${weekId}_${taskId}`).get()).data()
const stepIds = (task: StoredTask) => (task.subs ?? []).map((s) => s.slice(0, s.indexOf('|')))

test('steps, a task added after the lock, money and goals, and the tab bar', async ({ browser }) => {
  await resetEmulators()
  const t0 = Date.now()
  const marcoUid = await createAccount(MARCO, '#FF9500', t0 - 40 * DAY)
  const lenaUid = await createAccount(LENA, '#AF52DE', t0 - 40 * DAY)
  await setSpace(SPACE_ID, { ...SPACE, members: [marcoUid, lenaUid], timezone: TZ, utcOffsetMin: 120, inviteCode: 'FCRW2345', at: t0 - 30 * DAY })
  const thisWeek = weekIdFor(t0, TZ)
  // Monday before the lock: the week has started (steps can be ticked) and lists can still change.
  await setWeek(SPACE_ID, thisWeek, {
    startAt: t0 - HOUR,
    lockAt: t0 + 6 * HOUR,
    reviewOpenAt: t0 + 3 * DAY,
    deadlineAt: t0 + 4 * DAY,
    members: [marcoUid, lenaUid],
    submittedBy: [],
  })
  await setPlan(SPACE_ID, thisWeek, lenaUid, LENA_TASKS, t0 - HOUR)

  const a = await phone(browser)
  const b = await phone(browser)
  const marco = a.page
  const lena = b.page
  let shoot: StoredTask = { id: '', title: '' }

  await test.step('Marco plans a task with steps and revenue in the task sheet', async () => {
    await signIn(marco, MARCO)
    await expect(tabBar(marco)).not.toHaveAttribute('data-hidden')
    await snap(marco, 'f01-spaces-tab-bar', 1200)
    await marco.getByRole('button', { name: new RegExp(SPACE.name) }).click()
    await expect(marco.getByRole('heading', { name: SPACE.name })).toBeVisible()
    // A pushed screen keeps its own toolbar: the tab bar steps aside.
    await expect(tabBar(marco)).toHaveAttribute('data-hidden', 'true')

    await marco.getByRole('button', { name: 'Add Task with Steps', exact: true }).click()
    const form = sheet(marco)
    await fillTask(form, SHOOT, '800', { returnStartsSteps: true })
    await expect(shown(form, '3 of 8', true)).toBeVisible()
    await snap(marco, 'f02-task-sheet-new')
    await form.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(marco.getByRole('dialog')).toHaveCount(0)

    await expect
      .poll(async () => (await planDoc(marcoUid, thisWeek).get()).get('tasks'))
      .toEqual([{ id: expect.any(String), title: SHOOT.title, subs: SHOOT.steps.map((step) => expect.stringMatching(new RegExp(`^[A-Za-z0-9_-]{1,64}\\|${step}$`))) }])
    shoot = ((await planDoc(marcoUid, thisWeek).get()).get('tasks') as StoredTask[])[0]
    // Before the lock nothing is "added".
    expect((await planDoc(marcoUid, thisWeek).get()).get('added')).toBeUndefined()
    await expect
      .poll(() => earningOf(marcoUid, thisWeek, shoot.id))
      .toMatchObject({ spaceId: SPACE_ID, weekId: thisWeek, taskId: shoot.id, title: SHOOT.title, amount: 800, earnedAt: null })
    // The amount shows on his own list, beside the task.
    await expect(shown(marco, '$800', true)).toBeVisible()
    for (const step of SHOOT.steps) await expect(marco.getByRole('checkbox', { name: step, exact: true })).not.toBeChecked()
  })

  await test.step('Ticking every step completes the task and earns its money', async () => {
    const [s1, s2, s3] = stepIds(shoot)
    await marco.getByRole('checkbox', { name: SHOOT.steps[0], exact: true }).click()
    await marco.getByRole('checkbox', { name: SHOOT.steps[1], exact: true }).click()
    await expect.poll(() => doneOf(marcoUid, thisWeek)).toEqual({ [s1]: true, [s2]: true })
    await expect(shown(marco, '2/3', true)).toBeVisible()
    expect((await earningOf(marcoUid, thisWeek, shoot.id))?.earnedAt).toBeNull()
    await snap(marco, 'f03-list-before-lock-steps')

    const last = marco.getByRole('checkbox', { name: SHOOT.steps[2], exact: true })
    await last.click()
    await expect.poll(async () => (await earningOf(marcoUid, thisWeek, shoot.id))?.earnedAt ?? null).not.toBeNull()
    await expect(shown(marco, '3/3', true)).toBeVisible()
    // Un-ticking the last step takes the money back out; ticking it again earns it again.
    await last.click()
    await expect.poll(async () => (await earningOf(marcoUid, thisWeek, shoot.id))?.earnedAt ?? null).toBeNull()
    await last.click()
    await expect.poll(async () => (await earningOf(marcoUid, thisWeek, shoot.id))?.earnedAt ?? null).not.toBeNull()
    expect(await doneOf(marcoUid, thisWeek)).toEqual({ [s1]: true, [s2]: true, [s3]: true })
  })

  await test.step('Steps changed on Monday take the money with the task', async () => {
    // The ring sits where a check circle would be: a tap opens the task.
    await marco.getByRole('button', { name: '3 of 3 steps done. Details', exact: true }).click()
    let form = sheet(marco)
    const amount = form.getByLabel('Amount in USD')
    await expect(amount).toHaveValue('800')
    // Text that isn't an amount is never saved (as 0 or anything else).
    await amount.fill('8..5')
    await expect(form.getByRole('button', { name: 'Done', exact: true })).toBeDisabled()
    await amount.fill('800')
    await form.getByRole('button', { name: 'Add Step', exact: true }).click()
    await form.getByLabel('Step 4', { exact: true }).fill('Send the invoice')
    await form.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(marco.getByRole('dialog')).toHaveCount(0)
    // 3 of 4 steps: not done, so not earned.
    await expect.poll(async () => (await earningOf(marcoUid, thisWeek, shoot.id))?.earnedAt ?? null).toBeNull()
    await expect(shown(marco, '3/4', true)).toBeVisible()
    expect((await earningOf(marcoUid, thisWeek, shoot.id))?.amount).toBe(800)

    await marco.getByRole('button', { name: '3 of 4 steps done. Details', exact: true }).click()
    form = sheet(marco)
    await form.getByLabel('Step 4', { exact: true }).click()
    await form.getByRole('button', { name: 'Delete Send the invoice', exact: true }).click()
    await form.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(marco.getByRole('dialog')).toHaveCount(0)
    // Every step ticked again: earned again.
    await expect.poll(async () => (await earningOf(marcoUid, thisWeek, shoot.id))?.earnedAt ?? null).not.toBeNull()
    await expect.poll(async () => (await planDoc(marcoUid, thisWeek).get()).get('tasks')).toEqual([shoot])
  })

  await test.step('The earning counts on Overview and Goals', async () => {
    await marco.getByRole('button', { name: 'Back to Spaces' }).click()
    await expect(tabBar(marco)).not.toHaveAttribute('data-hidden')
    await tab(marco, 'Overview').click()
    await expect(tab(marco, 'Overview')).toHaveAttribute('aria-selected', 'true')
    await expect(marco.locator('.m-earned__value').filter({ visible: true })).toHaveText('$800')
    await expect(shown(marco, '1 of 1 task done', true)).toBeVisible()
    // Monday: the space's row shows the same check-offs as the ring, labelled like everywhere else.
    await expect(shown(marco, 'Provisional', true)).toBeVisible()
    await expect(shown(marco, SHOOT.title, true)).toBeVisible()
    await snap(marco, 'f04-overview')
    // The Goals row switches tabs.
    await marco.getByRole('button', { name: 'Goals', exact: true }).filter({ visible: true }).click()
    await expect(tab(marco, 'Goals')).toHaveAttribute('aria-selected', 'true')
    await expect(marco.locator('.m-balance__value').filter({ visible: true })).toHaveText('$800')
    await expect(shown(marco, '+$800 earned from tasks this month', true)).toBeVisible()
  })

  // The lock has passed; reviews open in two days.
  const t1 = Date.now()
  const lockAt = t1 - MINUTE
  await weekDoc(SPACE_ID, thisWeek).update({ startAt: ts(t1 - 2 * HOUR), lockAt: ts(lockAt), reviewOpenAt: ts(t1 + 2 * DAY), deadlineAt: ts(t1 + 3 * DAY) })
  let grade: StoredTask = { id: '', title: '' }
  let addedText = ''

  await test.step('After the lock, Marco adds a task with steps, final', async () => {
    await tab(marco, 'Spaces').click()
    await marco.getByRole('button', { name: new RegExp(SPACE.name) }).click()
    await expect(shown(marco, /You can still add tasks until/)).toBeVisible()
    await snap(marco, 'f05-list-after-lock')
    await marco.getByRole('button', { name: 'Add Task', exact: true }).click()
    const form = sheet(marco)
    await expect(shown(form, /Once added, it can’t be edited or removed\./)).toBeVisible()
    await fillTask(form, GRADE, '450')
    await snap(marco, 'f06-task-sheet-add')
    await form.getByRole('button', { name: 'Add to This Week', exact: true }).click()
    await expect(marco.getByRole('dialog')).toHaveCount(0)

    const plan = await planDoc(marcoUid, thisWeek).get()
    const tasks = plan.get('tasks') as StoredTask[]
    // Appended: the task already there is exactly as it was, and `added` holds only the new one.
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toEqual(shoot)
    grade = tasks[1]
    expect(grade).toEqual({ id: expect.any(String), title: GRADE.title, subs: GRADE.steps.map((step) => expect.stringMatching(new RegExp(`\\|${step}$`))) })
    const added = plan.get('added') as Record<string, { toMillis: () => number }>
    expect(Object.keys(added)).toEqual([grade.id])
    const addedAt = added[grade.id].toMillis()
    expect(addedAt).toBeGreaterThanOrEqual(lockAt)
    addedText = `Added ${new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: TZ }).format(addedAt)}`
    await expect
      .poll(() => earningOf(marcoUid, thisWeek, grade.id))
      .toMatchObject({ taskId: grade.id, title: GRADE.title, amount: 450, earnedAt: null })

    await expect(shown(marco, addedText, true)).toBeVisible()
    await expect(shown(marco, '$450', true)).toBeVisible()
    // Steps of the added task can be ticked like any other.
    await expect(marco.getByRole('checkbox', { name: GRADE.steps[0], exact: true })).toBeVisible()
    // A tap on a locked task opens it read-only, except for its revenue and (batch 2.5) its cross-out.
    await marco.getByRole('button', { name: new RegExp(`^${SHOOT.title}`) }).click()
    const details = sheet(marco)
    await expect(shown(details, 'Your list is locked.', true)).toBeVisible()
    await expect(details.getByRole('button', { name: 'Cross Out Task', exact: true })).toBeVisible()
    await expect(details.getByLabel('Title', { exact: true })).toHaveCount(0)
    await expect(shown(details, '3 of 3 done', true)).toBeVisible()
    await snap(marco, 'f07-task-sheet-locked')
    await details.getByRole('button', { name: 'Cancel' }).click()
    await expect(marco.getByRole('dialog')).toHaveCount(0)
  })

  await test.step('Lena sees the added task, its day and its steps, and none of the money', async () => {
    await signIn(lena, LENA)
    await lena.getByRole('button', { name: new RegExp(SPACE.name) }).click()
    await expect(shown(lena, GRADE.title, true)).toBeVisible()
    await expect(shown(lena, addedText, true)).toBeVisible()
    for (const step of [...SHOOT.steps, ...GRADE.steps]) await expect(shown(lena, step, true)).toBeVisible()
    // Marco's ticks, read-only: all three steps of the shoot, none of the grade.
    await expect(lena.getByRole('img', { name: 'Checked off by Marco Rossi', exact: true }).filter({ visible: true })).toHaveCount(3)
    await expect(lena.getByRole('img', { name: 'Not checked off by Marco Rossi', exact: true }).filter({ visible: true })).toHaveCount(2)
    await snap(lena, 'f08-friend-card')

    // Private: no amount anywhere in her app (every tab is mounted), and the rules refuse a direct read.
    const text = (await lena.evaluate(() => document.body.textContent)) ?? ''
    expect(text).not.toMatch(/\$\s?\d/)
    expect(text).not.toContain('Revenue')
    await expect(lena.locator('.tk-badge')).toHaveText([addedText])
    expect(await readAs(LENA, `users/${marcoUid}/earnings`)).toBe(403)
    expect(await readAs(LENA, `users/${marcoUid}/earnings/${SPACE_ID}_${thisWeek}_${shoot.id}`)).toBe(403)
    expect(await readAs(LENA, `users/${marcoUid}/money/state`)).toBe(403)
    expect(await readAs(MARCO, `users/${marcoUid}/earnings/${SPACE_ID}_${thisWeek}_${shoot.id}`)).toBe(200)
  })

  // Friday: the review window opened a minute ago.
  const t2 = Date.now()
  await weekDoc(SPACE_ID, thisWeek).update({ reviewOpenAt: ts(t2 - MINUTE), deadlineAt: ts(t2 + 6 * HOUR) })

  await test.step('Lena reviews the task as a whole, with its steps as evidence', async () => {
    await lena.getByRole('button', { name: 'Review Marco', exact: true }).click()
    const review = sheet(lena)
    await expect(shown(review, '2 tasks · 1 checked off', true)).toBeVisible()
    await expect(shown(review, 'Marked done by Marco', true)).toBeVisible()
    await expect(shown(review, '0 of 2 steps ticked by Marco', true)).toBeVisible()
    await expect(shown(review, addedText, true)).toBeVisible()
    for (const step of [...SHOOT.steps, ...GRADE.steps]) await expect(shown(review, step, true)).toBeVisible()
    await snap(lena, 'f09-review-sheet-steps')
    await review.getByRole('radiogroup', { name: `Mark for ${SHOOT.title}` }).getByRole('radio', { name: 'Done', exact: true }).click()
    await review.getByRole('radiogroup', { name: `Mark for ${GRADE.title}` }).getByRole('radio', { name: 'Not done', exact: true }).click()
    await review.getByRole('button', { name: 'Submit Reviews', exact: true }).click()
    await lena.getByRole('alertdialog').getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(shown(review, 'Reviews in.')).toBeVisible()
    // One mark per task; steps aren't marked.
    await expect
      .poll(async () => (await weekDoc(SPACE_ID, thisWeek).collection('reviews').doc(`${lenaUid}_${marcoUid}`).get()).get('marks'))
      .toEqual({ [shoot.id]: 1, [grade.id]: 0 })
    await review.getByRole('button', { name: 'Done', exact: true }).click()
  })

  await test.step('Lena’s Overview and Goals hold only her own (empty) money', async () => {
    await lena.getByRole('button', { name: 'Back to Spaces' }).click()
    await tab(lena, 'Overview').click()
    await expect(shown(lena, 'See what your work earns', true)).toBeVisible()
    await tab(lena, 'Goals').click()
    await expect(shown(lena, 'How much do you have right now?', true)).toBeVisible()
  })

  await test.step('Goals: set the balance, add goals, add and remove money', async () => {
    await marco.getByRole('button', { name: 'Back to Spaces' }).click()
    await tab(marco, 'Goals').click()
    await marco.getByRole('button', { name: 'Balance options' }).click()
    await sheet(marco).getByRole('button', { name: 'Set Balance', exact: true }).click()
    const balance = sheet(marco)
    await expect(balance.getByLabel('Balance in USD')).toHaveValue('800')
    await balance.getByLabel('Balance in USD').fill('1,200')
    await balance.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(marco.getByRole('dialog')).toHaveCount(0)
    await expect.poll(async () => (await moneyDoc(marcoUid, 'money/state').get()).get('baseline')).toBe(1200)
    expect((await moneyDoc(marcoUid, 'money/state').get()).get('currency')).toBe('USD')
    // Earned before the balance was set is already in it.
    await expect(marco.locator('.m-balance__value').filter({ visible: true })).toHaveText('$1,200')

    for (const goal of [
      { name: 'Tripod', cost: '400' },
      { name: 'Sony FX3', cost: '2,500' },
    ]) {
      await marco.getByRole('button', { name: 'New goal' }).click()
      const form = sheet(marco)
      await form.getByLabel('Name').fill(goal.name)
      // Return goes on to the cost.
      await form.getByLabel('Name').press('Enter')
      await expect(form.getByLabel('Cost in USD')).toBeFocused()
      await form.getByLabel('Cost in USD').fill(goal.cost)
      if (goal.name === 'Sony FX3') await snap(marco, 'f10-goal-sheet-new')
      await form.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(marco.getByRole('dialog')).toHaveCount(0)
    }
    await expect
      .poll(async () => (await db.collection(`users/${marcoUid}/goals`).orderBy('order').get()).docs.map((d) => [d.get('name'), d.get('cost'), d.get('order')]))
      .toEqual([
        ['Tripod', 400, 0],
        ['Sony FX3', 2500, 1],
      ])
    // A cost is edited as plain digits, so adding or removing one can't turn into a decimal comma.
    await marco.getByRole('button', { name: /^Sony FX3/ }).click()
    await expect(sheet(marco).getByLabel('Cost in USD')).toHaveValue('2500')
    await sheet(marco).getByRole('button', { name: 'Cancel' }).click()
    await expect(marco.getByRole('dialog')).toHaveCount(0)

    await marco.getByRole('button', { name: 'Add Money', exact: true }).click()
    let form = sheet(marco)
    await form.getByLabel('Amount in USD').fill('300')
    await form.getByLabel('Note').fill('Sold the old gimbal')
    await expect(shown(form, 'Your balance will be $1,500.', true)).toBeVisible()
    await snap(marco, 'f11-add-money')
    await form.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(marco.getByRole('dialog')).toHaveCount(0)

    await marco.getByRole('button', { name: 'Remove Money', exact: true }).click()
    form = sheet(marco)
    // More than there is: the preview says so in red.
    await form.getByLabel('Amount in USD').fill('5000')
    await expect(form.locator('.m-negative')).toHaveText('−$3,500')
    await form.getByLabel('Amount in USD').fill('200')
    await form.getByLabel('What for?').fill('Rent')
    await snap(marco, 'f12-remove-money')
    await form.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(marco.getByRole('dialog')).toHaveCount(0)

    await expect
      .poll(async () => (await db.collection(`users/${marcoUid}/moves`).orderBy('at').get()).docs.map((d) => [d.get('kind'), d.get('amount'), d.get('note')]))
      .toEqual([
        ['add', 300, 'Sold the old gimbal'],
        ['spend', 200, 'Rent'],
      ])
    await expect(marco.locator('.m-balance__value').filter({ visible: true })).toHaveText('$1,300')
    // The waterfall: $1,300 fills the tripod first, then $900 of the camera.
    await expect(marco.getByRole('progressbar', { name: 'Tripod: 100 percent funded' })).toBeVisible()
    await expect(marco.getByRole('progressbar', { name: 'Sony FX3: 36 percent funded' })).toBeVisible()
    await expect(shown(marco, 'Funded', true)).toBeVisible()
    await expect(shown(marco, /^\$1,600 to go/)).toBeVisible()
    for (const text of ['Sold the old gimbal', '+$300', 'Rent', '−$200', SHOOT.title, '+$800', 'Balance set']) await expect(shown(marco, text, true)).toBeVisible()
    await snap(marco, 'f13-goals')
  })

  await test.step('A funded goal is marked as bought', async () => {
    await marco.getByRole('button', { name: /^Tripod/ }).click()
    const form = sheet(marco)
    await snap(marco, 'f14-goal-sheet-funded')
    await form.getByRole('button', { name: 'Mark as Bought', exact: true }).click()
    await marco.getByRole('alertdialog').getByRole('button', { name: 'Mark as Bought', exact: true }).click()
    await expect(marco.getByRole('dialog')).toHaveCount(0)
    await expect.poll(async () => (await db.collection(`users/${marcoUid}/goals`).get()).docs.map((d) => d.get('name'))).toEqual(['Sony FX3'])
    const spent = await db.collection(`users/${marcoUid}/moves`).where('note', '==', 'Tripod').get()
    // Marked as a goal, so the pace toward the camera doesn't drop.
    expect(spent.docs.map((d) => [d.get('kind'), d.get('amount'), d.get('goal')])).toEqual([['spend', 400, true]])
    await expect(marco.locator('.m-balance__value').filter({ visible: true })).toHaveText('$900')
    await expect(marco.getByRole('progressbar', { name: 'Sony FX3: 36 percent funded' })).toBeVisible()
    await expect(shown(marco, '−$400', true)).toBeVisible()
  })

  await test.step('Each tab keeps its own stack and scroll position', async () => {
    const goals = tabScroll(marco, 2)
    await goals.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    await expect.poll(() => goals.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
    const scrolled = await goals.evaluate((el) => el.scrollTop)
    // A screen pushed in Overview stays in Overview's stack.
    await tab(marco, 'Overview').click()
    await marco.getByRole('button', { name: new RegExp(SPACE.name) }).filter({ visible: true }).first().click()
    await expect(marco.getByRole('heading', { name: SPACE.name })).toBeVisible()
    await expect(tabBar(marco)).toHaveAttribute('data-hidden', 'true')
    await marco.getByRole('button', { name: 'Back to Overview' }).click()
    await expect(tabBar(marco)).not.toHaveAttribute('data-hidden')
    await tab(marco, 'Spaces').click()
    await expect(marco.getByRole('heading', { name: 'Spaces' })).toBeVisible()
    await tab(marco, 'Goals').click()
    expect(await goals.evaluate((el) => el.scrollTop)).toBe(scrolled)
    // Tapping the selected tab scrolls its root to the top.
    await tab(marco, 'Goals').click()
    await expect.poll(() => goals.evaluate((el) => el.scrollTop)).toBe(0)
    // The last tab comes back after a relaunch.
    await marco.reload()
    await expect(tab(marco, 'Goals')).toHaveAttribute('aria-selected', 'true')
    await expect(marco.locator('.m-balance__value').filter({ visible: true })).toHaveText('$900')
  })

  expect(a.errors).toEqual([])
  expect(b.errors).toEqual([])
  await a.context.close()
  await b.context.close()
})
