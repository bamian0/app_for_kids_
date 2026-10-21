// Invite Friends (owner, SPEC §11.9.5): your friends who aren't in the goal or invited yet, with check circles, up
// to the spots left (members + invited ≤ 8).
import { useState } from 'react'
import { inviteToSharedGoal, useSharedGoal } from '../../data/api.ts'
import type { SharedGoal, UID } from '../../domain/types.ts'
import { ActivityIndicator, GlassButton, Screen, useToast } from '../../ui/index.ts'
import { ErrorText, Loading } from '../components/Bits.tsx'
import { NO_FRIENDS, spotsLeft, spotsLeftFooter } from './copy.ts'
import { FriendPicker, errorText, useFriendsList } from './parts.tsx'

export function InviteFriendsSheet({ goal: initial, close }: { goal: SharedGoal; close: () => void }) {
  const goal = useSharedGoal(initial.id).data ?? initial
  const toast = useToast()
  const { friends, loaded } = useFriendsList()
  const [selected, setSelected] = useState<UID[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const eligible = friends.filter((f) => !goal.memberIds.includes(f.uid) && !goal.invited.includes(f.uid))
  const spots = spotsLeft(goal)
  const picked = selected.filter((uid) => eligible.some((f) => f.uid === uid))

  const toggle = (uid: UID) => setSelected((list) => (list.includes(uid) ? list.filter((u) => u !== uid) : list.length >= spots ? list : [...list, uid]))

  const invite = async () => {
    if (picked.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      await inviteToSharedGoal(goal.id, picked)
      close()
      toast({ title: 'Invites sent', icon: 'personPlus' })
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Screen
      title="Invite Friends"
      titleDisplay="inline"
      leading={<GlassButton icon="xmark" aria-label="Cancel" onClick={close} />}
      trailing={
        busy ? (
          <span className="s-bar-spinner">
            <ActivityIndicator color="var(--secondary-label)" label="Inviting" />
          </span>
        ) : (
          <GlassButton prominent icon="checkmark" aria-label="Invite" onClick={() => void invite()} disabled={picked.length === 0} />
        )
      }
    >
      {loaded ? (
        <FriendPicker
          friends={eligible}
          selected={picked}
          onToggle={toggle}
          max={spots}
          footer={error ? <ErrorText>{error}</ErrorText> : spotsLeftFooter(spots - picked.length)}
          empty={friends.length === 0 ? NO_FRIENDS : 'All your friends are in or invited.'}
        />
      ) : (
        <Loading />
      )}
    </Screen>
  )
}
