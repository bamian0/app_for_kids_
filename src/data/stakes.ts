// Per-person stakes (SPEC §9.7): each member's own terms in spaces/{id}/stakes/{uid}, and each friend's
// Agree inside that doc (agreed.{friend}), which only that friend writes.
import type { PairTerms, Space, StakesMode, StreakTier, UID, MemberStakes } from '../domain/types.ts'
import type { Start } from './store.ts'

/** What the stakes editor saves: your terms, never anyone's agreements. Each line has its own mode. */
export interface StakesInput {
  rewardMode: StakesMode
  penaltyMode: StakesMode
  reward: string
  penalty: string
  per: Record<UID, { reward: string; penalty: string }>
  tiers: StreakTier[]
}

/** Live stakes docs of a space by uid, former members' included. One listener per space. */
export function startStakes(spaceId: string): Start<Record<UID, MemberStakes>> {
  void spaceId
  // batch2: TODO (until built: nobody has set their own stakes, so the house stakes count everywhere)
  return (emit) => {
    emit({ data: {}, loading: false, error: null })
    return () => {}
  }
}

/**
 * Saves your own stakes. Texts trimmed; per-friend entries for people no longer in the space dropped (both
 * texts kept in each entry, '' for a line that isn't per friend); tiers sorted by months. Creates the doc
 * ({…, agreed: {}}) or updates only the terms, never `agreed`. A transaction: fails at once offline. What it
 * means for each friend (who has to agree before it counts) comes from waitingFor in domain/stakes.ts.
 */
export async function saveMyStakes(space: Space, input: StakesInput): Promise<void> {
  void space
  void input
  // batch2: TODO
  throw new Error('not implemented: saveMyStakes')
}

/**
 * Agrees to `owner`'s current terms for you, exactly as you saw them (`seen`): one transaction that writes
 * `agreed.{me}` = { at: serverTimestamp(), terms, past } (nextAgreement in domain/stakes.ts; the previous
 * agreement moves into `past` with its time). It counts at once for the month in progress (SPEC §9.7);
 * agreeOutcome in domain/stakes.ts says whether it already counts or waits for others. Refused with "These
 * stakes just changed. Take another look." when the terms differ from `seen`; resolves without writing when
 * you already agreed to exactly these. Fails at once offline.
 */
export async function agreeToStakes(space: Space, owner: UID, seen: PairTerms): Promise<void> {
  void space
  void owner
  void seen
  // batch2: TODO
  throw new Error('not implemented: agreeToStakes')
}
