// Full-page states outside the normal flow: the launch placeholder and the "not configured" notice.
import { EmptyState, Screen } from '../ui/index.ts'
import { Loading } from './components/Bits.tsx'

/** Shown while the saved session is restored (usually a blink). */
export function LaunchScreen() {
  return (
    <div className="s-launch">
      <Loading label="Starting" />
    </div>
  )
}

export function NotConfiguredScreen() {
  return (
    <Screen title="Stakes">
      <EmptyState
        icon="gear"
        title="Almost there."
        message={
          <>
            Firebase isn’t connected yet. Paste the web app config into <code className="s-code">src/firebase/config.ts</code> and deploy again.
          </>
        }
      />
    </Screen>
  )
}
