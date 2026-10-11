// One participant's week: who they are, their tasks with check-offs, and once revealed, the marks
// each friend gave and the week score.
import type { MemberWeekResult } from '../../domain/scoring.ts'
import type { WeekPhase } from '../../domain/time.ts'
import type { UID } from '../../domain/types.ts'
import { Avatar, CheckCircle, Icon, Row, Section, Shimmer } from '../../ui/index.ts'
import { CheckDot, MarkGlyph, MiniScore } from './Bits.tsx'
import { summarizeMarks } from './marks.ts'
import { firstName, listNames, nameOf, personOf, shortName } from './people.ts'
import type { Profiles } from './people.ts'

export interface MemberCardProps {
  member: MemberWeekResult
  me: UID
  profiles: Profiles
  revealed: boolean
  phase: WeekPhase
  threshold: number
  latePenalty: number
  /** Self check-offs (current user only, until the deadline). */
  canCheck?: boolean
  onToggleDone?: (taskId: string, done: boolean) => void
  shimmer?: { id: string; stamp: number }
  /** Before the week starts check-offs mean nothing, so tasks are numbered instead. */
  numbered?: boolean
  /** No longer in the space (their week still counts). */
  former?: boolean
}

export function MemberCard({ member, me, profiles, revealed, phase, threshold, latePenalty, canCheck, onToggleDone, shimmer, numbered, former }: MemberCardProps) {
  const isMe = member.uid === me
  const person = personOf(profiles, member.uid)
  const n = member.taskCount
  const done = member.tasks.filter((t) => t.selfDone).length
  const scored = revealed && member.score !== null
  const reviewed = member.reviewedBy.length > 0
  // After friends' marks are in, your own check-offs no longer change anything.
  const checkable = !!canCheck && !(scored && reviewed)
  const who = (uid: UID) => shortName(profiles, uid, me)

  let subtitle: string
  let score = null
  if (scored) {
    subtitle = n === 0 ? 'Nothing planned' : reviewed ? `Reviewed by ${listNames(member.reviewedBy.map((uid) => (uid === me ? 'you' : who(uid))))}` : 'Nobody reviewed, check-offs count'
    score = <MiniScore value={member.score} threshold={threshold} caption={phase === 'closed' || reviewed ? 'Final' : 'So far'} />
  } else if (phase === 'planning') {
    subtitle = n === 0 ? 'No tasks yet' : `${n} task${n === 1 ? '' : 's'} planned`
  } else {
    subtitle = n === 0 ? 'Nothing planned' : `${done} of ${n} done`
    if (phase === 'review' && !isMe) subtitle += member.hasSubmitted ? ' · reviews in' : ' · still reviewing'
    if (n > 0) score = <MiniScore value={member.provisionalScore} threshold={threshold} caption="Provisional" iridescent={false} />
  }
  if (former) subtitle = `Left · ${subtitle}`

  const missed = member.missedReviewsOf
  return (
    <Section>
      <Row
        leading={<Avatar name={person.name} color={person.color} size={36} />}
        title={<span className="t-semibold">{isMe ? `${person.name} (You)` : person.name}</span>}
        subtitle={subtitle}
        accessory={score}
      />
      {n === 0 ? (
        <Row title={<span className="c-secondary">{phase === 'planning' ? 'Still planning' : 'No tasks this week'}</span>} leading={<span className="s-row-spacer" />} />
      ) : (
        member.tasks.map((task, i) => {
          const marks = Object.entries(task.reviewerMarks)
          const marksText = summarizeMarks(marks, me, who)
          let lead
          if (checkable) {
            lead = <CheckCircle checked={task.selfDone} onChange={(v) => onToggleDone?.(task.taskId, v)} aria-label={task.title} />
          } else if (scored) {
            lead = <MarkGlyph mark={task.mark} />
          } else if (numbered) {
            lead = (
              <span className="s-task__index t-tabular" aria-hidden>
                {i + 1}
              </span>
            )
          } else {
            lead = <CheckDot done={task.selfDone} label={task.selfDone ? `Checked off by ${person.name}` : `Not checked off by ${person.name}`} />
          }
          const subtitleText = scored && task.source === 'self' ? (task.selfDone ? 'Checked off' : 'Not checked off') : marksText || undefined
          const row = (
            <Row
              key={task.taskId}
              leading={lead}
              title={task.title}
              subtitle={subtitleText}
              detail={scored && marks.length > 1 ? `${Math.round(task.mark * 100)}%` : undefined}
            />
          )
          return checkable ? (
            <Shimmer key={task.taskId} trigger={shimmer?.id === task.taskId ? shimmer.stamp : undefined}>
              {row}
            </Shimmer>
          ) : (
            row
          )
        })
      )}
      {missed.length > 0 && (
        <Row
          leading={
            <span className="s-penalty-icon">
              <Icon name="clock" size={18} weight={2} />
            </span>
          }
          title={`${isMe ? 'You didn’t' : `${firstName(person.name)} didn’t`} review ${listNames(missed.map((uid) => (uid === me ? 'you' : firstName(nameOf(profiles, uid)))))}`}
          subtitle={`−${latePenalty * missed.length} points this month`}
        />
      )}
    </Section>
  )
}
