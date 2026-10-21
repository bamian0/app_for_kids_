// App shell: picks the flow from the auth state (setup, launch, intro, welcome, or the signed-in tabs)
// and crossfades between them. Everything else is navigation stacks and sheets from the design system.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useAuth, useFriendships, useProfiles, useSharedGoals, useShowcaseSync } from './data/api.ts'
import { friendsBadge } from './domain/friends.ts'
import { isConfigured } from './firebase/config.ts'
import { isIOS, isStandalone } from './push/index.ts'
import { NavigationStack, Sheet, TabView, UIProvider } from './ui/index.ts'
import type { Tab } from './ui/index.ts'
import { LaunchScreen, NotConfiguredScreen } from './screens/SystemScreens.tsx'
import { WelcomeScreen } from './screens/auth/WelcomeScreen.tsx'
import { GoalsScreen } from './screens/GoalsScreen.tsx'
import { OverviewScreen } from './screens/OverviewScreen.tsx'
import { SpacesScreen } from './screens/SpacesScreen.tsx'
import { FriendsScreen } from './screens/friends/FriendsScreen.tsx'
import { captureFriendParams, hasGoalTarget, hasPendingFriend } from './screens/friends/links.ts'
import { IntroScreen } from './screens/help/IntroScreen.tsx'
import { hasSeenIntro, markIntroSeen } from './screens/help/introFlag.ts'
import { captureOpenParam, hasOpenTarget } from './screens/components/openTarget.ts'
import { captureJoinParam, hasPendingJoin } from './screens/components/pendingJoin.ts'
import { useNow } from './screens/components/clock.ts'
import { readLocal, writeLocal } from './screens/components/storage.ts'
import './screens/screens.css'

captureJoinParam()
captureOpenParam()
captureFriendParams()

type TabId = 'spaces' | 'overview' | 'goals' | 'friends'

const TAB_KEY = 'tab'

function isTabId(value: string | null): value is TabId {
  return value === 'spaces' || value === 'overview' || value === 'goals' || value === 'friends'
}

/** The tab the app opens on: the last one used on this device, but Spaces for an invite link or a
 *  notification that opens a space, and Friends for a friend link or a shared goal's check-in push. */
function initialTab(): TabId {
  if (hasPendingJoin() || hasOpenTarget()) return 'spaces'
  if (hasPendingFriend() || hasGoalTarget()) return 'friends'
  const saved = readLocal(TAB_KEY)
  return isTabId(saved) ? saved : 'spaces'
}

export default function App() {
  return <UIProvider>{isConfigured ? <Session /> : <NavigationStack root={<NotConfiguredScreen />} />}</UIProvider>
}

function Session() {
  const auth = useAuth()
  // The intro, once per device: signed out it comes before Welcome, signed in it covers the tabs.
  const [intro, setIntro] = useState(() => !hasSeenIntro())
  const finishIntro = useCallback(() => {
    markIntroSeen()
    setIntro(false)
  }, [])
  // The Home Screen app starts with its own empty storage, but it can only be added from a Safari tab,
  // which already played the intro: signed out there it goes straight to Welcome, and counts as seen.
  const skipIntro = auth.status === 'signedOut' && isIOS() && isStandalone()
  const showIntro = intro && !skipIntro
  useEffect(() => {
    if (intro && skipIntro) finishIntro()
  }, [intro, skipIntro, finishIntro])
  // A new key per account resets navigation, so nobody lands inside someone else's screens.
  const key = auth.status === 'signedIn' ? `in:${auth.uid}` : auth.status === 'signedOut' && showIntro ? 'intro' : auth.status
  return (
    <AnimatePresence initial={false}>
      <motion.div
        key={key}
        className="s-root"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
      >
        {auth.status === 'loading' ? (
          <LaunchScreen />
        ) : auth.status === 'signedOut' ? (
          showIntro ? <IntroScreen onDone={finishIntro} /> : <NavigationStack root={<WelcomeScreen />} />
        ) : (
          <SignedIn intro={intro} onIntroDone={finishIntro} />
        )}
      </motion.div>
    </AnimatePresence>
  )
}

function SignedIn({ intro, onIntroDone }: { intro: boolean; onIntroDone: () => void }) {
  const [tab, setTab] = useState<TabId>(initialTab)
  // Someone already signed in sees the intro once, as a cover. An invite link, a friend link or a notification
  // goes straight to where it points instead, and the intro waits for the next launch.
  const [cover] = useState(() => intro && !hasPendingJoin() && !hasOpenTarget() && !hasPendingFriend() && !hasGoalTarget())
  // Keeps the showcase's money copies in step with your money (SPEC §11.8): once, for the whole signed-in app.
  useShowcaseSync()
  const badge = useFriendsBadge()
  const select = useCallback((id: TabId) => {
    setTab(id)
    writeLocal(TAB_KEY, id)
  }, [])
  const tabs = useMemo<Tab<TabId>[]>(
    () => [
      { id: 'spaces', title: 'Spaces', icon: 'squareStack', root: <SpacesScreen /> },
      { id: 'overview', title: 'Overview', icon: 'chartBar', root: <OverviewScreen /> },
      { id: 'goals', title: 'Goals', icon: 'target', root: <GoalsScreen /> },
      { id: 'friends', title: 'Friends', icon: 'person2', root: <FriendsScreen />, badge },
    ],
    [badge],
  )
  return (
    <>
      <TabView tabs={tabs} selected={tab} onSelect={select} />
      <Sheet open={cover && intro} onClose={onIntroDone} presentation="fullScreen" aria-label="Introduction">
        <IntroScreen onDone={onIntroDone} />
      </Sheet>
    </>
  )
}

/** The Friends tab's badge: incoming requests from people who still have a profile, plus open shared-goal
 *  invitations (not to finished or ended goals), as friendsBadge counts them (SPEC §11.2). */
function useFriendsBadge(): number {
  const nowMs = useNow()
  const friendships = useFriendships().data
  const shared = useSharedGoals().data
  const profiles = useProfiles(friendships?.incoming.map((p) => p.uid) ?? [])
  const view = useMemo(() => (friendships ? { ...friendships, incoming: friendships.incoming.filter((p) => profiles[p.uid]) } : undefined), [friendships, profiles])
  return friendsBadge(view, shared, nowMs)
}
