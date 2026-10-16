// The schedule notice at the top of the Space screen (SPEC §9.2): "New times from next week" for everyone who
// knew the old times, or "This space has its own times" once for a newcomer. A tap opens the Week Schedule; the
// xmark dismisses it on this device.
import { Icon, Section } from '../../ui/index.ts'
import type { NoticeView } from './space.ts'
import './space.css'

export interface ScheduleNoticeProps {
  view: NoticeView
  onOpen: () => void
  onDismiss: (seenKey: string) => void
}

/** "Lists lock … · Reviews open … · Reviews due …." reads as three short lines, one per moment. The dots and the
 *  last period stay in the text (screen readers and copy get the sentence), just not on screen. */
function OwnTimes({ line }: { line: string }) {
  const parts = line.replace(/\.$/, '').split(' · ')
  return (
    <>
      {parts.map((part, i) => (
        <span key={i} className="sp-own-time">
          {part}
          <span className="sp-own-time__sep">{i < parts.length - 1 ? ' · ' : '.'}</span>
        </span>
      ))}
    </>
  )
}

export function ScheduleNotice({ view, onOpen, onDismiss }: ScheduleNoticeProps) {
  return (
    <Section className="sp-notice">
      <div className="sp-line">
        <button type="button" className="sp-line__main" onClick={onOpen}>
          <span className="sp-tile" aria-hidden>
            <Icon name="clock" size={19} weight={2} />
          </span>
          <span className="sp-line__text">
            <span className="sp-line__title">{view.title}</span>
            <span className="sp-line__subtitle">{view.kind === 'own' ? <OwnTimes line={view.subtitle} /> : view.subtitle}</span>
          </span>
        </button>
        <button type="button" className="sp-close" aria-label="Dismiss" onClick={() => onDismiss(view.seenKey)}>
          <span className="sp-close__dot">
            <Icon name="xmark" size={11} weight={3} />
          </span>
        </button>
      </div>
    </Section>
  )
}
