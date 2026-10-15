// Week Schedule (SPEC §9.2): when lists lock and when reviews open and are due, on the space's clock. The owner
// picks each moment with a day and a time capsule (native pickers) and sees the week change shape above; a
// change starts with the first week whose lists lock at least a day away, and everyone gets a notice. Everyone
// else sees the same screen read-only.
import { useEffect, useState } from 'react'
import { setSchedule, useAuth, useProfiles, useSpace, useWeek } from '../../data/api.ts'
import { isUsualSchedule, sameSchedule, scheduleOf, scheduleProblem, scheduleProblemText, scheduleStartsWith, splitMoment } from '../../domain/schedule.ts'
import { DEFAULT_SCHEDULE, addWeeks, weekIdFor } from '../../domain/time.ts'
import type { Space, WeekSchedule } from '../../domain/types.ts'
import { EmptyState, GlassButton, Row, Screen, Section, useAlert, useToast } from '../../ui/index.ts'
import { ErrorText, Loading } from '../components/Bits.tsx'
import { useNow } from '../components/clock.ts'
import { shortDate } from '../components/format.ts'
import { firstName, nameOf } from '../components/people.ts'
import { cityOf, deviceHourCycle } from '../components/zone.ts'
import { WeekGlance } from '../help/HelpSheet.tsx'
import { weekTimeline } from '../help/content.ts'
import {
  SCHEDULE_FOOTER_START,
  dayName,
  dayOptions,
  momentDetail,
  pickerTime,
  scheduleConfirm,
  scheduleReadOnlyFooter,
  scheduleSaved,
  scheduleTimesFooter,
  startsDetail,
  timeOptions,
  withDay,
  withTime,
} from './space.ts'
import type { MomentKind } from './space.ts'
import './space.css'

export function ScheduleScreen({ spaceId }: { spaceId: string }) {
  const live = useSpace(spaceId)
  if (!live.data) {
    return (
      <Screen title="Week Schedule" titleDisplay="inline">
        {live.data === null ? <EmptyState icon="person2" title="You’re not in this space" /> : live.error ? <EmptyState icon="info" title="Can’t load this space" message={live.error.message} /> : <Loading />}
      </Screen>
    )
  }
  return <ScheduleContent space={live.data} />
}

const MOMENTS: { kind: MomentKind; label: string }[] = [
  { kind: 'lock', label: 'Lists lock' },
  { kind: 'reviewOpen', label: 'Reviews open' },
  { kind: 'deadline', label: 'Reviews due' },
]

const HOUR_CYCLE = deviceHourCycle()

function ScheduleContent({ space }: { space: Space }) {
  const { uid } = useAuth()
  const me = uid ?? ''
  const nowMs = useNow()
  const toast = useToast()
  const { confirm } = useAlert()
  const profiles = useProfiles([space.ownerId, ...(space.scheduleNote ? [space.scheduleNote.by] : [])])
  const thisWeek = weekIdFor(nowMs, space.timezone)
  const thisDoc = useWeek(space, thisWeek).data?.week ?? null
  const nextDoc = useWeek(space, addWeeks(thisWeek, 1)).data?.week ?? null
  const isOwner = me === space.ownerId
  const saved = scheduleOf(space)
  const [draft, setDraft] = useState<WeekSchedule>(saved)
  const [busy, setBusy] = useState(false)
  const dirty = !sameSchedule(draft, saved)
  const problem = scheduleProblem(draft)
  const city = cityOf(space.timezone)
  const name = (id: string) => firstName(nameOf(profiles, id))

  // A change saved elsewhere (or this one landing) shows up unless you're editing.
  useEffect(() => {
    if (!dirty) setDraft(saved)
    // Only the stored times should trigger this.
  }, [saved.lock, saved.reviewOpen, saved.deadline])

  const fromWeek = scheduleStartsWith(space, draft, { thisWeek: thisDoc, nextWeek: nextDoc }, nowMs)

  const save = async () => {
    if (!dirty || problem || busy) return
    const { title, message } = scheduleConfirm(space.name, space.schedule, draft, fromWeek, thisWeek, HOUR_CYCLE)
    const ok = await confirm({ title, message, confirmLabel: 'Change Times' })
    if (!ok) return
    setBusy(true)
    try {
      const result = await setSchedule(space.id, isUsualSchedule(draft) ? null : draft)
      toast({ ...scheduleSaved(result.fromWeek, thisWeek), tone: 'success' })
    } catch (e) {
      toast({ title: 'Couldn’t change the times', message: e instanceof Error ? e.message : undefined, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const note = space.scheduleNote
  const timesFooter = isOwner
    ? problem
      ? <ErrorText>{scheduleProblemText(problem, draft)}</ErrorText>
      : scheduleTimesFooter(city)
    : `${scheduleReadOnlyFooter(name(space.ownerId), note ? { byName: name(note.by), at: shortDate(note.at) } : null)} Times follow ${city} time.`

  return (
    <Screen
      title="Week Schedule"
      titleDisplay="inline"
      trailing={
        isOwner && dirty ? (
          <GlassButton prominent onClick={() => void save()} disabled={!!problem || busy}>
            Save
          </GlassButton>
        ) : undefined
      }
    >
      <Section>
        <WeekGlance stops={weekTimeline(problem ? saved : draft, HOUR_CYCLE)} />
      </Section>

      <Section footer={timesFooter}>
        {MOMENTS.map(({ kind, label }) =>
          isOwner ? (
            <MomentPicker key={kind} kind={kind} label={label} value={draft[kind]} onChange={(m) => setDraft({ ...draft, [kind]: m })} />
          ) : (
            <Row key={kind} title={label} detail={momentDetail(draft[kind], HOUR_CYCLE)} />
          ),
        )}
      </Section>

      {isOwner && (
        <Section footer={SCHEDULE_FOOTER_START}>
          <Row title="Starts" detail={startsDetail(fromWeek, thisWeek)} />
          {!isUsualSchedule(draft) && <Row title="Use the Usual Times" action onPress={() => setDraft(DEFAULT_SCHEDULE)} />}
        </Section>
      )}
    </Screen>
  )
}

/** One moment as two capsules, a day and a time, each a native picker underneath. */
function MomentPicker({ kind, label, value, onChange }: { kind: MomentKind; label: string; value: number; onChange: (m: number) => void }) {
  const { day, time } = splitMoment(value)
  const days = dayOptions(kind, value)
  const times = timeOptions(kind, value, HOUR_CYCLE)
  const shownTime = time === 1440 ? 'Midnight' : pickerTime(time, HOUR_CYCLE)
  return (
    <div className="sp-moment">
      <span className="sp-moment__label">{label}</span>
      <span className="sp-moment__capsules">
        <label className="sp-capsule">
          <span className="sp-capsule__text">{dayName(day)}</span>
          <select className="sp-capsule__select" aria-label={`${label}: day`} value={day} onChange={(e) => onChange(withDay(kind, value, Number(e.currentTarget.value)))}>
            {days.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sp-capsule">
          <span className="sp-capsule__text">{shownTime}</span>
          <select className="sp-capsule__select" aria-label={`${label}: time`} value={time} onChange={(e) => onChange(withTime(value, Number(e.currentTarget.value)))}>
            {times.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </span>
    </div>
  )
}
