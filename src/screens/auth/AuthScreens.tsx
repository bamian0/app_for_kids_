// Sign up, sign in and password reset. Navigation after success comes from useAuth flipping to
// signedIn (App swaps the whole stack), so these screens only handle input and errors.
import { useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, RefObject } from 'react'
import { sendPasswordReset, signIn, signUp } from '../../data/api.ts'
import { errorCode } from '../../data/errors.ts'
import { Button, EmptyState, Section, Screen, TextFieldRow, useNav } from '../../ui/index.ts'
import { ErrorText } from '../components/Bits.tsx'

const LABEL_WIDTH = 92

function message(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Try again.'
}

/** Sign-up failed because the email already has an account (the data layer keeps Firebase's error as the cause). */
function emailTaken(e: unknown): boolean {
  return e instanceof Error && errorCode(e.cause) === 'auth/email-already-in-use'
}

/** Return in a field moves to the next one instead of submitting early. */
function nextOnEnter(next: RefObject<HTMLInputElement | null>) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    next.current?.focus()
  }
}

const emailProps = {
  type: 'email' as const,
  inputMode: 'email' as const,
  autoComplete: 'email',
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
  placeholder: 'you@example.com',
}

const passwordProps = {
  type: 'password' as const,
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
}

export function SignUpScreen() {
  const nav = useNav()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [taken, setTaken] = useState(false)
  const [busy, setBusy] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setTaken(false)
    try {
      await signUp(name, email, password)
      // Stay busy: the signed-in app replaces this screen in a moment.
    } catch (err) {
      const isTaken = emailTaken(err)
      setTaken(isTaken)
      setError(isTaken ? null : message(err))
      setBusy(false)
    }
  }

  return (
    <Screen title="Create Account" subtitle="Your friends will see your name. Never your email.">
      <form onSubmit={submit} noValidate>
        <Section
          footer={
            taken ? <ErrorText>This email already has an account. Sign in with it instead.</ErrorText> : error ? <ErrorText>{error}</ErrorText> : 'At least 6 characters for the password.'
          }
        >
          <TextFieldRow
            label="Name"
            labelWidth={LABEL_WIDTH}
            value={name}
            onChange={setName}
            placeholder="First and last"
            autoComplete="name"
            autoCapitalize="words"
            enterKeyHint="next"
            maxLength={40}
            onKeyDown={nextOnEnter(emailRef)}
          />
          <TextFieldRow
            label="Email"
            labelWidth={LABEL_WIDTH}
            value={email}
            onChange={(v) => {
              setEmail(v)
              setTaken(false)
            }}
            {...emailProps}
            enterKeyHint="next"
            inputRef={emailRef}
            onKeyDown={nextOnEnter(passwordRef)}
          />
          <TextFieldRow
            label="Password"
            labelWidth={LABEL_WIDTH}
            value={password}
            onChange={setPassword}
            {...passwordProps}
            autoComplete="new-password"
            placeholder="Required"
            enterKeyHint="go"
            inputRef={passwordRef}
          />
        </Section>
        <div className="s-form-actions">
          {taken ? (
            <Button size="large" fullWidth onClick={() => nav.push(<SignInScreen initialEmail={email.trim()} />, { title: 'Sign In' })}>
              Sign In Instead
            </Button>
          ) : (
            <Button type="submit" size="large" fullWidth loading={busy}>
              Create Account
            </Button>
          )}
        </div>
      </form>
    </Screen>
  )
}

export function SignInScreen({ initialEmail = '' }: { initialEmail?: string }) {
  const nav = useNav()
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }

  return (
    <Screen title="Sign In" subtitle="Welcome back.">
      <form onSubmit={submit} noValidate>
        <Section footer={error ? <ErrorText>{error}</ErrorText> : undefined}>
          <TextFieldRow label="Email" labelWidth={LABEL_WIDTH} value={email} onChange={setEmail} {...emailProps} enterKeyHint="next" onKeyDown={nextOnEnter(passwordRef)} />
          <TextFieldRow
            label="Password"
            labelWidth={LABEL_WIDTH}
            value={password}
            onChange={setPassword}
            {...passwordProps}
            autoFocus={!!initialEmail}
            autoComplete="current-password"
            placeholder="Required"
            enterKeyHint="go"
            inputRef={passwordRef}
          />
        </Section>
        <div className="s-form-actions">
          <Button type="submit" size="large" fullWidth loading={busy}>
            Sign In
          </Button>
          <Button variant="plain" fullWidth onClick={() => nav.push(<ForgotPasswordScreen initialEmail={email} />, { title: 'Reset Password' })}>
            Forgot Password?
          </Button>
        </div>
      </form>
    </Screen>
  )
}

function ForgotPasswordScreen({ initialEmail }: { initialEmail: string }) {
  const nav = useNav()
  const [email, setEmail] = useState(initialEmail)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await sendPasswordReset(email)
      setSentTo(email.trim())
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  if (sentTo) {
    return (
      <Screen title="Reset Password" titleDisplay="inline">
        <EmptyState
          icon="envelope"
          title="Check your email"
          message={`If ${sentTo} has an account, a link is on its way.`}
          action={<Button onClick={nav.pop}>Back to Sign In</Button>}
        />
      </Screen>
    )
  }

  return (
    <Screen title="Reset Password" subtitle="We’ll email you a link to set a new one.">
      <form onSubmit={submit} noValidate>
        <Section footer={error ? <ErrorText>{error}</ErrorText> : undefined}>
          <TextFieldRow label="Email" labelWidth={LABEL_WIDTH} value={email} onChange={setEmail} {...emailProps} enterKeyHint="send" autoFocus={!initialEmail} />
        </Section>
        <div className="s-form-actions">
          <Button type="submit" size="large" fullWidth loading={busy}>
            Send Reset Link
          </Button>
        </div>
      </form>
    </Screen>
  )
}
