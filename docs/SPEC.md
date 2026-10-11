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
- Leaving or being removed must record `leftAt[uid]` (the rules refuse a leave or removal without it). Weeks that had locked by then keep the leaver; see Participation.
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

The rules keep the stored timeline honest: `startAt` must be within 1h of Monday 00:00 UTC − `utcOffsetMin` (the anchor; the hour covers DST and a space created in the other season), and every later bound within 1h of whole days after `startAt` and within 1h of the same whole days after the anchor, so the two hours of slack can't add up. Spaces created before `utcOffsetMin` existed fall back to "within 14h of Monday 00:00 UTC" until the reminders job backfills their offset (it also corrects an offset more than 1h off the zone's). If the stored bounds still differ from the zone's by more than an hour, `WeekData.boundsMismatch` is true and the screens should say so; the stored times still rule.

The UI shows **this week** and **next week**. Planning next week is allowed at any time.

### Participation
- Everyone who is a space member before a week's `lockAt` takes part in it, whether or not they open it. Whenever any member opens the app (the spaces list, a space or a week), the client makes sure this week (until it locks) and next week exist and hold every current member. A week nobody opens before `lockAt` has no doc and no participants.
- Someone who joins a space after a week's `lockAt` starts with the next week (`space.joinedAt[uid] ≥ lockAt`; `joinedAfterLock()` in the domain tells this apart from a member who simply has no tasks).
- A participant with **zero tasks** at lock scores **0%** that week ("you committed to nothing").
- **The lock is a commitment.** "Your list locks Monday at midnight; from then on that week counts, even if you leave."
  - Leaving the space, deleting your account or being removed by the owner *before* a week's `lockAt` takes you out of that week: this week while it is still planning, and next week.
  - From `lockAt` on it doesn't: you stay in `week.members`. Your friends still review you (and lose points if they don't), your score counts toward that month (in the month's results you are `former` and still owe or are owed), you are charged for the reviews you no longer can write, and the reveal still waits for you. Since you can't submit any more, that means the deadline, unless you had already submitted before leaving. Leaving never reveals a week early, never hides a bad week, and never removes you from anyone's list.
  - Who counts for a week is `membersAt(space, lockAt)`: the current members plus anyone with `leftAt ≥ lockAt`, except a current member who left before `lockAt` and rejoined after it (rejoining never rewrites a locked week). A member who never left counts whatever their `joinedAt` says.

### During the week
- Each participant can tick their own tasks as done ("self check-offs") until `deadlineAt`. Everyone in the space can see them. A task with steps (§6.1) is ticked step by step.
- After the lock and before the review window opens (`lockAt ≤ now < reviewOpenAt`), a participant can **add** tasks to their list, one at a time (§6.2). Added tasks count like the rest and are reviewed on Friday. They can't be edited or removed, and everyone sees when they were added. Nothing already on the list can change after the lock.

### Friday review
- Every participant reviews every other participant who has ≥1 task.
- Each task gets a mark: **Done = 1**, **Half = 0.5**, **Not done = 0**.
- Reviews are written once, on **Submit**, with all reviewees in a single batch. They are **final**: no edits after submitting.
- Reviews can only be created inside the review window.
- Only current space members can submit.
- **Blind**: you can't see reviews written by others, about you or anyone else, until they are revealed. Reveal happens when every week member has submitted (`submittedBy ⊇ members`) or at `deadlineAt`, whichever comes first. A member who left after lock is still a week member, so the reveal waits for them; as they can't submit any more, the deadline reveals the week (see Participation). You can always see your own submitted reviews. The data layer never publishes a revealed week with only your own reviews: it holds the previous state until everyone's have loaded.

### Weekly score (per participant M with n tasks)
- If n = 0, the score is 0.
- If at least one other participant submitted a review of M, each task's mark is the average of the submitted reviewers' marks for that task. A missing mark for a task counts as 0.
- If nobody reviewed M (all reviewers missed the deadline, or M is alone in the space), each task's mark is M's self check-off: done = 1, else 0. For a task with steps it is the share of steps ticked (2 of 4 = 0.5).
- `score = 100 × Σ marks / n`, a number from 0 to 100.
- Before reveal, the UI may show a **provisional** score computed from self check-offs, clearly labelled.

### Missed reviews
After `deadlineAt`, a participant R **missed** a review of M if M had ≥1 task, M still counts for that week (see Participation) and no review R→M exists. Each miss costs R `latePenalty` (5) points off their own monthly score. M is not punished; M's tasks fall back to M's self check-offs only if *no one* reviewed M.

### Monthly score
- A week belongs to the month of its **Friday**: `MonthId = 'YYYY-MM'` of `reviewOpenAt` in the space timezone.
- A member's month average is the mean of their scores in **closed** weeks of that month in which they participated.
- `finalScore = max(0, average − latePenalty × missedReviewsInMonth)`. If there is no closed participating week, it is `null`. `average` and `finalScore` are rounded to 1e-9, so a month that averages exactly 90 reads as exactly 90 everywhere.
- The month's roster is everyone who took part in one of its weeks plus the current members; someone who has left since is marked `former`, keeps their real scores for the weeks that had locked before they left, and still owes or is owed for it. Each result lists its `others`: everyone else who took part that month. Members who joined later aren't in anyone's `others`.
- A month is **complete** when `now ≥ deadlineAt` of its last week. Until then the UI shows the score so far.
- When complete: `finalScore ≥ threshold` means the month's `others` owe M the reward. Otherwise M owes them the penalty. The reward and penalty are the month's frozen stakes (see Spaces). With no `others`, nothing is owed.
- Settlements are honor-system toggles ("Settled") stored per month per member, current or former. **No money moves through the app.**

## 2. Firestore data model

Timestamps are Firestore `Timestamp` in storage and epoch milliseconds (`number`) in TypeScript domain types. The data layer converts between them.

```
users/{uid}                                  { name, color, createdAt }
users/{uid}/push/{subId}                     { endpoint, keys: { p256dh, auth }, createdAt, ua }
users/{uid}/money/state                      { currency, baseline: number|null, baselineAt: ts|null, updatedAt }   # private (§6.3)
users/{uid}/earnings/{spaceId}_{weekId}_{taskId}  { spaceId, weekId, taskId, title, amount, earnedAt: ts|null, updatedAt }  # private
users/{uid}/moves/{moveId}                   { kind: 'add'|'spend', amount, note, at }                              # private
users/{uid}/goals/{goalId}                   { name, cost, order, createdAt }                                       # private
invites/{code}                               { spaceId, spaceName, reward, penalty, inviterName, createdBy, createdAt }
spaces/{spaceId}                             { name, reward, penalty, ownerId, memberIds[], joinedAt{uid: ts}, leftAt?{uid: ts},
                                               timezone, utcOffsetMin, inviteCode, threshold: 90, latePenalty: 5, createdAt }
spaces/{spaceId}/joins/{uid}                 { code, createdAt }            # proof of invite, written in the join batch
spaces/{spaceId}/weeks/{weekId}              { startAt, lockAt, reviewOpenAt, deadlineAt, members[], submittedBy[] }
spaces/{spaceId}/weeks/{weekId}/plans/{uid}     { tasks: [{ id, title, subs?: ["<subId>|<title>", …] }], added?: { [taskId]: ts }, updatedAt }
spaces/{spaceId}/weeks/{weekId}/progress/{uid}  { done: { [taskId]: boolean }, updatedAt }
spaces/{spaceId}/weeks/{weekId}/reviews/{reviewerId}_{revieweeId}
                                             { reviewerId, revieweeId, marks: { [taskId]: 0|0.5|1 }, submittedAt }
spaces/{spaceId}/months/{monthId}            { reward, penalty, createdAt }  # the month's frozen stakes
spaces/{spaceId}/settlements/{monthId}_{uid} { monthId, uid, settled, settledBy, settledAt }
public/config                                { vapidPublicKey }              # written by the reminders job (admin)
_private/*                                   admin only (VAPID private key, sent-notification log)
```

Limits: space name 1–40 chars; reward/penalty 1–120 chars; user name 1–40 chars; ≤25 tasks per plan; task title 1–120 chars; ≤8 steps per task, step title 1–120 chars on one line; task ids `[A-Za-z0-9_-]{1,64}` (also as review mark keys and check-off keys); ≤8 members per space; profile color `#RRGGBB`.

### Security rules (`firestore.rules`), what must hold
- `users/{uid}`: any signed-in user can `get` a profile; `list` is denied, so nobody can enumerate users. Only the owner can write, with field validation; `color` must be `#RRGGBB` (it lands in CSS).
- `users/{uid}/push/*`: only the owner can read and write. `endpoint` must be on a real push service: `web.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com` or `*.notify.windows.com`. The number of subscriptions is not capped by the rules; the reminders job only uses each user's 5 newest.
- `users/{uid}/money/state`, `earnings/*`, `moves/*`, `goals/*` (§6.3): only the owner can read and write. The profile's `get` doesn't reach them (rules don't cascade) and there is no collection-group access. Exact keys and types:
  - `money/state` (no other id): `currency` matches `^[A-Z]{3}$`; `baseline` null or a number within ±1e9; `baselineAt` null or a timestamp, and `request.time` whenever the baseline changes (otherwise unchanged); `updatedAt == request.time`.
  - `earnings/{eid}`: `eid == spaceId + '_' + weekId + '_' + taskId`, `spaceId` 1–128 characters, `weekId` matches `^\d{4}-\d{2}-\d{2}$`, `taskId` like a task id, `title` 1–120 characters, `amount` 0…1e9, `earnedAt` null, `request.time` or (on update) unchanged, `updatedAt == request.time`.
  - `moves/*`: create and delete only. `kind` is `add` or `spend`, `amount` > 0 and ≤ 1e9, `note` 0–80 characters, `at == request.time`.
  - `goals/*`: `name` 1–60 characters and not blank, `cost` > 0 and ≤ 1e9, `order` within ±1e6, `createdAt == request.time` on create and unchanged after.
- `invites/{code}`: anyone, signed in or not, can `get` (the code is the secret); `list` is denied. Only a member of `spaceId` can create, with `createdBy == auth.uid`, only under the space's own `inviteCode`, and with `spaceName`, `reward` and `penalty` equal to the space's (checked with `getAfter`, so the space and its invite can be written in one batch). A member can update `spaceName`/`reward`/`penalty` alone, and only to mirror the space. The creator or any space member can delete.
- `spaces/{id}`: only members can read. Create requires `ownerId == auth.uid`, `memberIds == [auth.uid]`, `joinedAt == {auth.uid: request.time}`, `utcOffsetMin` an int in −720…840, threshold 90, latePenalty 5, and validated fields. Allowed updates, and nothing else (timezone, utcOffsetMin, threshold, latePenalty and createdAt never change):
  - a member edits `name`/`reward`/`penalty`;
  - a member leaves: removes self from `memberIds` and `joinedAt` and sets `leftAt[self] = request.time` (required; nothing else in `leftAt` changes); if the leaver is the owner and others remain, `ownerId` must become a remaining member with the earliest `joinedAt`, otherwise `ownerId` stays;
  - the owner removes one other member the same way (`memberIds`, `joinedAt`, and the required `leftAt[them] = request.time`);
  - the owner sets a new, valid `inviteCode` (alone);
  - in a space whose `ownerId` is no longer a member, a member sets `ownerId` (alone) to the earliest-joined member;
  - a non-member joins: only `memberIds` (appending self) and `joinedAt` (adding self = request.time) change, `getAfter(spaces/{id}/joins/{auth.uid}).data.code` is the space's current `inviteCode` and names an invite whose `spaceId == id`, and the member count stays ≤ 8.
- `spaces/{id}/joins/{uid}`: create only by `uid == auth.uid`, and only if `invites/{code}.spaceId == id`. Read by self.
- `weeks/{weekId}`: members can read. A member can create it when:
  - `weekId` is a Monday date;
  - the timeline is anchored to the space: `startAt` within 1h of `weekId` 00:00 UTC − `utcOffsetMin` (within 14h of `weekId` 00:00 UTC for a space without `utcOffsetMin`); `lockAt`, `reviewOpenAt`, `deadlineAt` within 1h of `startAt` + 1, 4, 5 days and, with `utcOffsetMin`, also within 1h of that anchor + 1, 4, 5 days;
  - `submittedBy == []`;
  - `members` holds exactly the space's current members;
  - `request.time < lockAt`, and `startAt < request.time + 8 days` (no far-future weeks).

  Allowed updates, and nothing else:
  - before `lockAt`, a space member appends current space members who are missing from `members` (no duplicates);
  - before `lockAt`, one uid leaves `members` if it is no longer a space member (`getAfter`, so it goes in the same batch as leaving the space); the writer is that uid or the space's owner. From `lockAt` on nobody leaves `members`, so leaving or removal can't take anyone out of a locked week;
  - add self to `submittedBy` while `reviewOpenAt ≤ request.time < deadlineAt`, self ∈ `members` and self is still a space member.
- `plans/{uid}`: members of the space can read. Only the owner writes, while owner ∈ `week.members` and still a space member:
  - before `lockAt`: exactly `{tasks, updatedAt}` (no `added`), `updatedAt == request.time`; `tasks` is a list of ≤ 25 tasks, each exactly `{id, title}` or `{id, title, subs}`: `id` like a task id, `title` 1–120 characters, `subs` 1–8 strings `"<id>|<title>"` (step id like a task id, step title 1–120 characters on one line). Deleting the plan is allowed only before `lockAt`;
  - while `lockAt ≤ request.time < reviewOpenAt`, append only (§6.2): exactly `{tasks, added, updatedAt}`; `tasks` is the stored list unchanged (same order, same content) plus one valid task, ≤ 25 in all (with no plan yet: just that task); `added` gains exactly that task's id, not already in it, with `request.time` and keeps every other entry; `updatedAt == request.time`.

  A plan of 25 tasks with 8 steps each fits the 1000-expression limit (about 890, measured in the emulator); the task check is written for cost (see the comments in `firestore.rules`).
- `progress/{uid}`: members can read. The owner can write while `request.time < deadlineAt` and owner ∈ `week.members`; `done` has ≤ 200 boolean entries and each write adds at most one key, shaped like a task id.
- `reviews/{rid}`:
  - create only, no update or delete;
  - `rid == reviewerId + '_' + revieweeId`; `reviewerId == auth.uid`; reviewer and reviewee ∈ `week.members` and differ;
  - `marks` has ≤ 25 keys shaped like task ids, values 0 / 0.5 / 1;
  - `reviewOpenAt ≤ request.time < deadlineAt`;
  - reviewer ∉ `get(week).submittedBy` (pre-batch state) and ∈ `getAfter(week).submittedBy` (so it is the submit batch, which also requires the reviewer to still be a member);
  - `submittedAt == request.time`.

  Read: the reviewer, or a space member when revealed (`request.time ≥ deadlineAt || week.submittedBy ⊇ week.members`).

  Clients must query in ways the rules can prove. Before reveal: `where('reviewerId','==',uid)`. After reveal: the whole collection.
- `months/{monthId}`: members can read. A member can create it (never update or delete) with exactly `{reward, penalty, createdAt}`, `reward`/`penalty` equal to the space's current ones, `createdAt == request.time`, and `monthId` between the month of `request.time − 3 days` and the month of `request.time + 5 days` (the month of the current week's Friday in any zone).
- `settlements/*`: members can read and write, with field validation; `uid` is a current member or one in `leftAt`.
- `public/config`: signed-in users can read; nobody can write. `_private/**`: no client access.

### Data layer (`src/data/api.ts`), behaviour the screens rely on
- `createSpace` writes the space and its invite in one batch. It first checks the server answers (8 s); offline it fails at once with the offline message instead of queueing, and a second identical call while the first is in flight returns the first.
- `lookupInvite` works signed out; `Invite` carries `reward` and `penalty` (empty on invites from before). `updateSpace` keeps the invite's name and stakes in step.
- `leaveSpace`, `deleteMyAccount` and `removeMember` take the user out of the weeks that haven't locked yet (this week while it is planning, next week) and never out of a locked week (see Participation). They record `leftAt`, and leaving hands ownership on. `removeMember(spaceId, uid)` and `resetInviteCode(spaceId) → new code` are owner-only.
- `useMySpaces`, `useSpace` and `useWeek` run `ensureSpace`: this week (until it locks) and next week hold every current member, the current month's stakes are frozen once its first lists have locked, and a space whose owner already left (older versions) passes to its earliest-joined member.
- `useMonthStakes(space, monthId)` gives `{ reward, penalty, frozen }`, falling back to the space's text with `frozen: false`.
- `useWeek(...).data.boundsMismatch` flags a skewed stored timeline. A revealed week is never published with only the user's own reviews.
- After joining or leaving, the cached space, weeks, months and settlements of that space are dropped (`forget`), so nothing stale lingers.
- `sendPasswordReset` resolves for unknown emails too (no account enumeration).

Known limits:
- The rules don't cap how many spaces an account creates, or how many earnings, moves and goals it stores.
- Steps are checked with one regex over the joined list, which can't count lines within the expression budget: a step whose title hides a newline followed by more step-like text (`"a|x\nb|y"` as one step) passes. Step ids are still always valid; only the writer's own step title is affected.
- The rules don't check that task ids are unique within a plan (the data layer makes new ones with `newTaskId()`). A duplicate only confuses the writer's own list.
- A determined member can still write a week with a skew of up to an hour, up to 2h on a space created in the other DST season (its stored offset is an hour off), or up to 14h on a space the reminders job hasn't backfilled yet. The client flags it (`boundsMismatch`).
- A retired invite code (reset, or the last member left) can be claimed by another space: anyone who knows it can create a space with that `inviteCode` and its invite, and the old link then previews and joins that space instead. Low severity: it needs the old code, and the preview shows the new space's name and inviter.

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
    - Friday 09:00+ local: review your friends, due in N hours. Only current members are reminded, but the friends to rate are everyone counted for the week (`membersAt(space, lockAt)`), including anyone who left after lock (named "a former member" once their profile is gone).
    - Friday 20:00+ local: N hours left, or −5 points per friend.
    - Saturday 09:00+ local: results are in (once the week is revealed).
    - On the 1st of the month at 10:00+ local: last month's verdict, quoting that month's frozen stakes; nothing for a member with nobody else in that month.
  - Expired subscriptions (404/410) are deleted. Only the 5 newest subscriptions per user on an allowed push host are used.
  - Hardening: each push send times out after 10 s (a failed delivery, retried next run), each space has a 60 s budget (then it is left for the next run), and a space whose timezone the runtime doesn't support is skipped and logged. None of these fail the run; only an unexpected error in a space does.
  - It backfills `utcOffsetMin` (from the space's own zone) on spaces created before it existed, and corrects one that is more than 1h off the zone's current offset (whoever creates a space can write any offset).
- **Installing on iOS**: Safari and Home Screen apps have separate storage, so a friend may have to sign in twice and re-enter an invite code. The UI must make the invite code easy to type, as well as offering the link. When the app runs in a Safari tab on iOS, show a dismissible "Add to Home Screen" guide; reminders only work after installing.

## 5. Design language
"As Apple as possible."
- **Type**: the system font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui`), large titles 34/41 bold, body 17/22.
- **Colors**: iOS semantic colors with light/dark variants (systemGroupedBackground, secondarySystemGroupedBackground, label, secondaryLabel, separator, systemGray 1–6), inset-grouped lists, and iOS 26 bars: floating glass buttons over a soft scroll edge (content under the bar blurs and fades into the page color; no opaque bar, no hairline). The accent is graphite gray, not blue.
- **Motion**: spring physics, iOS push/pop with parallax, sheets with a grabber, press-down scale on tappables. Respect `prefers-reduced-motion` and `prefers-reduced-transparency`.
- **Iridescence**: a pastel prism (peach, rose, lilac, periwinkle, sky, a hint of gold; never green or olive), as a Siri-style edge glow and specular sheen, used **sparingly**: completing a task (brief shimmer), the Friday reveal, the month verdict, and the ≥90% score ring. Never as a constant background.
- **Layout**: safe-area insets, `viewport-fit=cover`, 44pt minimum hit targets, light + dark mode. While the on-screen keyboard is up, the app shell ends at its top (bars stay on screen, the focused field is scrolled into view). No motion-permission prompts: the glass highlight is static on touch devices.

## 6. Tasks with steps, tasks added mid-week, money, Overview and Goals

This section is the contract for the second feature round. Where it and the sections above disagree, this one wins.

### 6.1 Tasks with steps (subtasks)
- A task can have up to **8 steps** (`Task.subtasks`, each `{ id, title }`; ids like task ids, from `newTaskId()`). Steps are planned with the task and follow its rules: editable until the lock (the whole task), frozen after it.
- **Check-offs**: each step is ticked on its own (`progress.done[subId]`, one key per write as before). A task with steps has no checkbox of its own: it shows how many steps are done (e.g. a small ring and "2/4") and counts as done once every step is ticked. `progress.done[task.id]` is ignored for a task with steps.
- **Scoring**: reviewers mark the task, not its steps (Done / Half / Not done); they see the steps and which were ticked, as evidence. In the self check-off fallback and the provisional score, a task with steps counts the share of steps ticked (`selfFraction`).
- **Storage**: a task is stored as `{ id, title }` or `{ id, title, subs }` with `subs` a non-empty list of strings `"<subId>|<title>"` (split on the first `|`; titles have no newlines). The data layer converts to and from `Task.subtasks`; `subs` is omitted when there are no steps.
- **Caps**: 25 tasks × 8 steps = 200 check-off keys, the existing cap of a progress doc. The UI stops at 8 steps per task.

### 6.2 Tasks added after the lock
- While `lockAt ≤ now < reviewOpenAt`, a participant who is still a space member can append **one task per write** (with its steps) to their plan, up to 25 in all. "Thursday at midnight" is the last moment: on Friday everyone reviews the same list.
- The appended task's add time is the server time of the write, stored in the plan's `added` map (`added[taskId] = request.time`; arrays can't hold server timestamps). The data layer exposes it as `Task.addedAt`.
- Nothing else in the plan changes in that write: the existing tasks are exactly as before (same order, same content), `added` gains exactly that one key, and the plan's `updatedAt` is the server time. A participant with no plan at the lock can create one this way (one task). Added tasks can never be edited or removed.
- Before the lock, plans are written as before (`{ tasks, updatedAt }`, no `added`).
- **Shown to everyone**: an added task carries a small "Added Wed" badge (weekday of `addedAt` in the space timezone) on every list and in the review sheet, so friends can judge padding (e.g. an easy task added Thursday night). The add sheet says plainly that the task becomes part of the week and can't be undone.
- Reviews, reveal and missed reviews are unchanged: someone with no tasks at the lock who adds one becomes a review target like anyone with a task.

### 6.3 Money (private)
Everything here lives under `users/{uid}` and is readable and writable **only by that user**. Friends never see amounts, revenue switches, balances or goals.
- **Currency**: `money/state.currency`, an ISO 4217 code (3 uppercase letters). Until set, the client uses a default from the device locale's region (e.g. en-US → USD, de-DE → EUR, hy-AM → AMD, en-GB → GBP), falling back to USD. All amounts of a user are in that one currency; changing it relabels, it doesn't convert.
- **Revenue tasks**: any of your own tasks (in any week, before or after the lock) can be switched to "Generates revenue" with an amount (≥ 0, 2 decimals, ≤ 1,000,000,000). The switch is the existence of `earnings/{spaceId}_{weekId}_{taskId}`; switching off deletes it. The amount can be changed at any time (plan an estimate, correct it when paid). It is your own bookkeeping, so it is not tied to the lock.
  - `earnedAt` is set (server time) when the task becomes done by your self check-off (a task with steps: its last step), and cleared when it is un-done. The data layer keeps it in step in `setTaskDone` and when the switch is turned on for a task that is already done. Friends' marks don't affect money.
  - The data layer keeps `title` in step when a task is renamed before the lock and deletes the earning when the task is deleted before the lock. Leaving a space keeps your earnings.
- **Moves**: money added (`add`) or spent (`spend`) by hand, with an optional note (≤ 80 chars). A move can be deleted (undo), not edited.
- **Balance** = `baseline` (0 if unset) + Σ moves with `at > baselineAt` (add +, spend −) + Σ earnings with `earnedAt > baselineAt` (`amount`). With no baseline set, every move and earning counts. "Set balance" (I have X now) writes `baseline = X, baselineAt = now`; what was earned or moved before is assumed to be in X. The balance can go negative (shown in red).
- **Goals**: `{ name, cost, order }`. The balance fills goals in order, top first (a waterfall): goal 1 gets `min(balance, cost₁)`, goal 2 gets what is left, and so on. Each goal shows funded / cost, what is left to go, and an estimate "≈ N weeks at your pace" where pace = net money in over the last 28 days (earnings + adds − spends) ÷ 4, only when pace > 0 and N ≤ 104. A funded goal can be marked **Bought**: one batch adds a `spend` move of its cost (note = goal name) and deletes the goal. Goals can be reordered, edited and deleted.
- **Rules** (`firestore.rules`): owner only (`isUser(uid)`) for read and write on `money/state`, `earnings/*`, `moves/*`, `goals/*`, with exact keys and types: amounts are numbers within 0…1e9 (moves and costs > 0), strings within their limits, `currency` matches `^[A-Z]{3}$`, `updatedAt`/`at`/`createdAt` are `request.time` when written, `earnedAt` is null or `request.time` (or unchanged), the earnings doc id equals `spaceId + '_' + weekId + '_' + taskId`, and `weekId` matches `^\d{4}-\d{2}-\d{2}$`. Moves are create/delete only. `deleteMyAccount` deletes all of it.

### 6.4 Navigation: tab bar
- Signed in, the app is a **tab bar** with three tabs, each its own `NavigationStack` (state kept while switching): **Spaces** (`squareStack`), **Overview** (`chartBar`), **Goals** (`target`). The last tab is remembered on the device. Tapping the selected tab pops its stack to the root.
- iOS 26 look: a floating glass capsule centered above the home indicator, icon over a small label, the selected item on a soft glass pill; it slides away while the keyboard is up and when a screen is pushed on top of a tab's root (like `hidesBottomBarWhenPushed`), so pushed screens keep their own floating toolbars. Sheets cover it. Root screens leave room for it at the bottom.
- A notification or invite link that opens a space switches to the Spaces tab first.

### 6.5 Overview
A root screen, "Overview", across all of your spaces:
- **This week**: one large ring with your tasks done across every space this week (steps count as fractions), "5 of 8 tasks done", then one row per space with its mini score ring (provisional, or the revealed score) and what's next ("Review due Fri", "Locks tonight").
- **Money**: earned this month (large, in your currency) with this week, still pending (revenue tasks not done yet in this week and next week) and all time; a bar chart of earnings in the last 8 weeks (this week highlighted); the top earning tasks of the month. Tapping goes to Goals. With no revenue tasks yet, a short explanation of how to mark a task as revenue.
- **This month**: per space, the month-to-date score against 90 ("On track", or "4 points short").
- Weeks and months are the spaces' own (a week is identified by its Monday; money is grouped by the task's `weekId`, a month by `monthIdForWeek`).

### 6.6 Goals
A root screen, "Goals":
- **Balance** card: the balance, large; under it "+ $X earned from tasks this month"; two clear buttons, **Add Money** and **Remove Money** (a spend, with an optional "What for?" note); a menu with **Set Balance** and **Currency**. With no baseline and nothing recorded yet, the card asks "How much do you have right now?".
- **Goals** list (top first, the order money fills them): name, cost, a progress bar (iridescent sheen once funded), "$1,550 to go · ≈ 6 weeks at your pace" or "Funded". "+" adds a goal (name, cost); tapping a goal edits it (name, cost, move up/down, delete, **Mark as Bought** when funded).
- **Activity**: recent money in and out, newest first: task earnings ("Client work · Film Crew"), adds and spends with their notes, and when the balance was set. Manual moves can be deleted with a swipe.

### 6.7 Task editing UI
- Before the lock, the inline list stays (type, Return, swipe to delete). Each row gets an info button that opens the **task sheet**: title, steps (add, rename, delete; up to 8), and "Generates revenue" with an amount field (currency symbol, decimal keypad). The section also gets a clear **Add Task with Steps** button that opens the same sheet empty. Before the lock the sheet hands the task back to the list editor, which saves it (one writer, so a pending autosave can't drop it).
- After the lock and until Friday 00:00, your list ends with **Add Task**: the same sheet, which appends via `addTaskAfterLock` after saying it can't be undone. Steps show indented under their task with their own check circles until the deadline. Your revenue tasks show their amount (only to you); tapping a locked task opens the sheet read-only except for the revenue switch and amount.
- Friends' lists and the review sheet show steps (with which are ticked) and the "Added Wed" badge.
