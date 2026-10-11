// A task title edited in place, like Reminders: wraps onto more lines as it grows, Return commits.
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Ref } from 'react'
import { cx } from '../../ui/index.ts'

export interface TaskTitleInputProps {
  value: string
  onChange: (value: string) => void
  /** Return key. The newline is never inserted. */
  onEnter?: () => void
  onFocus?: () => void
  onBlur?: () => void
  placeholder?: string
  enterKeyHint?: 'done' | 'next' | 'enter'
  disabled?: boolean
  autoFocus?: boolean
  inputRef?: Ref<HTMLTextAreaElement>
  className?: string
  'aria-label'?: string
}

export const MAX_TITLE = 120

function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = '0px'
  el.style.height = `${el.scrollHeight}px`
}

export function TaskTitleInput({ value, onChange, onEnter, onFocus, onBlur, placeholder, enterKeyHint = 'done', disabled, autoFocus, inputRef, className, 'aria-label': ariaLabel }: TaskTitleInputProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    if (ref.current) fitHeight(ref.current)
  }, [value])

  // The width changes too: the delete button appears while editing, the phone rotates.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let width = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      fitHeight(el)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const setRefs = (el: HTMLTextAreaElement | null) => {
    ref.current = el
    if (typeof inputRef === 'function') inputRef(el)
    else if (inputRef) inputRef.current = el
  }

  return (
    <textarea
      ref={setRefs}
      rows={1}
      className={cx('s-title-input', className)}
      value={value}
      placeholder={placeholder}
      maxLength={MAX_TITLE}
      enterKeyHint={enterKeyHint}
      autoCapitalize="sentences"
      disabled={disabled}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.currentTarget.value.replace(/[\r\n]+/g, ' '))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onEnter?.()
        }
      }}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  )
}
