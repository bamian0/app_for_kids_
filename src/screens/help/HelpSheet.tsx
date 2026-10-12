// Help, behind the "?" on every tab's root screen: how Stakes works in a two-minute read, with the
// week at a glance on top. It ends with the intro, replayed as a full-screen cover. The "How Stakes
// Works" rows in the Profile sheet and space settings push the same content, so there is one text.
import { useCallback } from 'react'
import { AVATAR_COLORS } from '../../domain/ids.ts'
import { GlassButton, Icon, Row, Screen, Section, cx, useSheet } from '../../ui/index.ts'
import { WEEK_TIMELINE, WEEKDAY_LETTERS, helpSections } from './content.ts'
import type { HelpSection } from './content.ts'
import { IntroScreen } from './IntroScreen.tsx'
import './help.css'

/** One muted tile color per topic, from the avatar palette, so the sections are easy to tell apart. */
const TILE: Record<HelpSection['id'], string> = {
  spaces: AVATAR_COLORS[0],
  week: AVATAR_COLORS[7],
  review: AVATAR_COLORS[6],
  scores: AVATAR_COLORS[3],
  money: AVATAR_COLORS[1],
  reminders: AVATAR_COLORS[4],
}

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
      subtitle="Everything, in a two-minute read."
      className="hp"
      trailing={<GlassButton prominent icon="checkmark" aria-label="Done" onClick={close} />}
    >
      <HelpContent onShowIntro={onShowIntro} />
    </Screen>
  )
}

/** The same, pushed from a settings row; `timezone` names the city a space's deadlines run on. */
export function HelpScreen({ timezone }: { timezone?: string }) {
  const showIntro = useShowIntro()
  return (
    <Screen title="How Stakes Works" subtitle="Everything, in a two-minute read." className="hp">
      <HelpContent onShowIntro={showIntro} timezone={timezone} />
    </Screen>
  )
}

function HelpContent({ onShowIntro, timezone }: { onShowIntro: () => void; timezone?: string }) {
  return (
    <>
      <Section header="Your week at a glance" footer={timezone ? `Every deadline in this space runs on ${timezone} time.` : undefined}>
        <WeekGlance />
      </Section>
      {helpSections().map((section) => (
        <Topic key={section.id} section={section} />
      ))}
      <Section>
        <Row icon="sparkles" iconBackground="var(--system-gray)" title="Show the Intro Again" onPress={onShowIntro} />
      </Section>
    </>
  )
}

/** Monday to Sunday with the four moments that matter, then the same four in words. */
function WeekGlance() {
  const stops = new Map(WEEK_TIMELINE.map((stop) => [stop.day, stop]))
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
        {WEEK_TIMELINE.map((stop) => (
          <li key={stop.day} className="hp-stop">
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
