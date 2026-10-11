// App shell: picks the flow from the auth state (setup, launch, welcome, or your spaces) and
// crossfades between them. Everything else is navigation stacks and sheets from the design system.
import { AnimatePresence, motion } from 'motion/react'
import { useAuth } from './data/api.ts'
import { isConfigured } from './firebase/config.ts'
import { NavigationStack, UIProvider } from './ui/index.ts'
import { LaunchScreen, NotConfiguredScreen } from './screens/SystemScreens.tsx'
import { WelcomeScreen } from './screens/auth/WelcomeScreen.tsx'
import { SpacesScreen } from './screens/SpacesScreen.tsx'
import { captureJoinParam } from './screens/components/pendingJoin.ts'
import './screens/screens.css'

captureJoinParam()

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
          <NavigationStack root={<SpacesScreen />} />
        )}
      </motion.div>
    </AnimatePresence>
  )
}
