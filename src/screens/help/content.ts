// What Help and the intro say, kept as data: the numbers come from one place, and the unit tests hold
// the copy to the rules of the game (docs/SPEC.md §1, §6 and §9.12). Days and times come from the space's
// own schedule, so the usual times read exactly as before. Pure, so Node can test it.
import { MAX_SUBTASKS } from '../../domain/ids.ts'
import { isUsualSchedule, momentDay, momentText, splitMoment, timeLabel } from '../../domain/schedule.ts'
import type { HourCycle } from '../../domain/schedule.ts'
import { DEFAULT_SCHEDULE } from '../../domain/time.ts'
import type { WeekSchedule } from '../../domain/types.ts'
import type { IconName } from '../../ui/icons.tsx'

/** The numbers the copy quotes, and the week's times (a space's own, else the usual ones). */
export interface HelpRules {
  /** Percent a month must reach. */
  threshold: number
  /** Points off the month per friend you don't review. */
  latePenalty: number
  /** People in a space, you included. */
  maxMembers: number
  maxSteps: number
  /** When lists lock and reviews open and close. Absent: the usual times. */
  schedule?: WeekSchedule
  /** How times read: "6:00 PM" (h12, the default) or "18:00". */
  hourCycle?: HourCycle
}

export const RULES: HelpRules = { threshold: 90, latePenalty: 5, maxMembers: 8, maxSteps: MAX_SUBTASKS, schedule: DEFAULT_SCHEDULE }

const DAY_MINUTES = 1440
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const

/** Review day: the weekday the review window opens on ("Friday" for the usual times, whose window opens as
 *  Thursday ends), as the review sheet's title says it. */
export function reviewDayOf(schedule: WeekSchedule = DEFAULT_SCHEDULE): string {
  return DAY_NAMES[Math.min(6, Math.floor(schedule.reviewOpen / DAY_MINUTES))]
}

/** A moment at the end of its day ("midnight"), as opposed to a time within it. */
function isMidnight(m: number): boolean {
  return m % DAY_MINUTES === 0
}

export interface HelpSection {
  id: 'spaces' | 'week' | 'review' | 'scores' | 'money' | 'reminders'
  icon: IconName
  title: string
  paragraphs: string[]
}

const points = (n: number) => `${n} ${n === 1 ? 'point' : 'points'}`

/** When reminders come, as the profile's Notifications footer says it; the job sends these (SPEC §4, §9.11). */
export const REMINDER_TIMES =
  'Monday evening if your list is empty, Wednesday evening if nothing is ticked yet, Thursday evening if tasks are still open, Friday to review, and when results are in. A space with its own times follows them, and you hear when a friend needs your OK.'

/** The Help sheet, in the order a newcomer meets things. About three minutes of reading, at most. */
export function helpSections(rules: HelpRules = RULES): HelpSection[] {
  const { threshold, latePenalty, maxMembers, maxSteps, hourCycle } = rules
  const { lock, reviewOpen, deadline } = rules.schedule ?? DEFAULT_SCHEDULE
  const reviewDay = reviewDayOf(rules.schedule)
  // "On Friday" for a window that opens as a day starts, else "From Thursday at 6:00 PM".
  const reviewStart = isMidnight(reviewOpen) ? `On ${reviewDay}` : `From ${momentText(reviewOpen, hourCycle)}`
  return [
    {
      id: 'spaces',
      icon: 'squareStack',
      title: 'Spaces and stakes',
      paragraphs: [
        `A space is you and up to ${maxMembers - 1} friends. Start one, or join with an invite link or code.`,
        'Each space has house stakes, set by the owner. You can also set your own: what friends owe you when you hit the bar, and what you owe when you miss.',
        'Your stakes count as soon as friends tap Agree; a line that’s the same for everyone needs all of them.',
        'A month’s stakes are set when it ends.',
        `Deadlines follow the space’s time zone. If you join after ${momentDay(lock)}’s lock, you start with the next week.`,
        'Prefer to only rate? Turn on Only Rate Friends: you review everyone, with no list and nothing owed. In a month you also play, weeks you judge count as 0%.',
        'The owner can change when lists lock and reviews open and close, with at least a day’s notice to everyone.',
      ],
    },
    {
      id: 'week',
      icon: 'listBullet',
      title: 'Your week',
      paragraphs: [
        `Plan your tasks before ${momentText(lock, hourCycle)}, when your list locks. You can plan next week any time.`,
        'From the lock on, the week counts, even if you leave the space. An empty list scores 0%.',
        `Tick tasks off as you finish them; everyone in the space sees your ticks. A task can have up to ${maxSteps} steps, and it’s done when every step is.`,
        `Until ${momentText(reviewOpen, hourCycle)} you can still add tasks. They can’t be changed, show the day you added them, and are reviewed ${isMidnight(reviewOpen) ? `on ${reviewDay} like` : 'with'} the rest.`,
        'Each month can also have a list of bigger things. Plan it in its first week; it locks with the second week’s list and counts as one extra week. You can add to it until reviews open.',
        'Can’t do a task for reasons outside your control? Cross it out with a reason before reviews open. You can undo that twice.',
      ],
    },
    {
      id: 'review',
      icon: 'person2',
      title: `${reviewDay} review`,
      paragraphs: [
        `${reviewStart}, mark each friend’s tasks: Done, Half or Not done. You review everyone who had tasks that week.`,
        'It’s blind: nobody sees any marks until everyone has submitted, or the deadline passes.',
        `Submit once, before ${momentText(deadline, hourCycle)}. Reviews are final.`,
        `Every friend you don’t review costs you ${points(latePenalty)} off your month.`,
        'In a month’s last week, you also review your friends’ monthly lists.',
        'For a crossed-out task, pick Fair, Skip It or Not Done. If most say fair, it doesn’t count.',
      ],
    },
    {
      id: 'scores',
      icon: 'trophy',
      title: 'Scores and the month',
      paragraphs: [
        'Your week’s score comes from your friends’ marks: Done counts fully, Half counts half. If nobody reviews you, your own ticks count instead.',
        `Your month is the average of its weeks, minus ${points(latePenalty)} for each review you missed. A week belongs to the month its Friday falls in.`,
        `Hit ${threshold}% for the month and your friends owe you your reward. Miss it and you owe them your penalty.`,
        'Nothing is paid in the app. Settle up in real life, then whoever was owed marks each one Settled.',
        'Need a break? Anyone can ask to pause a week before its reviews open. If everyone says OK, it doesn’t count. One pause a month.',
        `Hit ${threshold}% several months in a row for streak rewards. Sitting a month out doesn’t break a streak; a month under ${threshold}% starts it over.`,
      ],
    },
    {
      id: 'money',
      icon: 'banknote',
      title: 'Money and goals',
      paragraphs: [
        'Only you see this part. Friends never see amounts, your balance or your goals.',
        'Turn on Generates revenue for a task (tap ⓘ next to it) and enter what it pays. It’s earned when you tick it off.',
        'Set your balance once, then add or remove money as it comes and goes. Earnings add to it.',
        'Goals fill from the top with your balance. When one is funded, mark it as bought.',
      ],
    },
    {
      id: 'reminders',
      icon: 'bell',
      title: 'Reminders and installing',
      paragraphs: [
        'Add Stakes to your Home Screen: in Safari, open the Share menu and tap Add to Home Screen.',
        'Reminders only work from the installed app; turn them on in your profile. They nudge you before lists lock and reviews are due, and tell you when results are in.',
        'On Wednesday evening they nudge you if nothing is ticked yet, and on Thursday evening if tasks are still open.',
        'The installed app signs in separately from Safari: same email, same password.',
        'Spaces with their own times follow them.',
      ],
    },
  ]
}

export interface TimelineStop {
  /** Index into the week, Monday = 0. */
  day: number
  icon: IconName
  title: string
  detail: string
}

export const WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const

/**
 * The week at a glance, for the little illustration at the top of Help and the Week Schedule preview: the lock
 * on its day ("Lists lock at midnight", "at 8:00 PM"; a lock as the week starts shows on Monday), the last day to
 * add tasks on the day reviews open ("Add tasks until 6:00 PM" when they open within it), the reviews on the day
 * they're due, and the results the next day when they're due at a midnight before Sunday (else the review stop
 * ends ", then results"). In order, Monday first; two stops can share a day (the later one draws the strip's icon).
 */
export function weekTimeline(schedule: WeekSchedule = DEFAULT_SCHEDULE, hourCycle?: HourCycle): TimelineStop[] {
  const { lock, reviewOpen, deadline } = schedule
  const at = (m: number) => {
    const label = timeLabel(splitMoment(m).time, hourCycle)
    return label === 'Midnight' || label === 'Noon' ? label.toLowerCase() : label
  }
  const stop = (day: number, icon: IconName, detail: string): TimelineStop => ({ day, icon, title: DAY_NAMES[day], detail })
  const stops: TimelineStop[] = []
  stops.push(lock <= 0 ? stop(0, 'lock', 'Lists lock as the week starts') : stop(splitMoment(lock).day, 'lock', `Lists lock at ${at(lock)}`))
  stops.push(stop(splitMoment(reviewOpen).day, 'plusCircle', isMidnight(reviewOpen) ? 'Last day to add tasks' : `Add tasks until ${at(reviewOpen)}`))
  const dueDay = splitMoment(deadline).day
  const resultsNext = isMidnight(deadline) && dueDay + 1 <= 6
  stops.push(stop(dueDay, 'person2', `Reviews due by ${at(deadline)}${resultsNext ? '' : ', then results'}`))
  if (resultsNext) stops.push(stop(dueDay + 1, 'trophy', 'Results are in'))
  return stops
}

/** The usual week. */
export const WEEK_TIMELINE: TimelineStop[] = weekTimeline()

/** Under the strip, from a space: whose clock the times run on (`city`, e.g. "Berlin"), whether they're the
 *  space's own, and your role there. Undefined from a tab (no space). */
export function glanceFooter(city?: string, schedule?: WeekSchedule, judge?: boolean): string | undefined {
  const parts: string[] = []
  if (schedule && !isUsualSchedule(schedule)) parts.push(city ? `This space’s own times, on ${city} time.` : 'This space’s own times.')
  else if (city) parts.push(`Every deadline in this space runs on ${city} time.`)
  if (judge) parts.push('You’re a judge here.')
  return parts.length > 0 ? parts.join(' ') : undefined
}

export interface IntroPage {
  id: 'welcome' | 'plan' | 'review' | 'month' | 'money'
  title: string
  text: string
}

export function introPages(rules: HelpRules = RULES): IntroPage[] {
  return [
    {
      id: 'welcome',
      title: 'Welcome to Stakes',
      text: 'Plan your week, let friends review it on Friday, and see who owes whom at the end of the month.',
    },
    {
      id: 'plan',
      title: 'Plan by Monday at midnight',
      text: 'List what you’ll get done, with steps for the big ones. You can still add tasks until Thursday at midnight.',
    },
    {
      id: 'review',
      title: 'Friday is review day',
      text: 'Everyone marks each other’s tasks: Done, Half or Not done. It’s blind until everyone has submitted, or Friday ends.',
    },
    {
      id: 'month',
      title: `Hit ${rules.threshold}% and they owe you`,
      text: 'Your month is the average of your weeks. Miss the bar and you owe them instead.',
    },
    {
      id: 'money',
      title: 'Your money stays yours',
      text: 'Mark tasks that earn money, watch your balance and save for goals. Friends never see any of it.',
    },
  ]
}
