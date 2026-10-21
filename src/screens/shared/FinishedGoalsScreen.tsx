// Finished (SPEC §11.9.5): your goals that were finished or ended, newest first. Each opens read-only.
import { useAuth, useSharedGoals } from '../../data/api.ts'
import { EmptyState, Row, Screen, Section, useNav } from '../../ui/index.ts'
import { Loading } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { finishedGoals, finishedSubtitle } from './copy.ts'
import { SharedGoalScreen } from './SharedGoalScreen.tsx'
import './shared.css'

export function FinishedGoalsScreen() {
  const nav = useNav()
  const { uid: me } = useAuth()
  const live = useSharedGoals()
  const nowMs = useNow()
  const goals = live.data && me ? finishedGoals(live.data.goals, nowMs) : []

  return (
    <Screen title="Finished" titleDisplay="inline">
      {live.data === undefined ? (
        live.error ? (
          <EmptyState icon="info" title="Can’t load your goals" message={live.error.message} />
        ) : (
          <Loading />
        )
      ) : goals.length === 0 ? (
        <EmptyState icon="target" title="Nothing finished yet" message="Goals you finish, or that reach their last day, show up here." />
      ) : (
        <Section>
          {goals.map((goal) => (
            <Row
              key={goal.id}
              title={goal.name}
              subtitle={finishedSubtitle(goal, nowMs)}
              chevron
              onPress={() =>
                nav.push(<SharedGoalScreen goalId={goal.id} />, {
                  title: goal.name,
                })
              }
            />
          ))}
        </Section>
      )}
    </Screen>
  )
}
