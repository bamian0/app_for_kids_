// New space: name and stakes, then straight to inviting friends.
import { useState } from 'react'
import { createSpace } from '../data/api.ts'
import type { Space } from '../domain/types.ts'
import { Button, GlassButton, NavigationStack, Screen, Section, TextArea, TextFieldRow, useNav } from '../ui/index.ts'
import { ErrorText } from './components/Bits.tsx'
import { InviteCard } from './components/InviteCard.tsx'
import { cityOf, deviceZone } from './components/zone.ts'

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = name.trim() !== '' && reward.trim() !== '' && penalty.trim() !== ''

  const create = async () => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const space = await createSpace({ name, reward, penalty })
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
      leading={<GlassButton onClick={close}>Cancel</GlassButton>}
      trailing={
        <GlassButton prominent onClick={create} disabled={!valid || busy}>
          Create
        </GlassButton>
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
        footer={error ? <ErrorText>{error}</ErrorText> : `Same stakes for everyone. Deadlines run on ${cityOf(deviceZone())} time.`}
      >
        <TextArea value={penalty} onChange={setPenalty} placeholder="Coffee for everyone, for a week" maxLength={120} minRows={2} maxRows={4} aria-label="Penalty" />
      </Section>
      <div className="s-form-actions">
        <Button size="large" fullWidth onClick={create} disabled={!valid} loading={busy}>
          Create Space
        </Button>
      </div>
    </Screen>
  )
}

function InviteStep({ space, done }: { space: Space; done: () => void }) {
  return (
    <Screen
      title="Invite Friends"
      titleDisplay="inline"
      hideBack
      trailing={
        <GlassButton prominent onClick={done}>
          Done
        </GlassButton>
      }
    >
      <div className="s-sheet-hero">
        <div className="s-sheet-hero__title">{space.name} is live.</div>
        <div className="s-sheet-hero__text">Stakes need witnesses. Invite one to seven friends.</div>
      </div>
      <InviteCard space={space} />
      <div className="s-form-actions">
        <Button size="large" fullWidth variant="gray" onClick={done}>
          Open {space.name}
        </Button>
      </div>
    </Screen>
  )
}
