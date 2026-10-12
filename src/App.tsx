// App shell: picks the flow from the auth state (setup, launch, welcome, or the signed-in tabs) and
// crossfades between them. Everything else is navigation stacks and sheets from the design system.
import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useAuth } from './data/api.ts'
import { isConfigured } from './firebase/config.ts'
import { NavigationStack, TabView, UIProvider } from './ui/index.ts'
import type { Tab } from './ui/index.ts'
import { LaunchScreen, NotConfiguredScreen } from './screens/SystemScreens.tsx'
import { WelcomeScreen } from './screens/auth/WelcomeScreen.tsx'
import { GoalsScreen } from './screens/GoalsScreen.tsx'
import { OverviewScreen } from './screens/OverviewScreen.tsx'
import { SpacesScreen } from './screens/SpacesScreen.tsx'
import { captureOpenParam, hasOpenTarget } from './screens/components/openTarget.ts'
import { captureJoinParam, hasPendingJoin } from './screens/components/pendingJoin.ts'
import { readLocal, writeLocal } from './screens/components/storage.ts'
import './screens/screens.css'

captureJoinParam()
captureOpenParam()

type TabId = 'spaces' | 'overview' | 'goals'

const TAB_KEY = 'tab'

function isTabId(value: string | null): value is TabId {
  return value === 'spaces' || value === 'overview' || value === 'goals'
}

/** The tab the app opens on: the last one used on this device, but Spaces for an invite link or a
 *  notification, since both open a space. */
function initialTab(): TabId {
  if (hasPendingJoin() || hasOpenTarget()) return 'spaces'
  const saved = readLocal(TAB_KEY)
  return isTabId(saved) ? saved : 'spaces'
}

export default function App() {
  return <UIProvider>{isConfigured ? <Session /> : <NavigationStack root={<NotConfiguredScreen />} />}</UIProvider>
}

function Session() {
  const auth = useAuth()
  // A new key per account resets navigation, so nobody lands inside someone else's screens.
  const key = auth.status === 'signedIn' ? `in:${auth.uid}` : auth.status
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
          <NavigationStack root={<WelcomeScreen />} />
        ) : (
          <SignedIn />
        )}
      </motion.div>
    </AnimatePresence>
  )
}

function SignedIn() {
  const [tab, setTab] = useState<TabId>(initialTab)
  const select = useCallback((id: TabId) => {
    setTab(id)
    writeLocal(TAB_KEY, id)
  }, [])
  const tabs = useMemo<Tab<TabId>[]>(
    () => [
      { id: 'spaces', title: 'Spaces', icon: 'squareStack', root: <SpacesScreen /> },
      { id: 'overview', title: 'Overview', icon: 'chartBar', root: <OverviewScreen /> },
      { id: 'goals', title: 'Goals', icon: 'target', root: <GoalsScreen /> },
    ],
    [],
  )
  return <TabView tabs={tabs} selected={tab} onSelect={select} />
}
