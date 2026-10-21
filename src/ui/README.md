# Stakes UI: component catalogue

Everything is exported from `src/ui/index.ts`. Import from there:

```tsx
import { UIProvider, NavigationStack, Screen, Section, Row, Button } from '../ui/index.ts'
```

The look is iOS 26: SF typography, inset grouped lists, floating Liquid Glass bar buttons over a soft scroll edge, and spring motion. The accent is **graphite** (never blue). The rainbow "light" effects are reserved for four moments: completing a task, the Friday reveal, the month verdict, and a score ring at or above 90%.

Live gallery (dev only): run `npx vite`, then open `/gallery.html`. Its source, `src/ui/Gallery.tsx`, is a working reference for every component below.

---

## App shell

### `UIProvider`
Wrap the whole app **once**. It hosts sheets, alerts, banners and the edge glow above the app. It also scales the app back when a card sheet comes up, like a presenting view.

| prop | type | notes |
|---|---|---|
| `children` | ReactNode | |
| `theme?` | `'system' \| 'light' \| 'dark'` | Forces `<html data-theme>`. Omit it to follow the system. |

```tsx
<UIProvider>
  <NavigationStack root={<HomeScreen />} />
</UIProvider>
```

- Put data or session providers **outside** `UIProvider` if content opened with `useSheet().present()` needs them. Declarative `<Sheet>` is a portal, so React context reaches it either way.
- `setTheme(theme)` does the same as the prop, imperatively.
- The body never scrolls. Every screen scrolls inside `<Screen>`. Render full-page content (loading, "Not configured yet", sign-in) inside a `Screen` too, so safe areas and scrolling stay correct.
- **On-screen keyboard.** iOS never resizes the page for the keyboard; it slides the whole app up instead, pushing the nav bar off screen. `UIProvider` follows the visual viewport and undoes that: the app shell ends at the keyboard's top, so screens, the floating toolbar and sheets sit above it, and the focused field is scrolled into view inside its own scroller (clear of the bar and the toolbar). CSS can read `--keyboard-inset` (px, `0px` when hidden) and `:root[data-keyboard]`; `--ui-safe-bottom` is `0px` while the keyboard is up.
- Code outside React can reach the mounted provider through `bridge.ts` (not exported from `index.ts`, so it pulls in no components): `presentToast(options)` shows a banner and returns `false` when no provider is mounted, and `isUIBusy()` is true while a text field is focused or a sheet or alert is up. The service worker updater in `src/push` uses both.
- Edge swipe-back and sheet drags end editing first (they blur the focused field), so a field that saves in `onBlur` still saves when a gesture takes the view away. `blurFocusedField()` from `keyboard.ts` does the same for custom gestures.

### `NavigationStack` + `useNav()`
An in-memory stack, like UINavigationController, with no URL routes:
- Every screen in the stack stays mounted, so scroll positions and state survive.
- Push slides the new screen in from the right while the previous one moves 30% left and dims.
- Pop reverses it.
- An interactive swipe-back from the left 24px follows the finger and settles with a spring. It works along the whole edge, including the nav bar strip.
- With Reduce Motion on, transitions become a crossfade.

| prop | type | notes |
|---|---|---|
| `root` | ReactNode | Usually a `<Screen>` |
| `rootTitle?` | string | Back label for screens pushed from root. Defaults to the root `Screen` title. |

```tsx
const nav = useNav()  // { push, pop, popToRoot, depth, toDepth, canGoBack }
nav.push(<SpaceScreen spaceId={id} />, { title: 'Film Crew' })
nav.pop()
nav.popToRoot()
```
`push(element, { title })`: `title` is used for the *next* screen's back button. A `<Screen title>` inside the pushed element overrides it automatically. `toDepth` is where the stack is heading: it drops as a pop starts (so chrome like the tab bar can return alongside it), while `depth` follows the mounted screens. `useNav()` throws outside a stack. Sheets start a fresh navigation context, so put a `NavigationStack` inside a sheet if the flow has steps.

### `Screen`
The scroll view plus nav bar. iOS 26 style: there is no opaque bar and no hairline. From the first pixels of scroll, content passing under the floating bar buttons softens into a blurred fade of the page color (the "soft scroll edge"), and the large title slides under it while the centered inline title fades in. Pulling down stretches the large title slightly. Tapping the bar scrolls to top.

| prop | type | notes |
|---|---|---|
| `title` | string | |
| `titleDisplay?` | `'large' \| 'inline'` | Default `large`. Use `inline` in sheets and detail screens. |
| `subtitle?` | ReactNode | Line under the large title, e.g. "Week of Oct 13" |
| `trailing?` | ReactNode | Bar items: use `GlassButton`s |
| `leading?` | ReactNode | Replaces the back button, e.g. the xmark `GlassButton` in a sheet |
| `backTitle?` | string \| false | Override the back label. `false` shows the chevron only. |
| `hideBack?`, `onBack?` | | The back button appears automatically when depth > 0 |
| `toolbar?` | ReactNode | Floating glass capsule above the home indicator (above the keyboard while typing). Content scrolls under it with a soft fade. |
| `toolbarFullWidth?` | boolean | Full-width buttons that float on their own, with no glass capsule around them; filled buttons get a soft shadow. Pair it with `<Button size="large" fullWidth>` (one or more, 8px apart). |
| `background?` | `'grouped' \| 'plain'` | Default grouped (`#F2F2F7` / black) |
| `scrollRef?` | Ref<HTMLDivElement> | |

```tsx
<Screen
  title="This Week"
  subtitle="Locks Monday at midnight"
  trailing={<GlassButton icon="plus" aria-label="Add task" onClick={add} />}
  toolbar={<Button size="large" fullWidth onClick={submit}>Submit Reviews</Button>}
  toolbarFullWidth
>
  <Section>…</Section>
</Screen>
```

### `TabView` + `useTabBar()`
UITabBarController: one `NavigationStack` per tab under an iOS 26 floating glass tab bar (a capsule above the home indicator, icon over a small label, the selected tab on a soft pill that springs between items).
- Every tab's stack stays mounted, so screens, state and scroll positions survive switching; inactive tabs aren't drawn or reachable.
- Tapping the selected tab pops its stack to the root, or at the root scrolls it to the top.
- The bar slides away while the keyboard is up and while the active tab has a screen pushed on its root (like `hidesBottomBarWhenPushed`). Sheets and alerts cover it.
- Root screens (`<Screen>` at the bottom of a stack) scroll clear of it on their own; nothing to add.
- `role="tablist"` with arrow-key navigation; Reduce Motion fades instead of sliding.

| prop | type | notes |
|---|---|---|
| `tabs` | `{ id, title, icon, root, badge? }[]` | `root` is the tab's root screen; `badge` a red count at the icon's corner ("9+" above 9, hidden at 0; VoiceOver "Friends, 2 new") |
| `selected`, `onSelect` | | Controlled; persist the choice if the app should reopen on it |

```tsx
<TabView tabs={[{ id: 'home', title: 'Home', icon: 'squareStack', root: <HomeScreen /> }, …]} selected={tab} onSelect={setTab} />
const tabs = useTabBar()  // { selected, select } or null outside a TabView
tabs?.select('goals')
```
`TabBar` is the capsule alone (`items`, `selected`, `onSelect`, `hidden`).

---

## Modals

### `Sheet` (declarative) and `useSheet()` (imperative)
An iOS page sheet:
- Card from the bottom with a grabber, `medium` / `large` detents, and drag to dismiss with velocity.
- When content is scrolled to the top, dragging down moves the sheet; at medium, dragging up expands it.
- The app behind scales to ~0.92 with rounded corners and darkens. Stacked sheets push the one below back.
- Dark mode uses the elevated palette automatically.
- `presentation="fullScreen"` covers everything; use it for multi-step flows (not drag-dismissible by default).

| prop | type | notes |
|---|---|---|
| `open` | boolean | |
| `onClose` | () => void | Called on drag-down, tap outside, or Escape. Set `open=false` in response. |
| `onClosed?` | () => void | After the exit animation |
| `detents?` | `('medium' \| 'large')[]` | Default `['large']`. Opens at the first one. |
| `presentation?` | `'card' \| 'fullScreen'` | |
| `dismissible?` | boolean | Default true for cards |
| `grabber?` | boolean | Default true for cards |

```tsx
<Sheet open={editing} onClose={() => setEditing(false)} detents={['medium', 'large']}>
  <Screen title="Edit Stakes" titleDisplay="inline"
    leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={() => setEditing(false)} />}
    trailing={<GlassButton prominent icon="checkmark" aria-label="Save" onClick={save} disabled={!changed} />}>
    <Section><TextArea value={reward} onChange={setReward} /></Section>
  </Screen>
</Sheet>

const sheet = useSheet()
const close = sheet.present((close) => <InviteSheet onDone={close} />, { detents: ['medium'] })
// inside a sheet: useSheet().dismiss(), .detent, .setDetent('large'), .inSheet
```
Children fill the sheet. Use `<Screen titleDisplay="inline">`, or a `<NavigationStack>` for steps. Add `data-sheet-nodrag` to an element that must never start a sheet drag.
- iOS 26 sheet bar buttons are round glass icons: an `xmark` on the left to cancel or close, and a `prominent` `checkmark` on the right to confirm (Create, Save, Done). Give both an `aria-label`. A disabled prominent button turns into a gray circle with a gray glyph. Keep one confirm action per sheet: no second "Create" button in the content.
- Sheets size to the app shell, so while the keyboard is up they end at its top.

### Alerts: `useAlert()`, `Alert`, `ActionSheet`
These are iOS 26 alerts: a centered glass card, left-aligned text, and capsule buttons. Two actions sit side by side with Cancel on the left; three or more stack. The action sheet is the classic bottom group with a separate Cancel.

```tsx
const { alert, confirm, actionSheet } = useAlert()
await alert({ title: 'Reviews are final', message: 'You can’t change marks after submitting.' })
const ok = await confirm({ title: 'Leave “Film Crew”?', confirmLabel: 'Leave', destructive: true })  // boolean
const choice = await actionSheet({ title: 'Invite', actions: [{ label: 'Share Link' }, { label: 'Copy Code' }] })
// choice: 'Share Link' | 'Copy Code' | null
```
`DialogAction = { label, style?: 'default' | 'cancel' | 'destructive', preferred?: boolean, onPress?() }`. A `preferred` action gets a filled (label-colored) button. The declarative `<Alert open onClose title message actions />` and `<ActionSheet …/>` exist too.

### Banner: `useToast()`
A top notification banner. It slides down and settles without a bounce, like an iOS notification (`springs.banner`), auto-dismisses after 3.2s, and can be swiped up.
```tsx
const toast = useToast()
toast('Copied')
toast({ title: 'Results are in', message: 'Lena gave you 4.5 / 5', icon: 'trophy', tone: 'success', onPress: open })
```
`icon` is an `IconName` or a node. `tone` is `'default' | 'success' | 'error'`.

---

## Lists and input

### `List`, `Section`, `Row`
Inset grouped: 16px margins, rounded groups, 44px rows (52+ with a subtitle), and hairlines inset to the text. Rows show the iOS press highlight (delayed so scrolling doesn't flash).

**`Section`** props:
- `header?`
- `headerStyle?: 'default' | 'prominent'`: prominent is a bold 22pt title such as "This Week".
- `headerAccessory?`: a trailing node in the header (Pill, AvatarStack, plain Button).
- `footer?`
- `padded?`: wraps free-form content (ring cards) in 16px.
- `bare?`: no rounded group.

**`Row`** props: `title`, `subtitle?`, `detail?` (trailing value), `leading?` (Avatar, CheckCircle…), `icon?` + `iconBackground?` (Settings-style tile), `chevron?`, `checked?` (selection checkmark), `toggle?` + `onToggle?` (switch accessory), `accessory?`, `onPress?` (renders a button), `disabled?`, `destructive?` (red title), `action?` (graphite medium-weight action title), `titleLines?`. Titles wrap by default.

```tsx
<Section header="This week" headerStyle="prominent" headerAccessory={<Pill icon="clock">Locks in 5h 12m</Pill>}
         footer="Friends review on Friday.">
  {tasks.map((t) => (
    <Shimmer key={t.id} trigger={justCompleted === t.id ? t.id : undefined}>
      <Row title={t.title} leading={<CheckCircle checked={done[t.id]} onChange={(v) => toggle(t.id, v)} aria-label={t.title} />} />
    </Shimmer>
  ))}
  <Row title="Add Task" action leading={<Icon name="plus" />} onPress={add} />
</Section>
<Section>
  <Row icon="bell" title="Reminders" toggle={on} onToggle={setOn} />
  <Row title="Leave Space" destructive onPress={leave} />
</Section>
```

### Text input
All fields use 17px text so iOS never zooms on focus. `onChange` receives the **string**, not the event.
- `TextField`: a bare field (`variant: 'plain' | 'filled'`, `clearable`, `inputRef`, plus all input attributes).
- `TextFieldRow`: a field laid out as a list row, with an optional `label` and `labelWidth`. Place it in a `Section`.
- `SecureField`: a password field (`autoComplete: 'current-password' | 'new-password'`).
- `TextArea`: auto-grows between `minRows` and `maxRows`. `variant='plain'` drops straight into a `Section`.

```tsx
<Section footer="Use the email you signed up with.">
  <TextFieldRow type="email" value={email} onChange={setEmail} placeholder="Email" autoComplete="email" inputMode="email" />
  <TextFieldRow label="Code" value={code} onChange={setCode} placeholder="XXXX-XXXX" autoCapitalize="characters" />
</Section>
```

### `Toggle`
`<Toggle checked onChange={(v) => …} aria-label />`. It renders `<input type="checkbox" switch>`. Safari 17.4+ draws a native iOS switch (with haptics on iOS 18+), tinted graphite. Other browsers get a drawn iOS 26 switch.

---

## Controls

### `Button`
- `variant`: `'filled'` (label-colored capsule, inverted text, the primary action), `'gray'`, `'plain'` (graphite text), or `'destructive'` (red on gray).
- `size`: `'small'` (32), `'medium'` (44, the default), or `'large'` (52).
- Other props: `fullWidth`, `loading` (spinner, width kept), `icon`, and all button attributes.

Buttons press down to 0.965.
```tsx
<Button size="large" fullWidth loading={saving} onClick={create}>Create Space</Button>
<Button variant="gray" size="small" icon="share">Share</Button>
```

### `GlassButton` / `GlassSurface`
Liquid Glass material: backdrop blur and saturation, a rim light, and a static specular highlight. On desktop the highlight follows the mouse within the element (set per element, so it never restyles the page). There is no device tilt: it cost an iOS motion-permission prompt and a full-page restyle per sensor event. `requestMotionPermission()` is deprecated, does nothing and resolves `false`; delete calls to it. Under Reduce Transparency the material is solid.
- `GlassButton`: a bar or toolbar button. Without children it is a 44px circle (pass `aria-label`). Props: `icon`, `size: 'small' | 'regular' | 'large'`, `prominent` (label-tinted, for Done/Save; gray with a gray glyph when `disabled`). It swells slightly when pressed.
- `GlassSurface`: a floating panel. Props: `radius`, `interactive`, `as`. Keep only a few per screen.

### `SegmentedControl`
A capsule track with a spring-sliding thumb.
```tsx
<SegmentedControl options={[{ value: 'this', label: 'This Week' }, { value: 'next', label: 'Next Week' }]} value={tab} onChange={setTab} />
```
Other props: `fullWidth` (default true), `size: 'regular' | 'small'`, and `aria-label`.

### `MarkPicker`
The Friday review control: **Done (1) / Half (0.5) / Not done (0)**. `value: Mark | null` starts at `null` (no thumb). When selected, Done is a filled graphite thumb, Half is a white thumb, and Not done is red. `size="compact"` (icons only, 132px) fits trailing in a row; the default is full width with labels, placed under the task title.
```tsx
<MarkPicker value={marks[t.id] ?? null} onChange={(m) => setMark(t.id, m)} aria-label={`Mark for ${t.title}`} />
```
`choices="vote"` turns it into the vote on a crossed-out task (SPEC §10.4): two segments, **Fair, Skip It** (`'fair'`, a white thumb) and **Not Done** (0, red), with the same look, motion and 44pt targets. `value` and `onChange` take a `ReviewMark` (`0 | 0.5 | 1 | 'fair'`).

### `CheckCircle`
Reminders-style. Checking it fills the circle, draws the checkmark, sweeps a prism glint, pulses an iridescent ring, gives a spring bounce, and plays a haptic. Props: `checked`, `onChange(next)`, `size` (default 24; the hit target is always 44), `disabled`, `aria-label`. Wrap the row in `Shimmer` for the full-row sweep.

---

## Status and data

- **`ScoreRing`**: an Activity-style ring that sweeps in from 0.
  - Props: `value` (0..100 or `null`), `threshold` (default 90), `iridescent` (default `true`; `false` keeps the arc graphite even at or above the threshold, e.g. for a provisional score), `size` (default 140), `stroke` (default 14), `animate`, `delay`, `showValue` (animated "95%"), `children` (custom center label).
  - With a score, the threshold is a small gap in the gray track (it shows through to whatever the ring sits on, so no color to set). With `value={null}` the track is a plain full circle: no marker, nothing that reads as a spinner.
  - At or above the threshold (compared with a 1e-9 slack, so an average of exactly 90 counts) the arc turns into a smooth prism (one color step per degree) with a soft glow. Below it, the arc is graphite.
  - The ends are round. Near 100% the end cap passes over the start and shades it with a soft shadow, like Activity rings.
  - The percentage (and the default `aria-label`) is floored to a whole number, so 89.9 never shows as 90.
- **`Pill`**: `tone: 'gray' | 'filled' | 'red' | 'green' | 'iridescent'`, `icon`, `size: 'small' | 'regular'`. Tabular numbers, e.g. `<Pill icon="clock">Locks in 5h 12m</Pill>`.
- **`Badge`**: `count`, `tone: 'label' | 'red'`, `hideZero`.
- **`ActivityIndicator`**: the iOS 8-spoke spinner. `size: 'medium' | 'large' | px`, `color`.
- **`ProgressBar`**: `value` 0..1, `tone: 'label' | 'green' | 'iridescent'`.
- **`EmptyState`**: `icon`, `title`, `message`, `action` (like ContentUnavailableView).
- **`Avatar`**: `name`, `color` (pass `colorForUid(uid)` or the profile color), `photo?`, `size`. Shows the photo (cropped to the circle), or SF Rounded initials (one letter below 32px) when there is none or it fails to load; the size is the same either way.
- **`AvatarStack`**: `people: { id?, name, color, photo? }[]`, `max`, `size`. Overlapping, with a "+N" chip.

## Light moments (use sparingly)
- **`useEdgeGlow().play(ms?)`**: a Siri-style prism glow hugging the rounded display edges, then a fade-out. The colors drift gently rather than spinning. In light mode the bands are thin and faint, so white cards near the edges stay white. Use it for the Friday reveal and the month verdict. A standalone `<IridescentEdgeGlow trigger={revealedWeekId} />` replays whenever `trigger` changes to a new truthy value; it also takes `ref.play()`.
- **`<Shimmer trigger={…} radius? inline?>`**: a one-shot diagonal prism sweep over its child. Use it when a task is completed. It also takes `ref.play()`.

## Typography and tokens
- **`<Text variant color weight tabular rounded align as>`**: variants are `largeTitle`, `title1`, `title2`, `title3`, `headline`, `body`, `callout`, `subheadline`, `footnote`, `caption1`, `caption2`. Colors are `label`, `secondary`, `tertiary`, `red`, `green`, `inherit`.
- **`<Facts text="0 of 2 done · reviews in" />`**: a line of facts joined by middle dots that wraps only between facts (a long fact still wraps inside itself) and never leaves a dot at the edge of a line. Use it for subtitles and meta lines that can wrap at 375 points.
- The same styles exist as classes: `t-large-title`, `t-title1`, …, `t-footnote`, `t-caption2`; `t-semibold` / `t-bold`; `t-tabular` (scores, countdowns); `c-secondary` / `c-tertiary` / `c-red` / `c-green`; `ui-visually-hidden`.
- CSS variables live on `:root` (light / dark via `prefers-color-scheme` and `[data-theme]`):
  - Backgrounds: `--system-grouped-background`, `--secondary-system-grouped-background`, `--tertiary-system-grouped-background`, `--system-background`.
  - Labels: `--label`, `--secondary-label`, `--tertiary-label`, `--quaternary-label`, `--on-label` (text on label-colored fills).
  - Separators and grays: `--separator`, `--system-gray` … `--system-gray6`.
  - Fills: `--system-fill` … `--quaternary-system-fill`.
  - Accents: `--system-red`, `--system-green`, `--tint` (graphite).
  - Iridescence: `--iris-1` … `--iris-7`, `--iris-stops`, `--iris-glow-opacity`. A pastel prism (peach, rose, lilac, periwinkle, sky, orchid, a hint of gold), with separate light and dark values. No stop sits next to one that would mix into green or olive.
  - Keyboard: `--keyboard-inset`, plus `:root[data-keyboard]` while it is up.
  - Geometry: `--gutter` (16px), `--radius-group`, `--ui-safe-top`, `--ui-safe-bottom` (inside sheets these account for the sheet). `--font` is the font stack.

## Icons
`<Icon name="gear" size={22} weight? title? />` renders an SF Symbols-style inline SVG in `currentColor`.

Names: chevronLeft, chevronRight, chevronDown, plus, minus, xmark, checkmark, person, person2, personPlus, gear, bell, bellSlash, lock, lockOpen, share, ellipsis, link, calendar, trophy, flame, clock, arrowUpRight, trash, info, addToHomeScreen, copy, envelope, signOut, listBullet, pencil, sparkles, halfCircle, xmarkCircleFill, checkmarkCircleFill, chevronUp, arrowUp, arrowDown, plusCircle, minusCircle, squareStack, chartBar, target, banknote, listIndent, bag, questionmark. `iconNames` lists them; `IconName` is the type.

## Motion, haptics, accessibility
- `springs.navigation | sheet | snappy | banner | bouncy` are motion spring options (`banner` settles with no visible bounce; `bouncy` is only for check-offs and badges): `<motion.div transition={springs.snappy} />`. `transitionFor(name)` returns a short fade instead when the user prefers reduced motion.
- `usePrefersReducedMotion()` and `usePrefersReducedTransparency()` are live hooks; `prefersReducedMotion()` is the one-shot version. All components already respect both preferences: crossfades instead of slides, no sweeps, solid materials.
- `haptic()` plays a light tap: iOS 18+ through a hidden native switch, Android through vibrate. Call it from a tap handler. `CheckCircle`, `MarkPicker` and `SegmentedControl` already call it.
- Only transform and opacity animate. Backdrop blurs are limited to bars, glass buttons and modals.
