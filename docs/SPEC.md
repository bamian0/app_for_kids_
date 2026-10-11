# Stakes — product & technical spec

Stakes is a weekly accountability app between friends. Each person plans their tasks for the week, friends review each other every Friday, and a monthly score decides who owes whom. It is a web app (React + Vite + TypeScript) that iPhone users add to their Home Screen. The backend is Firebase on the free Spark plan: Auth (email/password) and Cloud Firestore. It is hosted on GitHub Pages and sends reminder push notifications from a scheduled GitHub Action.

This file is the contract between all modules. If code and spec disagree, fix one of them deliberately. Don't let them drift.

## 1. Rules of the game

### Spaces
- A **space** is a group of 2–8 friends who rate each other.
- A user can be in many spaces.
- The creator writes the stakes as free text, which the app only displays:
  - **reward**: what the others owe a member who hits the bar, e.g. "Dinner on me".
  - **penalty**: what a member who misses owes the others, e.g. "You buy coffee for a week".
- **threshold** = 90 (percent). **latePenalty** = 5 points.
- **timezone** is set to the creator's IANA zone at creation. Every deadline in the space uses this zone. **utcOffsetMin** is that zone's UTC offset at creation (minutes, −720…840). Both are immutable; the rules anchor every week's timeline to the offset (see Week timeline).
- Friends join by invite code (8 characters, alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, shown as `XXXX-XXXX`) or by an invite link `<app-url>?join=XXXXXXXX`. Anyone with the code can see the invite (space name, stakes, who invited them) before signing up.
- The **owner** (`ownerId`, the creator at first) can remove another member and reset the invite code: the space gets a new code, its invite moves to it, and the old code stops working at once. When the owner leaves and others remain, ownership passes in the same write to the remaining member who joined first.
- Leaving or being removed records `leftAt[uid]`. Past weeks keep the leaver's results; see Participation.
- **Stakes per month.** Any member can edit the reward and penalty, but each month's stakes freeze once that month's first task lists lock (the first member to open the app after that writes `months/{monthId}`). An edit then only changes months that aren't frozen yet. Before the freeze (e.g. a typo right after creating the space) an edit still applies to the current month. Verdicts and the verdict push quote the frozen stakes, falling back to the space's text for a month that was never frozen.

### Week timeline (space timezone)
A week is identified by the date of its Monday: `WeekId = 'YYYY-MM-DD'`. All boundaries are exclusive instants:

| Instant | Meaning |
|---|---|
| `startAt` | Monday 00:00 |
| `lockAt` | Tuesday 00:00, so "locks Monday at midnight". The task list can be edited any time before this, including the week before. |
| `reviewOpenAt` | Friday 00:00. The review window opens. |
| `deadlineAt` | Saturday 00:00, so "reviews due Friday at midnight". |

Phases: `planning` (now < lockAt) → `active` (lockAt ≤ now < reviewOpenAt) → `review` (reviewOpenAt ≤ now < deadlineAt) → `closed`.

Once a week doc exists, its stored timestamps are the week's timeline: the rules judge every write by them, so the screens, the data layer's own checks and the reminders job use them too. The computed bounds are only used before the doc exists.

The rules keep the stored timeline honest: `startAt` must be within 1h of Monday 00:00 UTC − `utcOffsetMin` (the hour covers DST and a space created in the other season), and every later bound within 1h of whole days after `startAt`. Spaces created before `utcOffsetMin` existed fall back to "within 14h of Monday 00:00 UTC" until the reminders job backfills their offset. If the stored bounds still differ from the zone's by more than an hour, `WeekData.boundsMismatch` is true and the screens should say so; the stored times still rule.

The UI shows **this week** and **next week**. Planning next week is allowed at any time.

### Participation
- Everyone who is a space member before a week's `lockAt` takes part in it, whether or not they open it. Whenever any member opens the app (the spaces list, a space or a week), the client makes sure this week (until it locks) and next week exist and hold every current member. A week nobody opens before `lockAt` has no doc and no participants.
- Someone who joins a space after a week's `lockAt` starts with the next week (`space.joinedAt[uid] ≥ lockAt`; `joinedAfterLock()` in the domain tells this apart from a member who simply has no tasks).
- A participant with **zero tasks** at lock scores **0%** that week ("you committed to nothing").
- Someone who leaves the space (or deletes their account, or is removed) is taken out of this week and next week while the week is before `deadlineAt` and they haven't submitted. Until a week's deadline only participants who are still members count: nobody has to review someone who left, and they don't hold back the reveal. For a closed week, someone who left after its deadline still counts (`membersAt(space, deadlineAt)`: current members plus `leftAt ≥ deadlineAt`), so leaving never rewrites a finished week. A leaver who had already submitted stays a participant of that week with their own result.

### During the week
- Each participant can tick their own tasks as done ("self check-offs") until `deadlineAt`. Everyone in the space can see them.

### Friday review
- Every participant reviews every other participant who has ≥1 task.
- Each task gets a mark: **Done = 1**, **Half = 0.5**, **Not done = 0**.
- Reviews are written once, on **Submit**, with all reviewees in a single batch. They are **final**: no edits after submitting.
- Reviews can only be created inside the review window.
- Only current space members can submit.
- **Blind**: you can't see reviews written by others, about you or anyone else, until they are revealed. Reveal happens when every week member who is still in the space has submitted (`submittedBy ⊇ members ∩ space.memberIds`) or at `deadlineAt`, whichever comes first. You can always see your own submitted reviews. The data layer never publishes a revealed week with only your own reviews: it holds the previous state until everyone's have loaded.

### Weekly score (per participant M with n tasks)
- If n = 0, the score is 0.
- If at least one other participant submitted a review of M, each task's mark is the average of the submitted reviewers' marks for that task. A missing mark for a task counts as 0.
- If nobody reviewed M (all reviewers missed the deadline, or M is alone in the space), each task's mark is M's self check-off: done = 1, else 0.
- `score = 100 × Σ marks / n`, a number from 0 to 100.
- Before reveal, the UI may show a **provisional** score computed from self check-offs, clearly labelled.

### Missed reviews
After `deadlineAt`, a participant R **missed** a review of M if M had ≥1 task, M still counts for that week (see Participation) and no review R→M exists. Each miss costs R `latePenalty` (5) points off their own monthly score. M is not punished; M's tasks fall back to M's self check-offs only if *no one* reviewed M.

### Monthly score
- A week belongs to the month of its **Friday**: `MonthId = 'YYYY-MM'` of `reviewOpenAt` in the space timezone.
- A member's month average is the mean of their scores in **closed** weeks of that month in which they participated.
- `finalScore = max(0, average − latePenalty × missedReviewsInMonth)`. If there is no closed participating week, it is `null`. `average` and `finalScore` are rounded to 1e-9, so a month that averages exactly 90 reads as exactly 90 everywhere.
- The month's roster is everyone who took part in one of its weeks plus the current members; someone who has left since is marked `former` and still owes or is owed for it. Each result lists its `others`: everyone else who took part that month. Members who joined later aren't in anyone's `others`.
- A month is **complete** when `now ≥ deadlineAt` of its last week. Until then the UI shows the score so far.
- When complete: `finalScore ≥ threshold` means the month's `others` owe M the reward. Otherwise M owes them the penalty. The reward and penalty are the month's frozen stakes (see Spaces). With no `others`, nothing is owed.
- Settlements are honor-system toggles ("Settled") stored per month per member, current or former. **No money moves through the app.**

## 2. Firestore data model

Timestamps are Firestore `Timestamp` in storage and epoch milliseconds (`number`) in TypeScript domain types. The data layer converts between them.

```
users/{uid}                                  { name, color, createdAt }
users/{uid}/push/{subId}                     { endpoint, keys: { p256dh, auth }, createdAt, ua }
invites/{code}                               { spaceId, spaceName, reward, penalty, inviterName, createdBy, createdAt }
spaces/{spaceId}                             { name, reward, penalty, ownerId, memberIds[], joinedAt{uid: ts}, leftAt?{uid: ts},
                                               timezone, utcOffsetMin, inviteCode, threshold: 90, latePenalty: 5, createdAt }
spaces/{spaceId}/joins/{uid}                 { code, createdAt }            # proof of invite, written in the join batch
spaces/{spaceId}/weeks/{weekId}              { startAt, lockAt, reviewOpenAt, deadlineAt, members[], submittedBy[] }
spaces/{spaceId}/weeks/{weekId}/plans/{uid}     { tasks: [{ id, title }], updatedAt }
spaces/{spaceId}/weeks/{weekId}/progress/{uid}  { done: { [taskId]: boolean }, updatedAt }
spaces/{spaceId}/weeks/{weekId}/reviews/{reviewerId}_{revieweeId}
                                             { reviewerId, revieweeId, marks: { [taskId]: 0|0.5|1 }, submittedAt }
spaces/{spaceId}/months/{monthId}            { reward, penalty, createdAt }  # the month's frozen stakes
spaces/{spaceId}/settlements/{monthId}_{uid} { monthId, uid, settled, settledBy, settledAt }
public/config                                { vapidPublicKey }              # written by the reminders job (admin)
_private/*                                   admin only (VAPID private key, sent-notification log)
```

Limits: space name 1–40 chars; reward/penalty 1–120 chars; user name 1–40 chars; ≤25 tasks per plan; task title 1–120 chars; task ids `[A-Za-z0-9_-]{1,64}` (also as review mark keys and check-off keys); ≤8 members per space; profile color `#RRGGBB`.

### Security rules (`firestore.rules`), what must hold
- `users/{uid}`: any signed-in user can `get` a profile; `list` is denied, so nobody can enumerate users. Only the owner can write, with field validation; `color` must be `#RRGGBB` (it lands in CSS).
- `users/{uid}/push/*`: only the owner can read and write. `endpoint` must be on a real push service: `web.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com` or `*.notify.windows.com`. The number of subscriptions is not capped by the rules; the reminders job only uses each user's 5 newest.
- `invites/{code}`: anyone, signed in or not, can `get` (the code is the secret); `list` is denied. Only a member of `spaceId` can create, with `createdBy == auth.uid`, only under the space's own `inviteCode`, and with `spaceName`, `reward` and `penalty` equal to the space's (checked with `getAfter`, so the space and its invite can be written in one batch). A member can update `spaceName`/`reward`/`penalty` alone, and only to mirror the space. The creator or any space member can delete.
- `spaces/{id}`: only members can read. Create requires `ownerId == auth.uid`, `memberIds == [auth.uid]`, `joinedAt == {auth.uid: request.time}`, `utcOffsetMin` an int in −720…840, threshold 90, latePenalty 5, and validated fields. Allowed updates, and nothing else (timezone, utcOffsetMin, threshold, latePenalty and createdAt never change):
  - a member edits `name`/`reward`/`penalty`;
  - a member leaves: removes self from `memberIds` and `joinedAt`, optionally sets `leftAt[self] = request.time`; if the leaver is the owner and others remain, `ownerId` must become a remaining member with the earliest `joinedAt`, otherwise `ownerId` stays;
  - the owner removes one other member the same way (`memberIds`, `joinedAt`, optionally `leftAt[them] = request.time`);
  - the owner sets a new, valid `inviteCode` (alone);
  - in a space whose `ownerId` is no longer a member, a member sets `ownerId` (alone) to the earliest-joined member;
  - a non-member joins: only `memberIds` (appending self) and `joinedAt` (adding self = request.time) change, `getAfter(spaces/{id}/joins/{auth.uid}).data.code` is the space's current `inviteCode` and names an invite whose `spaceId == id`, and the member count stays ≤ 8.
- `spaces/{id}/joins/{uid}`: create only by `uid == auth.uid`, and only if `invites/{code}.spaceId == id`. Read by self.
- `weeks/{weekId}`: members can read. A member can create it when:
  - `weekId` is a Monday date;
  - the timeline is anchored to the space: `startAt` within 1h of `weekId` 00:00 UTC − `utcOffsetMin` (within 14h of `weekId` 00:00 UTC for a space without `utcOffsetMin`); `lockAt`, `reviewOpenAt`, `deadlineAt` within 1h of `startAt` + 1, 4, 5 days;
  - `submittedBy == []`;
  - `members` holds exactly the space's current members;
  - `request.time < lockAt`, and `startAt < request.time + 8 days` (no far-future weeks).

  Allowed updates, and nothing else:
  - before `lockAt`, a space member appends current space members who are missing from `members` (no duplicates);
  - before `deadlineAt`, one uid leaves `members` if it is no longer a space member (`getAfter`, so it goes in the same batch as leaving the space) and hasn't submitted; the writer is that uid or the space's owner;
  - add self to `submittedBy` while `reviewOpenAt ≤ request.time < deadlineAt`, self ∈ `members` and self is still a space member.
- `plans/{uid}`: members of the space can read. The owner can write while `request.time < lockAt` and owner ∈ `week.members`; `tasks` must be a list of ≤ 25 items.
- `progress/{uid}`: members can read. The owner can write while `request.time < deadlineAt` and owner ∈ `week.members`; `done` has ≤ 200 boolean entries and each write adds at most one key, shaped like a task id.
- `reviews/{rid}`:
  - create only, no update or delete;
  - `rid == reviewerId + '_' + revieweeId`; `reviewerId == auth.uid`; reviewer and reviewee ∈ `week.members` and differ;
  - `marks` has ≤ 25 keys shaped like task ids, values 0 / 0.5 / 1;
  - `reviewOpenAt ≤ request.time < deadlineAt`;
  - reviewer ∉ `get(week).submittedBy` (pre-batch state) and ∈ `getAfter(week).submittedBy` (so it is the submit batch, which also requires the reviewer to still be a member);
  - `submittedAt == request.time`.

  Read: the reviewer, or a space member when revealed (`request.time ≥ deadlineAt || week.submittedBy ⊇ week.members ∩ space.memberIds`).

  Clients must query in ways the rules can prove. Before reveal: `where('reviewerId','==',uid)`. After reveal: the whole collection.
- `months/{monthId}`: members can read. A member can create it (never update or delete) with exactly `{reward, penalty, createdAt}`, `reward`/`penalty` equal to the space's current ones, `createdAt == request.time`, and `monthId` between the month of `request.time − 3 days` and the month of `request.time + 5 days` (the month of the current week's Friday in any zone).
- `settlements/*`: members can read and write, with field validation; `uid` is a current member or one in `leftAt`.
- `public/config`: signed-in users can read; nobody can write. `_private/**`: no client access.

### Data layer (`src/data/api.ts`), behaviour the screens rely on
- `createSpace` writes the space and its invite in one batch. It first checks the server answers (8 s); offline it fails at once with the offline message instead of queueing, and a second identical call while the first is in flight returns the first.
- `lookupInvite` works signed out; `Invite` carries `reward` and `penalty` (empty on invites from before). `updateSpace` keeps the invite's name and stakes in step.
- `leaveSpace` and `deleteMyAccount` take the user out of this week and next week (see Participation), record `leftAt`, and hand ownership on. `removeMember(spaceId, uid)` and `resetInviteCode(spaceId) → new code` are owner-only.
- `useMySpaces`, `useSpace` and `useWeek` run `ensureSpace`: this week (until it locks) and next week hold every current member, the current month's stakes are frozen once its first lists have locked, and a space whose owner already left (older versions) passes to its earliest-joined member.
- `useMonthStakes(space, monthId)` gives `{ reward, penalty, frozen }`, falling back to the space's text with `frozen: false`.
- `useWeek(...).data.boundsMismatch` flags a skewed stored timeline. A revealed week is never published with only the user's own reviews.
- After joining or leaving, the cached space, weeks, months and settlements of that space are dropped (`forget`), so nothing stale lingers.
- `sendPasswordReset` resolves for unknown emails too (no account enumeration).

Known limits: the rules don't cap how many spaces an account creates, and a determined member can still write a week with a skew of up to an hour (or up to 14h on a space the reminders job hasn't backfilled yet); the client flags it (`boundsMismatch`).

## 3. Module map and ownership

| Path | Owner | Notes |
|---|---|---|
| `src/domain/types.ts` | contract (scaffold) | Shared types. Change only deliberately. |
| `src/domain/time.ts`, `src/domain/scoring.ts`, `src/domain/ids.ts` + `*.test.ts` | domain | Pure, no Firebase, no DOM. Imports use explicit `.ts` extensions and erasable TS only, so Node can run them directly (`node scripts/reminders.ts`). |
| `src/domain/clock.ts` | contract (scaffold) | `now()`; dev override via `?now=` |
| `firestore.rules`, `firestore.indexes.json`, `firebase.json`, `tests/rules/**`, `vitest.rules.config.ts` | rules | Emulator-tested |
| `src/firebase/**`, `src/data/**` | data | Implements the API in `src/data/api.ts` (signatures fixed by scaffold) |
| `src/ui/**` | design system | iOS-native look, components, motion, iridescence |
| `src/App.tsx`, `src/screens/**` | screens | All screens and navigation |
| `public/sw.js`, `public/manifest.webmanifest`, `public/icons/**`, `src/push/**`, `vite.config.ts`, `src/stubs/**`, `scripts/**`, `.github/workflows/**` | platform | PWA, push, reminders job, deploy |
| `tests/data/**`, `vitest.data.config.ts` | data | Data layer against the emulators |
| `tests/e2e/**`, `playwright.config.ts` | integration | Emulator-backed end-to-end + screenshots |

### Checks
| What | Command |
|---|---|
| Types | `npx tsc -b` |
| Unit (domain, push client, reminders planner) | `npm test` |
| Security rules | `npm run test:rules` |
| Data layer and reminders job | `npm run test:data` (= `npx firebase emulators:exec --config tests/data/firebase.data.json --only auth,firestore --project demo-stakes "npx vitest run --config vitest.data.config.ts"`) |
| End to end (Chromium, iPhone viewport) | `npx firebase emulators:exec --only auth,firestore --project demo-stakes "npx playwright test"`; set `E2E_SCREENSHOTS=<dir>` (and optionally `E2E_WIDTHS=375,430`) for light and dark screenshots of every step |
| Build | `npm run build` (output in `dist/`, relative asset paths) |

## 4. Platform
- **Hosting**: GitHub Pages from the `gh-pages` branch. `.github/workflows/deploy.yml` builds on push to `main` or `claude/**` and publishes `dist/`, including a `.nojekyll` file. The Vite base is `./`.
- **Bundle** (`vite.config.ts`): vendor chunks `firebase`, `react`, `motion` and `luxon` sit apart from the app chunk, so a typical deploy re-downloads only the app (~45 kB gzip). Screens are not route-split: a resumed old client would 404 on lazy chunks removed by the next deploy. `re2js` (only used by Firestore's client-side pipeline regex functions, which the app never calls) is aliased to a stub that throws (`src/stubs/re2js.ts`).
- **Updates**: each build has an id (the commit SHA on CI) that the build writes into `dist/sw.js` and into the page. iOS resumes Home Screen apps without navigating, so on every return to the app (`visibilitychange`, at most every 30 minutes) the client calls `registration.update()`. When the worker in charge reports a different build than the page, the page reloads, unless a text field is focused or a sheet or alert is open; then a banner says "Updated — tap to reload" and the reload happens on tap or on the next idle return. A first install, or a launch that already loaded the new build, does nothing.
- **Navigation**: in-app state stack, with no URL routes. GitHub Pages has no rewrites. Query params are used only for `?join=`, plus `?now=` in dev.
- **Firebase config**: `src/firebase/config.ts`. Until the real web config is pasted in, the app shows a "Not configured yet" screen. With `VITE_EMULATORS=1` it connects to the local emulators (auth 9099, firestore 8080, project `demo-stakes`).
- **Push**: Web Push (VAPID) works on iOS 16.4+ only when the app is installed to the Home Screen.
  - The client subscribes using `public/config.vapidPublicKey` and stores the subscription under `users/{uid}/push`.
  - `.github/workflows/reminders.yml` runs hourly at :17 and on manual dispatch. It runs `node scripts/reminders.ts` with the `FIREBASE_SERVICE_ACCOUNT` secret and exits 0 when the secret is missing.
  - The job creates the VAPID keys in `_private/vapid` if missing and mirrors the public key to `public/config`.
  - It sends each reminder at most once, tracked by docs under `_private/sent/log/{key}`. Copy gives time left relative to now ("locks in 6 hours", "Due in 15 hours"), so it is right in every member's timezone. Once a week doc exists, its stored bounds decide (no "due in" after the stored deadline).
    - Monday 18:00+ local, until the stored lock: you have no tasks for this week and the list locks in N hours. "Nothing planned = 0%" only for members already in the week doc.
    - Friday 09:00+ local: review your friends (only those still counted for the week), due in N hours.
    - Friday 20:00+ local: N hours left, or −5 points per friend.
    - Saturday 09:00+ local: results are in (once the week is revealed).
    - On the 1st of the month at 10:00+ local: last month's verdict, quoting that month's frozen stakes; nothing for a member with nobody else in that month.
  - Expired subscriptions (404/410) are deleted. Only the 5 newest subscriptions per user on an allowed push host are used.
  - Hardening: each push send times out after 10 s (a failed delivery, retried next run), each space has a 60 s budget (then it is left for the next run), and a space whose timezone the runtime doesn't support is skipped and logged. None of these fail the run; only an unexpected error in a space does.
  - It backfills `utcOffsetMin` (from the space's own zone) on spaces created before it existed.
- **Installing on iOS**: Safari and Home Screen apps have separate storage, so a friend may have to sign in twice and re-enter an invite code. The UI must make the invite code easy to type, as well as offering the link. When the app runs in a Safari tab on iOS, show a dismissible "Add to Home Screen" guide; reminders only work after installing.

## 5. Design language
"As Apple as possible."
- **Type**: the system font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui`), large titles 34/41 bold, body 17/22.
- **Colors**: iOS semantic colors with light/dark variants (systemGroupedBackground, secondarySystemGroupedBackground, label, secondaryLabel, separator, systemGray 1–6), inset-grouped lists, and iOS 26 bars: floating glass buttons over a soft scroll edge (content under the bar blurs and fades into the page color; no opaque bar, no hairline). The accent is graphite gray, not blue.
- **Motion**: spring physics, iOS push/pop with parallax, sheets with a grabber, press-down scale on tappables. Respect `prefers-reduced-motion` and `prefers-reduced-transparency`.
- **Iridescence**: a pastel prism (peach, rose, lilac, periwinkle, sky, a hint of gold; never green or olive), as a Siri-style edge glow and specular sheen, used **sparingly**: completing a task (brief shimmer), the Friday reveal, the month verdict, and the ≥90% score ring. Never as a constant background.
- **Layout**: safe-area insets, `viewport-fit=cover`, 44pt minimum hit targets, light + dark mode. While the on-screen keyboard is up, the app shell ends at its top (bars stay on screen, the focused field is scrolled into view). No motion-permission prompts: the glass highlight is static on touch devices.
