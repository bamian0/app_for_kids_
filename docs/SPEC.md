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
- **timezone** is set to the creator's IANA zone at creation. Every deadline in the space uses this zone.
- Friends join by invite code (8 characters, alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, shown as `XXXX-XXXX`) or by an invite link `<app-url>?join=XXXXXXXX`.

### Week timeline (space timezone)
A week is identified by the date of its Monday: `WeekId = 'YYYY-MM-DD'`. All boundaries are exclusive instants:

| Instant | Meaning |
|---|---|
| `startAt` | Monday 00:00 |
| `lockAt` | Tuesday 00:00, so "locks Monday at midnight". The task list can be edited any time before this, including the week before. |
| `reviewOpenAt` | Friday 00:00. The review window opens. |
| `deadlineAt` | Saturday 00:00, so "reviews due Friday at midnight". |

Phases: `planning` (now < lockAt) → `active` (lockAt ≤ now < reviewOpenAt) → `review` (reviewOpenAt ≤ now < deadlineAt) → `closed`.

The UI shows **this week** and **next week**. Planning next week is allowed at any time.

### Participation
- A week's `members` are the space members who opened the week before `lockAt`. Joining is automatic when the client loads or creates the week doc.
- Someone who joins a space after a week's `lockAt` starts with the next week.
- A participant with **zero tasks** at lock scores **0%** that week ("you committed to nothing").

### During the week
- Each participant can tick their own tasks as done ("self check-offs") until `deadlineAt`. Everyone in the space can see them.

### Friday review
- Every participant reviews every other participant who has ≥1 task.
- Each task gets a mark: **Done = 1**, **Half = 0.5**, **Not done = 0**.
- Reviews are written once, on **Submit**, with all reviewees in a single batch. They are **final**: no edits after submitting.
- Reviews can only be created inside the review window.
- **Blind**: you can't see reviews written by others, about you or anyone else, until they are revealed. Reveal happens when every week member has submitted (`submittedBy ⊇ members`) or at `deadlineAt`, whichever comes first. You can always see your own submitted reviews.

### Weekly score (per participant M with n tasks)
- If n = 0, the score is 0.
- If at least one other participant submitted a review of M, each task's mark is the average of the submitted reviewers' marks for that task. A missing mark for a task counts as 0.
- If nobody reviewed M (all reviewers missed the deadline, or M is alone in the space), each task's mark is M's self check-off: done = 1, else 0.
- `score = 100 × Σ marks / n`, a number from 0 to 100.
- Before reveal, the UI may show a **provisional** score computed from self check-offs, clearly labelled.

### Missed reviews
After `deadlineAt`, a participant R **missed** a review of M if M had ≥1 task and no review R→M exists. Each miss costs R `latePenalty` (5) points off their own monthly score. M is not punished; M's tasks fall back to M's self check-offs only if *no one* reviewed M.

### Monthly score
- A week belongs to the month of its **Friday**: `MonthId = 'YYYY-MM'` of `reviewOpenAt` in the space timezone.
- A member's month average is the mean of their scores in **closed** weeks of that month in which they participated.
- `finalScore = max(0, average − latePenalty × missedReviewsInMonth)`. If there is no closed participating week, it is `null`.
- A month is **complete** when `now ≥ deadlineAt` of its last week. Until then the UI shows the score so far.
- When complete: `finalScore ≥ threshold` means the other members owe M the reward. Otherwise M owes the other members the penalty.
- Settlements are honor-system toggles ("Settled") stored per month per member. **No money moves through the app.**

## 2. Firestore data model

Timestamps are Firestore `Timestamp` in storage and epoch milliseconds (`number`) in TypeScript domain types. The data layer converts between them.

```
users/{uid}                                  { name, color, createdAt }
users/{uid}/push/{subId}                     { endpoint, keys: { p256dh, auth }, createdAt, ua }
invites/{code}                               { spaceId, spaceName, inviterName, createdBy, createdAt }
spaces/{spaceId}                             { name, reward, penalty, ownerId, memberIds[], joinedAt{uid: ts},
                                               timezone, inviteCode, threshold: 90, latePenalty: 5, createdAt }
spaces/{spaceId}/joins/{uid}                 { code, createdAt }            # proof of invite, written in the join batch
spaces/{spaceId}/weeks/{weekId}              { startAt, lockAt, reviewOpenAt, deadlineAt, members[], submittedBy[] }
spaces/{spaceId}/weeks/{weekId}/plans/{uid}     { tasks: [{ id, title }], updatedAt }
spaces/{spaceId}/weeks/{weekId}/progress/{uid}  { done: { [taskId]: boolean }, updatedAt }
spaces/{spaceId}/weeks/{weekId}/reviews/{reviewerId}_{revieweeId}
                                             { reviewerId, revieweeId, marks: { [taskId]: 0|0.5|1 }, submittedAt }
spaces/{spaceId}/settlements/{monthId}_{uid} { monthId, uid, settled, settledBy, settledAt }
public/config                                { vapidPublicKey }              # written by the reminders job (admin)
_private/*                                   admin only (VAPID private key, sent-notification log)
```

Limits: space name 1–40 chars; reward/penalty 1–120 chars; user name 1–40 chars; ≤25 tasks per plan; task title 1–120 chars; ≤8 members per space.

### Security rules (`firestore.rules`), what must hold
- `users/{uid}`: any signed-in user can read. Only the owner can write, with field validation.
- `users/{uid}/push/*`: only the owner can read and write.
- `invites/{code}`: any signed-in user can `get`; `list` is denied. Only a member of `spaceId` can create, with `createdBy == auth.uid`. The creator or any space member can delete.
- `spaces/{id}`: only members can read. Create requires `ownerId == auth.uid`, `memberIds == [auth.uid]`, `joinedAt == {auth.uid: request.time}`, threshold 90, latePenalty 5, and validated fields. Allowed updates:
  - a member edits `name`/`reward`/`penalty`
  - a member leaves: removes self from `memberIds` and `joinedAt`
  - a non-member joins: only `memberIds` (appending self) and `joinedAt` (adding self = request.time) change, `getAfter(spaces/{id}/joins/{auth.uid}).data.code` names an invite whose `spaceId == id`, and the member count stays ≤ 8.
- `spaces/{id}/joins/{uid}`: create only by `uid == auth.uid`, and only if `invites/{code}.spaceId == id`. Read by self.
- `weeks/{weekId}`: members can read. A member can create it when:
  - `weekId` is a Monday date;
  - the four timestamps are consistent: `startAt` within ±14h of `weekId` 00:00 UTC; `lockAt = startAt + 1 day`, `reviewOpenAt = startAt + 4 days`, `deadlineAt = startAt + 5 days`, each ±2h for DST;
  - `submittedBy == []`;
  - `members == [auth.uid]` if `request.time < lockAt`, otherwise `[]`;
  - `request.time < startAt + 8 days`, and `startAt < request.time + 8 days` (no far-future weeks).

  Allowed updates, and nothing else:
  - add self to `members` while `request.time < lockAt` and self is a space member;
  - add self to `submittedBy` while `reviewOpenAt ≤ request.time < deadlineAt` and self ∈ `members`.
- `plans/{uid}`: members of the space can read. The owner can write while `request.time < lockAt` and owner ∈ `week.members`; `tasks` must be a list of ≤ 25 items.
- `progress/{uid}`: members can read. The owner can write while `request.time < deadlineAt` and owner ∈ `week.members`.
- `reviews/{rid}`:
  - create only, no update or delete;
  - `rid == reviewerId + '_' + revieweeId`; `reviewerId == auth.uid`; reviewer and reviewee ∈ `week.members` and differ;
  - `reviewOpenAt ≤ request.time < deadlineAt`;
  - reviewer ∉ `get(week).submittedBy` (pre-batch state);
  - `submittedAt == request.time`.

  Read: the reviewer, or a space member when revealed (`request.time ≥ deadlineAt || week.submittedBy.hasAll(week.members)`).

  Clients must query in ways the rules can prove. Before reveal: `where('reviewerId','==',uid)`. After reveal: the whole collection.
- `settlements/*`: members can read and write, with field validation.
- `public/config`: signed-in users can read; nobody can write. `_private/**`: no client access.

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
| `public/sw.js`, `public/manifest.webmanifest`, `public/icons/**`, `src/push/**`, `scripts/**`, `.github/workflows/**` | platform | PWA, push, reminders job, deploy |
| `tests/e2e/**`, `playwright.config.ts` | integration | Emulator-backed end-to-end + screenshots |

## 4. Platform
- **Hosting**: GitHub Pages from the `gh-pages` branch. `.github/workflows/deploy.yml` builds on push to `main` or `claude/**` and publishes `dist/`, including a `.nojekyll` file. The Vite base is `./`.
- **Navigation**: in-app state stack, with no URL routes. GitHub Pages has no rewrites. Query params are used only for `?join=`, plus `?now=` in dev.
- **Firebase config**: `src/firebase/config.ts`. Until the real web config is pasted in, the app shows a "Not configured yet" screen. With `VITE_EMULATORS=1` it connects to the local emulators (auth 9099, firestore 8080, project `demo-stakes`).
- **Push**: Web Push (VAPID) works on iOS 16.4+ only when the app is installed to the Home Screen.
  - The client subscribes using `public/config.vapidPublicKey` and stores the subscription under `users/{uid}/push`.
  - `.github/workflows/reminders.yml` runs hourly at :17 and on manual dispatch. It runs `node scripts/reminders.ts` with the `FIREBASE_SERVICE_ACCOUNT` secret and exits 0 when the secret is missing.
  - The job creates the VAPID keys in `_private/vapid` if missing and mirrors the public key to `public/config`.
  - It sends each reminder at most once, tracked by docs under `_private/sent/log/{key}`:
    - Monday 18:00+ local: you have no tasks for this week and the list locks at midnight.
    - Friday 09:00+ local: review your friends.
    - Friday 20:00+ local: 4 hours left, or −5 points.
    - Saturday 09:00+ local: results are in.
    - On the 1st of the month at 10:00+ local: last month's verdict.
  - Expired subscriptions (404/410) are deleted.
- **Installing on iOS**: Safari and Home Screen apps have separate storage, so a friend may have to sign in twice and re-enter an invite code. The UI must make the invite code easy to type, as well as offering the link. When the app runs in a Safari tab on iOS, show a dismissible "Add to Home Screen" guide; reminders only work after installing.

## 5. Design language
"As Apple as possible."
- **Type**: the system font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui`), large titles 34/41 bold, body 17/22.
- **Colors**: iOS semantic colors with light/dark variants (systemGroupedBackground, secondarySystemGroupedBackground, label, secondaryLabel, separator, systemGray 1–6), inset-grouped lists, frosted bars (`backdrop-filter: saturate(180%) blur(20px)`). The accent is graphite gray, not blue.
- **Motion**: spring physics, iOS push/pop with parallax, sheets with a grabber, press-down scale on tappables. Respect `prefers-reduced-motion` and `prefers-reduced-transparency`.
- **Iridescence**: a Siri-style rainbow edge glow and specular sheen, used **sparingly**: completing a task (brief shimmer), the Friday reveal, the month verdict, and the ≥90% score ring. Never as a constant background.
- **Layout**: safe-area insets, `viewport-fit=cover`, 44pt minimum hit targets, light + dark mode.
