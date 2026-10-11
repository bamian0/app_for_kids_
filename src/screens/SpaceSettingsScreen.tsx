// Space settings: name and stakes, members, invite, the rules, and leaving.
import { useEffect, useState } from 'react'
import { leaveSpace, updateSpace, useAuth, useProfiles, useSpace } from '../data/api.ts'
import type { Space } from '../domain/types.ts'
import { Avatar, EmptyState, GlassButton, Row, Screen, Section, TextArea, TextFieldRow, useAlert, useNav, useToast } from '../ui/index.ts'
import { Loading } from './components/Bits.tsx'
import { InviteCard } from './components/InviteCard.tsx'
import { personOf } from './components/people.ts'
import { cityOf } from './components/zone.ts'
import { RulesScreen } from './RulesScreen.tsx'

export function SpaceSettingsScreen({ spaceId }: { spaceId: string }) {
  const live = useSpace(spaceId)
  if (!live.data) {
    return (
      <Screen title="Settings" titleDisplay="inline">
        {live.data === null ? <EmptyState icon="person2" title="You’re not in this space" /> : <Loading />}
      </Screen>
    )
  }
  return <SettingsContent space={live.data} />
}

const joinedFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

function SettingsContent({ space }: { space: Space }) {
  const nav = useNav()
  const toast = useToast()
  const { confirm } = useAlert()
  const { uid } = useAuth()
  const profiles = useProfiles(space.memberIds)
  const [name, setName] = useState(space.name)
  const [reward, setReward] = useState(space.reward)
  const [penalty, setPenalty] = useState(space.penalty)
  const [saving, setSaving] = useState(false)
  const dirty = name !== space.name || reward !== space.reward || penalty !== space.penalty
  const valid = name.trim() !== '' && reward.trim() !== '' && penalty.trim() !== ''

  // A friend's edit shows up live unless you're changing things yourself.
  useEffect(() => {
    if (dirty) return
    setName(space.name)
    setReward(space.reward)
    setPenalty(space.penalty)
    // Only the server values should trigger this.
  }, [space.name, space.reward, space.penalty])

  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    try {
      await updateSpace(space.id, { name: name.trim(), reward: reward.trim(), penalty: penalty.trim() })
      setName(name.trim())
      setReward(reward.trim())
      setPenalty(penalty.trim())
      toast({ title: 'Saved', tone: 'success' })
    } catch (e) {
      toast({ title: 'Couldn’t save', message: e instanceof Error ? e.message : undefined, tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const leave = async () => {
    const last = space.memberIds.length === 1
    const ok = await confirm({
      title: `Leave “${space.name}”?`,
      message: last
        ? 'You’re the last one here. The space and its invite code will be gone.'
        : 'Your past weeks stay in your friends’ history. To come back, you’ll need the code.',
      confirmLabel: 'Leave',
      destructive: true,
    })
    if (!ok) return
    nav.popToRoot()
    try {
      await leaveSpace(space.id)
      toast({ title: `You left ${space.name}` })
    } catch (e) {
      toast({ title: 'Couldn’t leave', message: e instanceof Error ? e.message : undefined, tone: 'error' })
    }
  }

  const members = [...space.memberIds].sort((a, b) => (space.joinedAt[a] ?? 0) - (space.joinedAt[b] ?? 0))

  return (
    <Screen
      title="Settings"
      titleDisplay="inline"
      trailing={
        dirty ? (
          <GlassButton prominent onClick={save} disabled={!valid || saving}>
            Save
          </GlassButton>
        ) : undefined
      }
    >
      <Section header="Name">
        <TextFieldRow value={name} onChange={setName} placeholder="Space name" maxLength={40} aria-label="Space name" autoCapitalize="words" />
      </Section>
      <Section header={`If you hit ${space.threshold}%, they owe you…`}>
        <TextArea value={reward} onChange={setReward} placeholder="Dinner, on them" maxLength={120} minRows={1} maxRows={4} aria-label="Reward" />
      </Section>
      <Section header="If you miss, you owe them…" footer="Changes apply to everyone, starting with this month.">
        <TextArea value={penalty} onChange={setPenalty} placeholder="Coffee for everyone, for a week" maxLength={120} minRows={1} maxRows={4} aria-label="Penalty" />
      </Section>

      <Section header={`Members · ${space.memberIds.length} of 8`}>
        {members.map((id) => {
          const person = personOf(profiles, id)
          const joined = space.joinedAt[id]
          const role = id === space.ownerId ? 'Started the space' : joined ? `Joined ${joinedFormat.format(joined)}` : undefined
          return <Row key={id} leading={<Avatar name={person.name} color={person.color} size={32} />} title={id === uid ? `${person.name} (You)` : person.name} subtitle={role} />
        })}
      </Section>

      <InviteCard space={space} />

      <Section footer={`Lists lock Monday at midnight and reviews are due Friday at midnight, ${cityOf(space.timezone)} time.`}>
        <Row icon="info" title="How Stakes Works" chevron onPress={() => nav.push(<RulesScreen timezone={cityOf(space.timezone)} />, { title: 'How Stakes Works' })} />
        <Row icon="clock" title="Time Zone" detail={cityOf(space.timezone)} />
      </Section>

      <Section>
        <Row title="Leave Space" destructive onPress={leave} />
      </Section>
    </Screen>
  )
}
