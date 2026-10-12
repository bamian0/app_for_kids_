// The third round's first batch end to end, in iPhone-sized browsers against the emulators with the
// real rules: the intro (once per phone, signed out before Welcome and as a cover for someone already
// signed in), Help behind the "?" on every tab, and a profile photo chosen, moved and scaled, seen by a
// friend on their screens, and removed again. Accounts, the space and the week are seeded.
//
// Run with the other specs (see flow.spec.ts), or alone:
//   npx firebase emulators:exec --only auth,firestore --project demo-stakes "npx playwright test batch1"
import { expect, test, type Page } from '@playwright/test'
import { weekBounds, weekIdFor } from '../../src/domain/time.ts'
import { createAccount, db, resetEmulators, setPlan, setSpace, setWeek } from './emulator.ts'
import { phone, sheet, shown, snap } from './helpers.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TZ = 'Europe/Rome'

const MARCO = { name: 'Marco Rossi', email: 'marco@example.com', password: 'secret123' }
const LENA = { name: 'Lena Fischer', email: 'lena@example.com', password: 'secret123' }
const SPACE_ID = 'film-crew'
const SPACE = { name: 'Film Crew', reward: 'Dinner at Da Enzo, on them', penalty: 'Coffee for everyone, for a week' }
const CODE = 'FCRW2345'

const INTRO_TITLES = ['Welcome to Stakes', 'Plan by Monday at midnight', 'Friday is review day', 'Hit 90% and they owe you', 'Your money stays yours']
const PHOTO = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })
/** The one "?" on screen: other tabs stay mounted, hidden from the accessibility tree. */
const helpButton = (page: Page) => page.getByRole('button', { name: 'Help', exact: true })
/** Someone's avatar photo, wherever it is on screen. */
const photoOf = (page: Page, name: string) => page.locator(`.ui-avatar[aria-label="${name}"] img.ui-avatar__photo`).filter({ visible: true })
/** Someone's card in the week, headed by their avatar and name. */
const memberCard = (page: Page, name: string) =>
  page.locator('.ui-section').filter({ visible: true }).filter({ has: page.getByText(name, { exact: true }) })

async function signIn(page: Page, who: typeof MARCO): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'I Have an Account' }).click()
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await expect(tab(page, 'Spaces')).toHaveAttribute('aria-selected', 'true')
}

const introSeen = (page: Page) => page.evaluate(() => localStorage.getItem('stakes.introSeen'))

/** Marco and Lena in a space, with this week (its real Rome timeline) and a plan each, so every screen has people on it. */
async function seed(): Promise<{ marcoUid: string; lenaUid: string; thisWeek: string }> {
  await resetEmulators()
  const t0 = Date.now()
  const marcoUid = await createAccount(MARCO, '#FF9500', t0 - 40 * DAY)
  const lenaUid = await createAccount(LENA, '#AF52DE', t0 - 40 * DAY)
  await setSpace(SPACE_ID, { ...SPACE, members: [marcoUid, lenaUid], timezone: TZ, utcOffsetMin: 120, inviteCode: CODE, at: t0 - 30 * DAY })
  const thisWeek = weekIdFor(t0, TZ)
  await setWeek(SPACE_ID, thisWeek, { ...weekBounds(thisWeek, TZ), members: [marcoUid, lenaUid], submittedBy: [] })
  await setPlan(SPACE_ID, thisWeek, marcoUid, [{ id: 'm1', title: 'Color grade the Nike spot' }, { id: 'm2', title: 'Update the reel' }], t0 - HOUR)
  await setPlan(SPACE_ID, thisWeek, lenaUid, [{ id: 'l1', title: 'Finish the Lavazza edit' }, { id: 'l2', title: 'Two gym sessions' }], t0 - HOUR)
  return { marcoUid, lenaUid, thisWeek }
}

/** A photo as a phone would hand it over: a JPEG drawn in the browser (a portrait, `w` × `h`). */
async function makeJpeg(page: Page, w: number, h: number, hue: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ({ w, h, hue }) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')!
      const sky = g.createLinearGradient(0, 0, 0, h)
      sky.addColorStop(0, `hsl(${hue} 60% 82%)`)
      sky.addColorStop(1, `hsl(${(hue + 30) % 360} 40% 46%)`)
      g.fillStyle = sky
      g.fillRect(0, 0, w, h)
      // A head and shoulders, so the crop has something to frame.
      g.fillStyle = `hsl(${hue} 22% 18%)`
      g.beginPath()
      g.ellipse(w / 2, h * 0.42, w * 0.2, h * 0.19, 0, 0, Math.PI * 2)
      g.fill()
      g.beginPath()
      g.ellipse(w / 2, h * 1.02, w * 0.48, h * 0.4, 0, 0, Math.PI * 2)
      g.fill()
      const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), 'image/jpeg', 0.9))
      let s = ''
      for (const b of new Uint8Array(await blob.arrayBuffer())) s += String.fromCharCode(b)
      return btoa(s)
    },
    { w, h, hue },
  )
  return Buffer.from(base64, 'base64')
}

/** Width and height from a JPEG's frame header. */
function jpegSize(jpeg: Buffer): { width: number; height: number } {
  let i = 2
  while (i < jpeg.length) {
    if (jpeg[i] !== 0xff) throw new Error(`Not a JPEG marker at ${i}`)
    const marker = jpeg[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) }
    }
    i += 2 + jpeg.readUInt16BE(i + 2)
  }
  throw new Error('No frame header')
}

const storedPhoto = async (uid: string) => (await db.doc(`users/${uid}`).get()).get('photo') as string | undefined

test('the intro shows once on a new phone, before Welcome and before an invite', async ({ browser }) => {
  await seed()
  const a = await phone(browser, { intro: true })
  const page = a.page

  await test.step('A first launch opens on the intro; Continue pages through to Get Started', async () => {
    await page.goto('/')
    for (const [i, title] of INTRO_TITLES.entries()) {
      await expect(page.getByRole('heading', { name: title })).toBeVisible()
      await expect(page.getByRole('img', { name: `Page ${i + 1} of 5` })).toBeVisible()
      const last = i === INTRO_TITLES.length - 1
      // Skip on every page but the last, which ends with Get Started instead.
      await expect(page.getByRole('button', { name: 'Skip', exact: true })).toHaveCount(last ? 0 : 1)
      // Long enough for the picture to finish playing.
      await snap(page, `b0${i + 1}-intro-${i + 1}`, 2600)
      await page.getByRole('button', { name: last ? 'Get Started' : 'Continue', exact: true }).click()
    }
    await expect(page.getByRole('button', { name: 'I Have an Account' })).toBeVisible()
    expect(await introSeen(page)).toBe('1')
  })

  await test.step('It doesn’t come back after a reload', async () => {
    await page.reload()
    await expect(page.getByRole('button', { name: 'I Have an Account' })).toBeVisible()
    await expect(page.getByRole('heading', { name: INTRO_TITLES[0] })).toHaveCount(0)
  })

  await test.step('A swipe pages too, and Skip ends it at once', async () => {
    const b = await phone(browser, { intro: true })
    await b.page.goto('/')
    await expect(b.page.getByRole('heading', { name: INTRO_TITLES[0] })).toBeVisible()
    await b.page.locator('.intro__pager').evaluate((el) => el.scrollTo({ left: el.clientWidth }))
    await expect(b.page.getByRole('heading', { name: INTRO_TITLES[1] })).toBeVisible()
    await expect(b.page.getByRole('img', { name: 'Page 2 of 5' })).toBeVisible()
    await b.page.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(b.page.getByRole('button', { name: 'I Have an Account' })).toBeVisible()
    await b.page.reload()
    await expect(b.page.getByRole('button', { name: 'I Have an Account' })).toBeVisible()
    expect(b.errors).toEqual([])
    await b.context.close()
  })

  await test.step('An invite link on a new phone shows the intro first, then the invite', async () => {
    const c = await phone(browser, { intro: true })
    await c.page.goto(`/?join=${CODE}`)
    await expect(c.page.getByRole('heading', { name: INTRO_TITLES[0] })).toBeVisible()
    await c.page.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(shown(c.page, `${MARCO.name} invited you to ${SPACE.name}`)).toBeVisible()
    expect(c.errors).toEqual([])
    await c.context.close()
  })

  expect(a.errors).toEqual([])
  await a.context.close()
})

test('someone already signed in sees the intro once; Help is on every tab', async ({ browser }) => {
  await seed()
  const a = await phone(browser, { intro: true })
  const page = a.page

  await test.step('Signed in on a phone that never saw the intro: it covers the tabs once', async () => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    await signIn(page, MARCO)
    // As if they had signed in before this shipped: no flag on the phone yet.
    await page.evaluate(() => localStorage.removeItem('stakes.introSeen'))
    await page.reload()
    const cover = page.getByRole('dialog', { name: 'Introduction' })
    await expect(cover).toBeVisible()
    await expect(cover.getByRole('heading', { name: INTRO_TITLES[0] })).toBeVisible()
    await snap(page, 'b06-intro-cover', 1600)
    await cover.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await introSeen(page)).toBe('1')
    await page.reload()
    await expect(tab(page, 'Spaces')).toHaveAttribute('aria-selected', 'true')
    await expect(shown(page, SPACE.name)).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  await test.step('The ? on every tab opens Help', async () => {
    for (const [name, shot] of [
      ['Spaces', 'b07-spaces-help-button'],
      ['Overview', 'b08-overview-help-button'],
      ['Goals', 'b09-goals-help-button'],
    ] as const) {
      await tab(page, name).click()
      await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true')
      await expect(helpButton(page)).toBeVisible()
      await snap(page, shot, 1000)
      await helpButton(page).click()
      const help = page.getByRole('dialog', { name: 'Help' })
      await expect(help.getByRole('heading', { name: 'How Stakes Works' })).toBeVisible()
      await expect(shown(help, 'Friday review', true)).toBeVisible()
      if (name === 'Spaces') {
        await snap(page, 'b10-help-top', 900)
        await help.locator('.ui-screen__scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
        await expect(help.getByRole('button', { name: 'Show the Intro Again' })).toBeInViewport()
        await snap(page, 'b11-help-bottom')
      }
      await help.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }
  })

  await test.step('Show the Intro Again plays it as a cover, and leaves the flag alone', async () => {
    await helpButton(page).click()
    await page.getByRole('dialog', { name: 'Help' }).getByRole('button', { name: 'Show the Intro Again' }).click()
    const cover = page.getByRole('dialog', { name: 'Introduction' })
    await expect(cover.getByRole('heading', { name: INTRO_TITLES[0] })).toBeVisible()
    // Help closed on the way: the intro is the only sheet.
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await cover.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.reload()
    await expect(tab(page, 'Goals')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  await test.step('How Stakes Works in the profile shows the same Help', async () => {
    await tab(page, 'Spaces').click()
    await page.getByRole('button', { name: 'Profile', exact: true }).click()
    await sheet(page).getByRole('button', { name: 'How Stakes Works' }).click()
    await expect(sheet(page).getByRole('heading', { name: 'How Stakes Works' })).toBeVisible()
    await expect(shown(sheet(page), 'Your week at a glance')).toBeVisible()
    await snap(page, 'b17-help-in-profile')
    await sheet(page).getByRole('button', { name: /^Back/ }).click()
    await sheet(page).getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  expect(a.errors).toEqual([])
  await a.context.close()
})

test('a profile photo: choose, move and scale, friends see it, remove it', async ({ browser }) => {
  const { marcoUid, lenaUid } = await seed()
  const a = await phone(browser)
  const b = await phone(browser)
  const marco = a.page
  const lena = b.page

  await signIn(marco, MARCO)
  // Lena already has a photo, so the screens show both kinds of avatar.
  const lenaPhoto = await makeJpeg(marco, 256, 256, 20)
  await db.doc(`users/${lenaUid}`).update({ photo: `data:image/jpeg;base64,${lenaPhoto.toString('base64')}` })
  const upload = await makeJpeg(marco, 1200, 1600, 210)

  await test.step('Lena has the space open: Marco shows as initials', async () => {
    await signIn(lena, LENA)
    await lena.getByRole('button', { name: new RegExp(SPACE.name) }).click()
    await expect(lena.getByRole('heading', { name: SPACE.name })).toBeVisible()
    await expect(memberCard(lena, MARCO.name).locator('.ui-avatar').first()).toHaveText('MR')
  })

  await test.step('Marco chooses a photo, moves and scales it, and chooses', async () => {
    await marco.getByRole('button', { name: 'Profile', exact: true }).click()
    await sheet(marco).getByRole('button', { name: 'Add a photo' }).click()
    // No photo yet: nothing to remove.
    await expect(marco.getByRole('button', { name: 'Remove Photo', exact: true })).toHaveCount(0)
    const [chooser] = await Promise.all([marco.waitForEvent('filechooser'), marco.getByRole('button', { name: 'Choose Photo', exact: true }).click()])
    await chooser.setFiles({ name: 'IMG_0420.jpg', mimeType: 'image/jpeg', buffer: upload })

    const crop = marco.getByRole('dialog', { name: 'Move and Scale' })
    await expect(crop.getByRole('heading', { name: 'Move and Scale' })).toBeVisible()
    const zoom = crop.getByRole('slider', { name: 'Zoom' })
    await expect(zoom).toBeEnabled()
    expect(Number(await zoom.inputValue())).toBe(0)
    await snap(marco, 'b12-move-and-scale', 900)

    // Two real fingers through the browser's touch input: pinch out about the middle, then drag.
    const cdp = await a.context.newCDPSession(marco)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<[number, number]>) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) })
    // Where the stage is once the sheet has finished sliding up: touches mid-slide land outside it.
    const stage = crop.locator('.p-crop__stage')
    let box = (await stage.boundingBox())!
    for (let tries = 0; tries < 40; tries++) {
      await marco.waitForTimeout(100)
      const now = (await stage.boundingBox())!
      const still = now.y === box.y && now.height === box.height
      box = now
      if (still) break
    }
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]])
    for (let i = 1; i <= 10; i++) {
      await touch('touchMove', [[cx - 40 - i * 4, cy], [cx + 40 + i * 4, cy]])
      await marco.waitForTimeout(16)
    }
    await touch('touchEnd', [])
    await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(0.1)
    await touch('touchStart', [[cx, cy]])
    for (let i = 1; i <= 8; i++) {
      await touch('touchMove', [[cx + i * 2, cy + i * 3]])
      await marco.waitForTimeout(16)
    }
    await touch('touchEnd', [])
    await snap(marco, 'b13-move-and-scale-zoomed', 900)

    await crop.getByRole('button', { name: 'Choose', exact: true }).click()
    await expect(marco.getByRole('dialog', { name: 'Move and Scale' })).toHaveCount(0)
  })

  let saved = ''
  await test.step('The stored photo is a small square JPEG, and the profile shows it', async () => {
    await expect.poll(() => storedPhoto(marcoUid)).toMatch(PHOTO)
    saved = (await storedPhoto(marcoUid))!
    expect(saved.length).toBeLessThanOrEqual(60_000)
    expect(jpegSize(Buffer.from(saved.slice(saved.indexOf(',') + 1), 'base64'))).toEqual({ width: 256, height: 256 })
    await expect(sheet(marco).getByRole('button', { name: 'Change your photo' })).toBeVisible()
    await expect(sheet(marco).locator('.p-avatar img.ui-avatar__photo')).toHaveAttribute('src', saved)
    await expect(sheet(marco).locator('.p-avatar[aria-busy]')).toHaveCount(0)
    await snap(marco, 'b14-profile-with-photo')
    await sheet(marco).getByRole('button', { name: 'Done', exact: true }).click()
    // His own avatar in the bar.
    await expect(photoOf(marco, MARCO.name).first()).toHaveAttribute('src', saved)
  })

  await test.step('Lena sees it on his member card, live, and in the space’s stack', async () => {
    await expect(memberCard(lena, MARCO.name).locator('img.ui-avatar__photo').first()).toHaveAttribute('src', saved)
    await snap(lena, 'b15-week-with-photos')
    await lena.getByRole('button', { name: 'Back to Spaces' }).click()
    const stack = lena.locator('.s-space-card .ui-avatar-stack').filter({ visible: true })
    await expect(stack.locator(`.ui-avatar[aria-label="${MARCO.name}"] img`)).toHaveAttribute('src', saved)
    await expect(stack.locator(`.ui-avatar[aria-label="${LENA.name}"] img`)).toBeVisible()
    await snap(lena, 'b16-spaces-with-photos', 1000)
  })

  await test.step('Remove Photo asks first, then brings back his initials everywhere', async () => {
    await marco.getByRole('button', { name: 'Profile', exact: true }).click()
    await sheet(marco).getByRole('button', { name: 'Change your photo' }).click()
    await marco.getByRole('button', { name: 'Remove Photo', exact: true }).click()
    const confirm = marco.getByRole('alertdialog')
    await expect(confirm.getByText('Remove your photo?')).toBeVisible()
    await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect.poll(() => storedPhoto(marcoUid)).toBeUndefined()
    await expect(sheet(marco).getByRole('button', { name: 'Add a photo' })).toBeVisible()
    await expect(sheet(marco).locator('.p-avatar .ui-avatar')).toHaveText('MR')
    const stack = lena.locator('.s-space-card .ui-avatar-stack').filter({ visible: true })
    await expect(stack.locator(`.ui-avatar[aria-label="${MARCO.name}"] img`)).toHaveCount(0)
    // Small avatars show one initial.
    await expect(stack.locator(`.ui-avatar[aria-label="${MARCO.name}"]`)).toHaveText('M')
  })

  expect(a.errors).toEqual([])
  expect(b.errors).toEqual([])
})
