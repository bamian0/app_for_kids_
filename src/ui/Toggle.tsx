import { useId } from 'react'
import { haptic } from './haptics.ts'
import { cx } from './press.ts'
import './toggle.css'

// Safari 17.4+ renders <input type="checkbox" switch> as a real iOS switch (with haptics on iOS 18+).
// Elsewhere we draw an iOS 26-style switch ourselves.
if (typeof document !== 'undefined' && typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype) {
  document.documentElement.classList.add('ui-native-switch')
}

const SWITCH_ATTR = { switch: '' } as object

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  className?: string
}

export function Toggle({ checked, onChange, disabled, id, className, ...aria }: ToggleProps) {
  const autoId = useId()
  return (
    <input
      {...SWITCH_ATTR}
      {...aria}
      id={id ?? autoId}
      type="checkbox"
      role="switch"
      className={cx('ui-toggle', className)}
      checked={checked}
      disabled={disabled}
      onChange={(e) => {
        // The native switch already plays its own haptic on iOS.
        if (!document.documentElement.classList.contains('ui-native-switch')) haptic()
        onChange(e.currentTarget.checked)
      }}
    />
  )
}
