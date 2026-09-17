import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { api } from '../api/client'
import { ErrorNotice, useToast, Icon, Spinner } from '../components/ui.jsx'

// The local demo database uses the stable school id below. Deployments can
// override it with VITE_DEMO_SCHOOL_ID without changing the form contract.
const DEMO_SCHOOL_ID = import.meta.env.VITE_DEMO_SCHOOL_ID || (import.meta.env.DEV ? '22222222-2222-2222-2222-222222222222' : '')

const INITIAL_FORM = {
  name: '',
  email: '',
  password: '',
  confirmPassword: '',
  role: 'parent',
  schoolId: DEMO_SCHOOL_ID,
}

function destinationFor() {
  return '/guardian'
}

function validate(form, mode) {
  const email = form.email.trim()
  if (!email) return 'Enter your email address.'
  if (!/^\S+@\S+\.\S+$/.test(email)) return 'Enter a valid email address.'
  if (!form.password) return 'Enter your password.'
  if (mode === 'signin') return ''
  if (!form.name.trim()) return 'Enter your name.'
  if (form.name.trim().length < 2) return 'Your name must be at least 2 characters.'
  if (form.password.length < 10) return 'Use a password with at least 10 characters.'
  if (form.password !== form.confirmPassword) return 'The passwords do not match.'
  if (form.role !== 'parent') return 'This workspace only supports guardian accounts.'
  if (!form.schoolId.trim()) return 'Enter the school code provided by your school.'
  return ''
}

export default function Login() {
  const { login } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const [mode, setMode] = useState('signin')
  const [form, setForm] = useState(INITIAL_FORM)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const setField = (event) => {
    const { name, value } = event.target
    setForm((current) => ({ ...current, [name]: value }))
    if (error) setError('')
  }

  const switchMode = (nextMode) => {
    setMode(nextMode)
    // Never carry a password between account modes. This prevents an
    // accidental submit with stale credentials.
    setForm((current) => ({ ...INITIAL_FORM, role: current.role, schoolId: current.schoolId }))
    setError('')
    setShowPassword(false)
  }

  const submit = async (event) => {
    event.preventDefault()
    const validationError = validate(form, mode)
    if (validationError) {
      setError(validationError)
      return
    }

    setBusy('submit')
    setError('')
    try {
      if (mode === 'signup') {
        await api.register({
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          password: form.password,
          role: form.role,
          schoolId: form.schoolId.trim(),
        })
      }
      const user = await login(form.email.trim().toLowerCase(), form.password)
      if (mode === 'signup') toast.success('Account created. You’re signed in.')
      nav(destinationFor(user), { replace: true })
    } catch (requestError) {
      setError(requestError?.message || (mode === 'signup' ? 'We could not create your account.' : 'Sign-in failed.'))
    } finally {
      setBusy('')
    }
  }

  const inputType = showPassword ? 'text' : 'password'

  return (
    <div className="login-screen">
      <section className="login-brand-panel" aria-label="Roognis introduction">
        <div className="login-atmosphere" aria-hidden="true">
          <span className="login-orbit login-orbit-a" />
          <span className="login-orbit login-orbit-b" />
          <span className="login-node login-node-a" />
          <span className="login-node login-node-b" />
          <span className="login-node login-node-c" />
        </div>
        <div className="login-brand-lockup">
          <span className="login-brand-mark" aria-hidden="true">R</span>
          <strong>Roognis</strong>
        </div>
        <div className="login-brand-copy">
          <p className="ui-eyebrow">A living learning workspace</p>
          <h1>The classroom, reimagined for every learner.</h1>
          <p>
            Classes, coursework, a live stream, gradebook and guardian summaries — all
            in one place, powered by Roognis’ adaptive tutoring engine.
          </p>
        </div>
        <div className="login-capabilities" aria-label="Workspace capabilities">
          <span><Icon name="book" size={16} /> Classwork &amp; rubrics</span>
          <span><Icon name="inbox" size={16} /> Class stream</span>
          <span><Icon name="insights" size={16} /> Gradebook</span>
        </div>
      </section>

      <section className="login-form-panel" aria-labelledby="login-title">
        <div className="login-form-inner">
          <p className="ui-eyebrow">Your guardian workspace</p>
          <h2 id="login-title">{mode === 'signin' ? 'Welcome back' : 'Create your account'}</h2>
          <p className="muted login-form-copy">
            {mode === 'signin' ? 'Sign in with the email and password connected to your school.' : 'Set up your guardian account in a few clear steps.'}
          </p>

          <div className="login-mode-switch" role="tablist" aria-label="Account access">
            <button type="button" role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'is-active' : ''} onClick={() => switchMode('signin')}>
              Sign in
            </button>
            <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'is-active' : ''} onClick={() => switchMode('signup')}>
              Create account
            </button>
          </div>

          <form className="login-auth-form" onSubmit={submit} noValidate>
            {mode === 'signup' ? (
              <label className="login-field">
                <span>Your name</span>
                <input name="name" value={form.name} onChange={setField} autoComplete="name" placeholder="e.g. Arjun Mehta" autoFocus />
              </label>
            ) : null}
            <label className="login-field">
              <span>Email address</span>
              <input name="email" type="email" value={form.email} onChange={setField} autoComplete="email" placeholder="you@school.org" autoFocus={mode === 'signin'} />
            </label>
            <label className="login-field">
              <span>Password</span>
              <span className="login-password-field">
                <input name="password" type={inputType} value={form.password} onChange={setField} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} placeholder={mode === 'signin' ? 'Your password' : 'At least 10 characters'} />
                <button type="button" className="login-password-toggle" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </span>
            </label>

            {mode === 'signup' ? (
              <>
                <label className="login-field">
                  <span>Confirm password</span>
                  <input name="confirmPassword" type={inputType} value={form.confirmPassword} onChange={setField} autoComplete="new-password" placeholder="Type it again" />
                </label>
                <label className="login-field">
                  <span>School code / ID</span>
                  <input name="schoolId" value={form.schoolId} onChange={setField} autoComplete="organization" placeholder="Code or ID provided by your school" />
                  <span className="login-helper">For this local demo, the prefilled ID points to the demo school. Replace it with your school’s code or ID when needed.</span>
                </label>
              </>
            ) : null}

            <ErrorNotice message={error} />
            <button className="btn btn-primary login-submit" type="submit" disabled={!!busy}>
              {busy === 'submit' ? <Spinner size={17} /> : null}
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <p className="tiny faint center login-contract-note">
            Sessions use the same cookie-JWT contract as the Auth Service (`/api/auth`).
          </p>
        </div>
      </section>
    </div>
  )
}
