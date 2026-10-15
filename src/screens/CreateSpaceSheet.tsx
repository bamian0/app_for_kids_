// New space: name, the house stakes and your role, then straight to inviting friends.
import { useState } from 'react'
import { createSpace } from '../data/api.ts'
import type { Space } from '../domain/types.ts'
import { ActivityIndicator, GlassButton, NavigationStack, Row, Screen, Section, TextArea, TextFieldRow, useNav } from '../ui/index.ts'
import { ErrorText } from './components/Bits.tsx'
import { InviteCard } from './components/InviteCard.tsx'
import { cityOf, deviceZone } from './components/zone.ts'
import { JUDGE_FOOTER_NEW } from './space/space.ts'

interface Props {
  close: () => void
  /** Called after the sheet closes on the invite step, to show the new space. */
  onOpen: (space: Space) => void
}

export function CreateSpaceSheet(props: Props) {
  return <NavigationStack root={<CreateSpaceForm {...props} />} />
}

function CreateSpaceForm({ close, onOpen }: Props) {
  const nav = useNav()
  const [name, setName] = useState('')
  const [reward, setReward] = useState('')
  const [penalty, setPenalty] = useState('')
  const [judge, setJudge] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = name.trim() !== '' && reward.trim() !== '' && penalty.trim() !== ''

  const create = async () => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const space = await createSpace(judge ? { name, reward, penalty, judge } : { name, reward, penalty })
      nav.push(
        <InviteStep
          space={space}
          done={() => {
            close()
            onOpen(space)
          }}
        />,
        { title: 'Invite' },
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t create the space.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen
      title="New Space"
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={close} />}
      trailing={
        busy ? (
          <span className="s-bar-spinner">
            <ActivityIndicator color="var(--secondary-label)" label="Creating" />
          </span>
        ) : (
          <GlassButton prominent icon="checkmark" aria-label="Create" onClick={create} disabled={!valid} />
        )
      }
    >
      <Section header="Name">
        <TextFieldRow value={name} onChange={setName} placeholder="Film Crew" maxLength={40} autoCapitalize="words" enterKeyHint="next" aria-label="Space name" />
      </Section>
      <Section header="If you hit 90%, they owe you…" footer="Whoever clears the bar for the month collects this from the others.">
        <TextArea value={reward} onChange={setReward} placeholder="Dinner, on them" maxLength={120} minRows={2} maxRows={4} aria-label="Reward" />
      </Section>
      <Section
        header="If you miss, you owe them…"
        footer={`Everyone starts on these. Each friend can set their own once they’re in. Deadlines run on ${cityOf(deviceZone())} time.`}
      >
        <TextArea value={penalty} onChange={setPenalty} placeholder="Coffee for everyone, for a week" maxLength={120} minRows={2} maxRows={4} aria-label="Penalty" />
      </Section>
      <Section footer={error ? <ErrorText>{error}</ErrorText> : JUDGE_FOOTER_NEW}>
        <Row title="Only Rate Friends" toggle={judge} onToggle={setJudge} />
      </Section>
    </Screen>
  )
}

function InviteStep({ space, done }: { space: Space; done: () => void }) {
  return (
    <Screen
      title="Invite Friends"
      titleDisplay="inline"
      hideBack
      trailing={<GlassButton prominent icon="checkmark" aria-label="Done" onClick={done} />}
    >
      <div className="s-sheet-hero">
        <div className="s-sheet-hero__title">{space.name} is live.</div>
        <div className="s-sheet-hero__text">Stakes need witnesses. Invite one to seven friends.</div>
      </div>
      <InviteCard space={space} />
    </Screen>
  )
}
