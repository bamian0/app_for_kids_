// Text input: bare fields, list-row fields, secure fields, and an auto-growing text area.
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { InputHTMLAttributes, Ref, TextareaHTMLAttributes } from 'react'
import { Icon } from './icons.tsx'
import { cx } from './press.ts'
import './fields.css'

type NativeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'size' | 'type'>

export interface TextFieldProps extends NativeInputProps {
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'email' | 'password' | 'search' | 'tel' | 'url' | 'number'
  /** plain: borderless, for list rows and custom layouts. filled: standalone rounded field. */
  variant?: 'plain' | 'filled'
  /** Show the ⓧ clear button while focused with text (default true, off for passwords). */
  clearable?: boolean
  inputRef?: Ref<HTMLInputElement>
}

export function TextField({ value, onChange, type = 'text', variant = 'plain', clearable, inputRef, className, onFocus, onBlur, ...rest }: TextFieldProps) {
  const [focused, setFocused] = useState(false)
  const localRef = useRef<HTMLInputElement | null>(null)
  const canClear = (clearable ?? type !== 'password') && focused && value.length > 0 && !rest.disabled && !rest.readOnly

  const setRefs = (el: HTMLInputElement | null) => {
    localRef.current = el
    if (typeof inputRef === 'function') inputRef(el)
    else if (inputRef) inputRef.current = el
  }

  return (
    <span className={cx('ui-field', `ui-field--${variant}`, className)}>
      <input
        {...rest}
        ref={setRefs}
        type={type}
        value={value}
        className="ui-field__input"
        onChange={(e) => onChange(e.currentTarget.value)}
        onFocus={(e) => {
          setFocused(true)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setFocused(false)
          onBlur?.(e)
        }}
      />
      {canClear && (
        <button
          type="button"
          className="ui-field__clear"
          aria-label="Clear text"
          tabIndex={-1}
          // Keep focus (and the keyboard) in the field.
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange('')
            localRef.current?.focus()
          }}
        >
          <Icon name="xmarkCircleFill" size={18} />
        </button>
      )}
    </span>
  )
}

export interface SecureFieldProps extends Omit<TextFieldProps, 'type'> {
  /** 'current-password' (default) for sign-in, 'new-password' for sign-up. */
  autoComplete?: 'current-password' | 'new-password'
}

export function SecureField({ autoComplete = 'current-password', ...props }: SecureFieldProps) {
  return <TextField {...props} type="password" autoComplete={autoComplete} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
}

export interface TextFieldRowProps extends TextFieldProps {
  /** Optional leading label, like iOS form rows ("Name"). */
  label?: string
  /** Width of the label column so stacked rows align (default 96px). */
  labelWidth?: number
}

/** A TextField laid out as a list row (place inside a Section). */
export function TextFieldRow({ label, labelWidth = 96, id, className, ...props }: TextFieldRowProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <div className={cx('ui-row ui-row--field', className)}>
      <span className="ui-row__main">
        {label && (
          <label htmlFor={fieldId} className="ui-row__field-label" style={{ width: labelWidth }}>
            {label}
          </label>
        )}
        <TextField {...props} id={fieldId} variant="plain" />
      </span>
    </div>
  )
}

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string
  onChange: (value: string) => void
  /** plain: list-row padding (inside a Section). filled: standalone rounded field. */
  variant?: 'plain' | 'filled'
  minRows?: number
  maxRows?: number
  textareaRef?: Ref<HTMLTextAreaElement>
}

const LINE = 22

/** Grows with its content between minRows and maxRows, then scrolls. */
export function TextArea({ value, onChange, variant = 'plain', minRows = 1, maxRows = 8, textareaRef, className, style, ...rest }: TextAreaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const cs = getComputedStyle(el)
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    const min = minRows * LINE + pad
    const max = maxRows * LINE + pad
    const next = Math.min(max, Math.max(min, el.scrollHeight))
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [value, minRows, maxRows])

  const setRefs = (el: HTMLTextAreaElement | null) => {
    ref.current = el
    if (typeof textareaRef === 'function') textareaRef(el)
    else if (textareaRef) textareaRef.current = el
  }

  return (
    <textarea
      {...rest}
      ref={setRefs}
      rows={minRows}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      className={cx('ui-textarea', `ui-textarea--${variant}`, className)}
      style={style}
    />
  )
}
