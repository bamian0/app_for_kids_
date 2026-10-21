// Help, behind the "?" on every tab's root screen: how Stakes works in about three minutes, with the
// week at a glance on top. It ends with the intro, replayed as a full-screen cover. The "How Stakes
// Works" rows in the Profile sheet and space settings push the same content, so there is one text; from a
// space it follows that space's own times (SPEC §9.12).
import { useCallback } from 'react'
import { AVATAR_COLORS } from '../../domain/ids.ts'
import type { HourCycle } from '../../domain/schedule.ts'
import type { WeekSchedule } from '../../domain/types.ts'
import { GlassButton, Icon, Row, Screen, Section, cx, useSheet } from '../../ui/index.ts'
import { RULES, WEEKDAY_LETTERS, glanceFooter, helpSections, weekTimeline } from './content.ts'
import type { HelpSection, TimelineStop } from './content.ts'
import { IntroScreen } from './IntroScreen.tsx'
import './help.css'

/** One muted tile color per topic, from the avatar palette, so the sections are easy to tell apart. */
const TILE: Record<HelpSection['id'], string> = {
  spaces: AVATAR_COLORS[0],
  week: AVATAR_COLORS[7],
  review: AVATAR_COLORS[6],
  scores: AVATAR_COLORS[3],
  money: AVATAR_COLORS[1],
  friends: AVATAR_COLORS[5],
  reminders: AVATAR_COLORS[4],
}

/** The device's clock style: "6:00 PM" or "18:00". */
const HOUR_CYCLE: HourCycle = (() => {
  try {
    const cycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle
    return cycle === 'h23' || cycle === 'h24' ? 'h23' : 'h12'
  } catch {
    return 'h12'
  }
})()

const SUBTITLE = 'Everything, in about three minutes.'

/** Plays the intro again as a full-screen cover. Replaying it doesn't touch the device's flag. */
function useShowIntro(): () => void {
  const { present } = useSheet()
  return useCallback(() => {
    present((done) => <IntroScreen onDone={done} />, { presentation: 'fullScreen', 'aria-label': 'Introduction' })
  }, [present])
}

/** Opens Help. Its last row swaps it for the intro. */
export function useHelp(): () => void {
  const { present } = useSheet()
  const showIntro = useShowIntro()
  return useCallback(() => {
    present(
      (close) => (
        <HelpSheet
          close={close}
          onShowIntro={() => {
            close()
            showIntro()
          }}
        />
      ),
      { 'aria-label': 'Help' },
    )
  }, [present, showIntro])
}

/** The round "?" at the leading edge of every tab's root screen. */
export function HelpButton() {
  const open = useHelp()
  return <GlassButton icon="questionmark" aria-label="Help" onClick={open} />
}

export function HelpSheet({ close, onShowIntro }: { close: () => void; onShowIntro: () => void }) {
  return (
    <Screen
      title="How Stakes Works"
      subtitle={SUBTITLE}
      className="hp"
      trailing={<GlassButton prominent icon="checkmark" aria-label="Done" onClick={close} />}
    >
      <HelpContent onShowIntro={onShowIntro} />
    </Screen>
  )
}

export interface HelpScreenProps {
  /** The city a space's deadlines run on ("Berlin"), from a space's settings. */
  timezone?: string
  /** The space's own times (absent: the usual ones). */
  schedule?: WeekSchedule
  /** You only rate in this space. */
  judge?: boolean
}

/** The same, pushed from a settings row; from a space it follows its times and names its clock. */
export function HelpScreen({ timezone, schedule, judge }: HelpScreenProps) {
  const showIntro = useShowIntro()
  return (
    <Screen title="How Stakes Works" subtitle={SUBTITLE} className="hp">
      <HelpContent onShowIntro={showIntro} timezone={timezone} schedule={schedule} judge={judge} />
    </Screen>
  )
}

function HelpContent({ onShowIntro, timezone, schedule, judge }: { onShowIntro: () => void } & HelpScreenProps) {
  return (
    <>
      <Section header="Your week at a glance" footer={glanceFooter(timezone, schedule, judge)}>
        <WeekGlance stops={weekTimeline(schedule, HOUR_CYCLE)} />
      </Section>
      {helpSections({ ...RULES, schedule, hourCycle: HOUR_CYCLE }).map((section) => (
        <Topic key={section.id} section={section} />
      ))}
      <Section>
        <Row icon="sparkles" iconBackground="var(--system-gray)" title="Show the Intro Again" onPress={onShowIntro} />
      </Section>
    </>
  )
}

/** Monday to Sunday with the moments that matter, then the same in words. When two share a day, the later one
 *  draws the strip's icon and both are in the legend. Exported for the Week Schedule screen's live preview. */
export function WeekGlance({ stops: list = weekTimeline() }: { stops?: TimelineStop[] }) {
  const stops = new Map(list.map((stop) => [stop.day, stop]))
  return (
    <div className="hp-week">
      <div className="hp-week__strip" aria-hidden>
        {WEEKDAY_LETTERS.map((letter, day) => {
          const stop = stops.get(day)
          return (
            <span key={day} className={cx('hp-day', stop && 'hp-day--stop', stop?.icon === 'person2' && 'hp-day--review')}>
              <span className="hp-day__letter">{letter}</span>
              <span className="hp-day__node">{stop && <Icon name={stop.icon} size={15} weight={2.1} />}</span>
            </span>
          )
        })}
      </div>
      <ul className="hp-week__legend">
        {list.map((stop) => (
          <li key={`${stop.day}-${stop.icon}`} className="hp-stop">
            <span className="hp-stop__icon" aria-hidden>
              <Icon name={stop.icon} size={17} weight={1.9} />
            </span>
            <span className="hp-stop__day">{stop.title}</span>
            <span className="hp-stop__detail">{stop.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Topic({ section }: { section: HelpSection }) {
  return (
    <Section>
      <div className="hp-topic">
        <div className="hp-topic__head">
          <span className="hp-topic__tile" style={{ background: TILE[section.id] }} aria-hidden>
            <Icon name={section.icon} size={19} weight={1.9} />
          </span>
          <h2 className="hp-topic__title">{section.title}</h2>
        </div>
        {section.paragraphs.map((text) => (
          <p key={text} className="hp-topic__text">
            {text}
          </p>
        ))}
      </div>
    </Section>
  )
}
