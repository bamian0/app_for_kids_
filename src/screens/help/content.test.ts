import { describe, expect, it } from 'vitest'
import { scheduleProblem } from '../../domain/schedule.ts'
import { DEFAULT_SCHEDULE } from '../../domain/time.ts'
import type { WeekSchedule } from '../../domain/types.ts'
import { REMINDER_TIMES, RULES, WEEK_TIMELINE, WEEKDAY_LETTERS, glanceFooter, helpSections, introPages, reviewDayOf, weekTimeline } from './content.ts'

const sections = helpSections()
const pages = introPages()
const helpText = sections.flatMap((s) => [s.title, ...s.paragraphs]).join('\n')
const introText = pages.flatMap((p) => [p.title, p.text]).join('\n')
const allText = [helpText, introText, ...WEEK_TIMELINE.flatMap((t) => [t.title, t.detail])].join('\n')
const section = (id: string) => sections.find((s) => s.id === id)?.paragraphs.join(' ') ?? ''

describe('help content', () => {
  it('covers the topics in the order the spec lists them', () => {
    expect(sections.map((s) => s.id)).toEqual(['spaces', 'week', 'review', 'scores', 'money', 'friends', 'reminders'])
  })

  it('quotes the rules of the game exactly', () => {
    expect(RULES).toEqual({ threshold: 90, latePenalty: 5, maxMembers: 8, maxSteps: 8, schedule: DEFAULT_SCHEDULE })
    expect(section('spaces')).toContain('up to 7 friends')
    expect(section('spaces')).toContain('after Monday’s lock')
    expect(section('week')).toContain('before Monday at midnight')
    expect(section('week')).toContain('up to 8 steps')
    expect(section('week')).toContain('Until Thursday at midnight')
    expect(section('week')).toContain('0%')
    expect(section('review')).toContain('Done, Half or Not done')
    expect(section('review')).toContain('blind')
    expect(section('review')).toContain('everyone has submitted, or the deadline passes')
    expect(section('review')).toContain('before Friday at midnight')
    expect(section('review')).toContain('final')
    expect(section('review')).toContain('5 points off your month, and off that week in a deal')
    expect(section('scores')).toContain('minus 5 points for each review you missed')
    expect(section('scores')).toContain('the month its Friday falls in')
    expect(section('spaces')).toContain('needs 90%; the first miss ends it')
    expect(section('scores')).toContain('Settled')
    expect(section('money')).toContain('Only you see this part')
    expect(section('reminders')).toContain('installed app')
    expect(section('reminders')).toContain('Wednesday evening they nudge you if nothing is ticked yet')
    expect(section('reminders')).toContain('Thursday evening if tasks are still open')
    // The profile footer gives the same conditions: Wednesday's nudge only when nothing is ticked.
    expect(REMINDER_TIMES).toContain('Wednesday evening if nothing is ticked yet')
    expect(REMINDER_TIMES).toContain('Thursday evening if tasks are still open')
  })

  it('takes its numbers from the rules it is given', () => {
    const other = helpSections({ threshold: 80, latePenalty: 1, maxMembers: 4, maxSteps: 3 }).flatMap((s) => s.paragraphs).join(' ')
    expect(other).toContain('Every week or month in it needs 80%; the first miss ends it')
    expect(other).toContain('a month under 80% starts it over')
    expect(other).toContain('costs you 1 point off your month')
    expect(other).toContain('up to 3 friends')
    expect(other).toContain('up to 3 steps')
    expect(introPages({ ...RULES, threshold: 75 })[3].title).toBe('Hit 75% and they owe you')
  })

  it('covers the batch-2 features (SPEC §9.12)', () => {
    // Stakes are deals now (SPEC §12.12): what was said about house stakes, own stakes and month stakes went.
    expect(section('spaces')).not.toContain('house stakes, set by the owner')
    expect(section('spaces')).not.toContain('count as soon as friends tap Agree')
    expect(section('spaces')).not.toContain('A month’s stakes are set when it ends.')
    expect(section('spaces')).not.toContain('first lists lock')
    expect(section('spaces')).not.toContain('Anyone in the space can change the stakes')
    // Judges and custom times.
    expect(section('spaces')).toContain('Turn on Only Rate Friends')
    expect(section('spaces')).toContain('weeks you judge count as 0%')
    expect(section('spaces')).toContain('with a day’s notice.')
    // Monthly lists.
    expect(section('week')).toContain('it locks with the second week’s list and counts as one extra week')
    expect(section('review')).toContain('you also review your friends’ monthly lists')
    // Pause, streaks and per-pair settling.
    expect(section('scores')).toContain('ask to pause a week before its reviews open')
    expect(section('scores')).toContain('One pause a month.')
    expect(section('scores')).toContain('several months in a row for streak rewards')
    expect(section('scores')).toContain('a month under 90% starts it over')
    expect(section('scores')).not.toContain('your friends owe you your reward')
    expect(section('scores')).toContain('marks each one Settled')
    expect(section('reminders')).toContain('Spaces with their own times follow them;')
    expect(REMINDER_TIMES).toBe(
      'Monday evening if your list is empty, Wednesday evening if nothing is ticked yet, Thursday evening if tasks are still open, Friday to review, and when results are in. A space with its own times follows them, and you hear when a friend needs your OK or a deal ends. Shared goals remind you to check in as each week ends.',
    )
  })

  it('covers deals (SPEC §12.12)', () => {
    expect(section('spaces')).toContain('Make a deal with friends')
    expect(section('spaces')).toContain('how many weeks or months')
    expect(section('spaces')).toContain('every friend taps Agree')
    expect(section('spaces')).toContain('the first miss ends it')
    expect(section('spaces')).toContain('nothing’s at stake until a new deal')
    expect(section('review')).toContain('and off that week in a deal')
    expect(section('scores')).toContain('a paused or skipped week adds one more')
    expect(section('scores')).toContain('a month under 90% starts it over')
    expect(section('scores')).not.toContain('Done counts fully')
    expect(section('scores')).not.toContain('Sitting a month out')
    // The deal paragraph takes the bar from the rules.
    expect(helpSections({ ...RULES, threshold: 80 }).find((s) => s.id === 'spaces')?.paragraphs.join(' ')).toContain('needs 80%; the first miss ends it')
    expect(pages.find((p) => p.id === 'welcome')?.text).toBe('Plan your week, let friends review it on Friday, and make deals on how you do.')
    expect(pages.find((p) => p.id === 'month')?.title).toBe('Hit 90% and they owe you')
    expect(pages.find((p) => p.id === 'month')?.text).toBe('Make a deal for a few weeks or months. Keep each one at 90% and they owe you; miss one and you owe them.')
  })

  it('covers monthly adds, crossing out and the fair vote (SPEC §10.9)', () => {
    expect(section('week')).toContain('You can add to it until reviews open.')
    expect(section('week')).toContain('Cross it out with a reason before reviews open.')
    expect(section('week')).toContain('You can undo that twice.')
    expect(section('review')).toContain('For a crossed-out task, pick Fair, Skip It or Not Done. If most say fair, it doesn’t count.')
    // The steps and ticking paragraphs became one.
    expect(section('week')).toContain('Tick tasks off as you finish them; everyone in the space sees your ticks.')
    expect(section('week')).toContain('They can’t be changed, show the day you added them')
  })

  it('covers friends, the showcase and shared goals (SPEC §11.11)', () => {
    const friends = sections.find((s) => s.id === 'friends')
    expect(friends?.title).toBe('Friends and shared goals')
    expect(friends?.icon).toBe('personPlus')
    expect(section('friends')).toContain('Add friends with your link or code')
    expect(section('friends')).toContain('Their ring shows their month so far')
    expect(section('friends')).toContain('only what you switch on, to anyone on Stakes')
    expect(section('friends')).toContain('Check in your part each week')
    expect(section('reminders')).toContain('shared goals remind you as each week ends')
    expect(section('money')).toContain('unless you show it on your profile')
    expect(section('money')).not.toContain('Friends never see')
    expect(REMINDER_TIMES.endsWith('Shared goals remind you to check in as each week ends.')).toBe(true)
    // The two clauses that went (the task sheet and the monthly card show them).
    expect(section('week')).not.toContain('it’s done when every step is')
    expect(section('week')).not.toContain('Plan it in its first week')
    // The 5-point line stays where people review (SPEC §12.12: and off that week in a deal).
    expect(section('review')).toContain('Every friend you don’t review costs you 5 points off your month, and off that week in a deal.')
    expect(introPages().find((p) => p.id === 'money')?.text).toBe(
      'Mark tasks that earn money, watch your balance and save for goals. It’s private unless you choose to show it.',
    )
  })

  it('reads in about three minutes', () => {
    const words = helpText.split(/\s+/).filter(Boolean).length
    // SPEC §12.12: 696 words with deals; the cap is 700.
    expect(words).toBe(696)
    expect(words).toBeLessThanOrEqual(700)
    for (const s of sections) for (const p of s.paragraphs) expect(p.length, p).toBeLessThanOrEqual(190)
  })

  it('speaks plainly, with curly apostrophes and no jargon', () => {
    expect(allText).not.toMatch(/['"]/)
    expect(allText).not.toMatch(/\b(firestore|firebase|rules|database|server|timestamp|utc|lockAt|deadlineAt)\b/i)
    // Sentence case: titles start with a capital and keep the rest lowercase, bar proper names and days.
    const allowed = new Set(['Stakes', 'Monday', 'Thursday', 'Friday', 'Saturday', 'Spaces'])
    for (const title of [...sections.map((s) => s.title), ...pages.map((p) => p.title)]) {
      const [first, ...rest] = title.split(' ')
      expect(first[0], title).toBe(first[0].toUpperCase())
      for (const word of rest) if (!allowed.has(word)) expect(word, title).toBe(word.toLowerCase())
    }
  })
})

describe('intro pages', () => {
  it('has four or five pages in the spec’s order', () => {
    expect(pages.length).toBeGreaterThanOrEqual(4)
    expect(pages.length).toBeLessThanOrEqual(5)
    expect(pages.map((p) => p.id)).toEqual(['welcome', 'plan', 'review', 'month', 'money'])
  })

  it('keeps each page to a title and one or two sentences', () => {
    for (const p of pages) {
      const sentences = p.text.split(/[.?!](?:\s|$)/).filter((s) => s.trim()).length
      expect(sentences, p.text).toBeLessThanOrEqual(2)
      expect(p.title.length, p.title).toBeLessThanOrEqual(28)
    }
    expect(introText).toContain('Monday at midnight')
    expect(introText).toContain('Thursday at midnight')
    expect(introText).toContain('Done, Half or Not done')
    // Blind until everyone has submitted or the deadline, whichever comes first (§1).
    expect(introText).toContain('blind until everyone has submitted, or Friday ends')
    expect(introText).toContain('90%')
  })
})

describe('week timeline', () => {
  it('marks the lock, the last add, the review and the results on the right days', () => {
    expect(WEEKDAY_LETTERS).toHaveLength(7)
    expect(WEEK_TIMELINE.map((t) => [t.day, t.title])).toEqual([
      [0, 'Monday'],
      [3, 'Thursday'],
      [4, 'Friday'],
      [5, 'Saturday'],
    ])
    expect(weekTimeline()).toEqual(WEEK_TIMELINE)
    expect(WEEK_TIMELINE.map((t) => t.detail)).toEqual(['Lists lock at midnight', 'Last day to add tasks', 'Reviews due by midnight', 'Results are in'])
  })

  it('follows a space’s own times', () => {
    // Lists lock Monday at 8:00 PM, reviews open Thursday at 6:00 PM and are due Saturday at noon.
    const own: WeekSchedule = { lock: 1200, reviewOpen: 3 * 1440 + 1080, deadline: 5 * 1440 + 720 }
    expect(scheduleProblem(own)).toBeNull()
    expect(weekTimeline(own)).toEqual([
      { day: 0, icon: 'lock', title: 'Monday', detail: 'Lists lock at 8:00 PM' },
      { day: 3, icon: 'plusCircle', title: 'Thursday', detail: 'Add tasks until 6:00 PM' },
      { day: 5, icon: 'person2', title: 'Saturday', detail: 'Reviews due by noon, then results' },
    ])
    expect(weekTimeline(own, 'h23')[0].detail).toBe('Lists lock at 20:00')
    // Due Saturday at midnight: results on Sunday.
    expect(weekTimeline({ ...DEFAULT_SCHEDULE, deadline: 6 * 1440 }).slice(-2).map((t) => [t.title, t.detail])).toEqual([
      ['Saturday', 'Reviews due by midnight'],
      ['Sunday', 'Results are in'],
    ])
  })

  it('keeps both stops when two fall on the same day', () => {
    // Reviews open Friday at 6:00 PM and are due Friday at 9:00 PM.
    const stops = weekTimeline({ lock: 1440, reviewOpen: 4 * 1440 + 1080, deadline: 4 * 1440 + 1260 })
    expect(stops.map((t) => [t.day, t.detail])).toEqual([
      [0, 'Lists lock at midnight'],
      [4, 'Add tasks until 6:00 PM'],
      [4, 'Reviews due by 9:00 PM, then results'],
    ])
    // The strip draws one icon per day: the later stop's.
    expect(new Map(stops.map((t) => [t.day, t.icon])).get(4)).toBe('person2')
  })

  it('leaves out a results stop beyond Sunday', () => {
    const stops = weekTimeline({ ...DEFAULT_SCHEDULE, deadline: 10080 })
    expect(stops.map((t) => t.icon)).not.toContain('trophy')
    expect(stops[stops.length - 1]).toEqual({ day: 6, icon: 'person2', title: 'Sunday', detail: 'Reviews due by midnight, then results' })
  })

  it('shows a lock as the week starts on Monday', () => {
    expect(weekTimeline({ ...DEFAULT_SCHEDULE, lock: 0 })[0]).toEqual({ day: 0, icon: 'lock', title: 'Monday', detail: 'Lists lock as the week starts' })
  })
})

describe('help for a space’s own times', () => {
  const own: WeekSchedule = { lock: 1440 + 1200, reviewOpen: 4 * 1440 + 1080, deadline: 5 * 1440 + 720 }
  const custom = helpSections({ ...RULES, schedule: own })
  const of = (id: string) => custom.find((s) => s.id === id)?.paragraphs.join(' ') ?? ''

  it('words the usual times exactly as before', () => {
    expect(helpSections({ ...RULES, schedule: DEFAULT_SCHEDULE })).toEqual(sections)
    expect(sections.find((s) => s.id === 'review')?.title).toBe('Friday review')
    expect(section('review')).toContain('On Friday, mark each friend’s tasks')
    expect(section('week')).toContain('are reviewed on Friday like the rest')
    expect(reviewDayOf()).toBe('Friday')
  })

  it('changes the week and review copy and the review title', () => {
    expect(of('week')).toContain('Plan your tasks before Tuesday at 8:00 PM, when your list locks.')
    expect(of('week')).toContain('Until Friday at 6:00 PM you can still add tasks.')
    expect(of('week')).toContain('are reviewed with the rest')
    expect(of('week')).not.toMatch(/Monday|Thursday/)
    expect(custom.find((s) => s.id === 'review')?.title).toBe('Friday review')
    expect(of('review')).toContain('From Friday at 6:00 PM, mark each friend’s tasks')
    expect(of('review')).toContain('Submit once, before Saturday at noon.')
    expect(of('spaces')).toContain('Join after Tuesday’s lock')
    // Reviews that open on Thursday evening name Thursday, as the review sheet does.
    expect(helpSections({ ...RULES, schedule: { ...own, reviewOpen: 3 * 1440 + 1080 } }).find((s) => s.id === 'review')?.title).toBe('Thursday review')
    expect(helpSections({ ...RULES, schedule: own, hourCycle: 'h23' }).find((s) => s.id === 'week')?.paragraphs[0]).toBe(
      'Plan your tasks before Tuesday at 20:00, when your list locks. You can plan next week any time.',
    )
  })

  it('stays within the limits', () => {
    const text = custom.flatMap((s) => [s.title, ...s.paragraphs]).join('\n')
    // SPEC §12.12: 699 words on these times.
    expect(text.split(/\s+/).filter(Boolean).length).toBe(699)
    expect(text).not.toMatch(/['"]/)
    for (const s of custom) for (const p of s.paragraphs) expect(p.length, p).toBeLessThanOrEqual(190)
  })

  it('says whose times they are under the strip', () => {
    expect(glanceFooter()).toBeUndefined()
    expect(glanceFooter('Berlin')).toBe('Every deadline in this space runs on Berlin time.')
    expect(glanceFooter('Berlin', DEFAULT_SCHEDULE)).toBe('Every deadline in this space runs on Berlin time.')
    expect(glanceFooter('Berlin', own)).toBe('This space’s own times, on Berlin time.')
    expect(glanceFooter('Berlin', own, true)).toBe('This space’s own times, on Berlin time. You’re a judge here.')
    expect(glanceFooter('Berlin', undefined, true)).toBe('Every deadline in this space runs on Berlin time. You’re a judge here.')
  })
})
