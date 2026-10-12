import { describe, expect, it } from 'vitest'
import { REMINDER_TIMES, RULES, WEEK_TIMELINE, WEEKDAY_LETTERS, helpSections, introPages } from './content.ts'

const sections = helpSections()
const pages = introPages()
const helpText = sections.flatMap((s) => [s.title, ...s.paragraphs]).join('\n')
const introText = pages.flatMap((p) => [p.title, p.text]).join('\n')
const allText = [helpText, introText, ...WEEK_TIMELINE.flatMap((t) => [t.title, t.detail])].join('\n')
const section = (id: string) => sections.find((s) => s.id === id)?.paragraphs.join(' ') ?? ''

describe('help content', () => {
  it('covers the topics in the order the spec lists them', () => {
    expect(sections.map((s) => s.id)).toEqual(['spaces', 'week', 'review', 'scores', 'money', 'reminders'])
  })

  it('quotes the rules of the game exactly', () => {
    expect(RULES).toEqual({ threshold: 90, latePenalty: 5, maxMembers: 8, maxSteps: 8 })
    expect(section('spaces')).toContain('up to 7 friends')
    expect(section('spaces')).toContain('first lists lock')
    expect(section('week')).toContain('before Monday at midnight')
    expect(section('week')).toContain('up to 8 steps')
    expect(section('week')).toContain('Until Thursday at midnight')
    expect(section('week')).toContain('0%')
    expect(section('review')).toContain('Done, Half or Not done')
    expect(section('review')).toContain('blind')
    expect(section('review')).toContain('everyone has submitted, or the deadline passes')
    expect(section('review')).toContain('before Friday at midnight')
    expect(section('review')).toContain('final')
    expect(section('review')).toContain('5 points off your month')
    expect(section('scores')).toContain('minus 5 points for each review you missed')
    expect(section('scores')).toContain('the month its Friday falls in')
    expect(section('scores')).toContain('Hit 90% for the month')
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
    expect(other).toContain('Hit 80% for the month')
    expect(other).toContain('costs you 1 point off your month')
    expect(other).toContain('up to 3 friends')
    expect(other).toContain('up to 3 steps')
    expect(introPages({ ...RULES, threshold: 75 })[3].title).toBe('Hit 75% and they owe you')
  })

  it('reads in about two minutes', () => {
    const words = helpText.split(/\s+/).filter(Boolean).length
    expect(words).toBeLessThanOrEqual(520)
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
  })
})
