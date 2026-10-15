// The month's list as one row on the Space screen (SPEC §9.5): your list while you plan it, how it's going
// once it locks, or friends' lists when you have none. A tap pushes the monthly screen.
import { useAuth, useMonthly } from '../../data/api.ts'
import { computeMonthly } from '../../domain/scoring.ts'
import type { MonthId, Space } from '../../domain/types.ts'
import { Icon, Row, Section, useNav } from '../../ui/index.ts'
import { MiniScore } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { monthName } from '../components/format.ts'
import { firstName, nameOf } from '../components/people.ts'
import type { Profiles } from '../components/people.ts'
import { deadlineText } from '../components/zone.ts'
import { listWhen, monthlyCardView } from './copy.ts'
import { MonthlyScreen } from './MonthlyScreen.tsx'
import './monthly.css'

export interface MonthlyCardProps {
  space: Space
  /** The month whose list this is: this week's month, or next week's on the Next Week tab. */
  monthId: MonthId
  profiles: Profiles
}

/** Nothing while the list loads, when it can't exist yet, or when it has nothing for you. */
export function MonthlyCard({ space, monthId, profiles }: MonthlyCardProps) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const nav = useNav()
  const live = useMonthly(space, monthId)
  // A list that can't load (e.g. the rules aren't published yet) simply doesn't show.
  const data = live.error ? undefined : live.data
  const result = data ? computeMonthly(data, space, nowMs) : null
  const view = monthlyCardView({
    space,
    me,
    nowMs,
    data,
    result,
    name: (id) => firstName(nameOf(profiles, id)),
    when: (ms) => listWhen(ms, space.timezone, nowMs, (at) => deadlineText(at, space.timezone, nowMs)),
  })
  if (!view) return null

  const title = `${monthName(monthId)} List`
  const open = () => nav.push(<MonthlyScreen spaceId={space.id} monthId={monthId} />, { title })

  return (
    <Section className="mo-card">
      <Row
        leading={
          <span className="s-status-icon" aria-hidden>
            <Icon name={view.icon} size={18} weight={2} />
          </span>
        }
        title={<span className="t-semibold">{view.title}</span>}
        subtitle={view.subtitle}
        accessory={
          view.score ? (
            <MiniScore value={view.score.value} threshold={space.threshold} iridescent={!view.score.provisional} caption={view.score.provisional ? 'Provisional' : undefined} />
          ) : undefined
        }
        chevron
        onPress={open}
      />
    </Section>
  )
}
