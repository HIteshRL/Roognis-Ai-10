import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { ErrorNotice, Icon, Spinner } from '../components/ui.jsx'

// Teacher-portal extraction: this build only ever serves role === "teacher".
// Teacher accounts are provisioned by school administrators (not self-service),
// so unlike the monorepo's shared Login.jsx, this trimmed version is sign-in
// only — no signup form, no role picker, no student/parent demo entries.
// Their destination routes (/guardian, /today, etc.) were not imported into
// this app's App.tsx, so offering them here would dead-end in a redirect loop.
//
// Resynced 2026-09-17: the monorepo's Login.jsx grew a signin/signup mode
// switch with a student/parent self-service signup flow (`api.register`) and
// `destinationFor()` role-based routing. The signup flow's own role picker
// still disables "Teacher" with the same "Teacher accounts are created by
// school administrators" copy this trim has always used — confirming the
// no-self-service-for-teachers assumption still holds — so the sign-in-only
// trim below still applies verbatim; only the surrounding sign-in code
// (unchanged upstream) needed re-copying. The monorepo also dropped its old
// "Demo access" quick-login section entirely (all roles, not just
// student/parent), so this rebuilt version follows suit rather than
// reintroducing a teacher-only demo button upstream chose to remove — the
// seeded teacher@demo.com / demo1234 credentials still work through the
// ordinary sign-in form (see root CLAUDE.md).
const INITIAL_FORM = { email: '', password: '' }

function validate(form) {
  const email = form.email.trim()
  if (!email) return 'Enter your email address.'
  if (!/^\S+@\S+\.\S+$/.test(email)) return 'Enter a valid email address.'
  if (!form.password) return 'Enter your password.'
  return ''
}

export default function Login() {
  const { login } = useAuth()
  const nav = useNavigate()
  const [form, setForm] = useState(INITIAL_FORM)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const setField = (event) => {
    const { name, value } = event.target
    setForm((current) => ({ ...current, [name]: value }))
    if (error) setError('')
  }

  const submit = async (event) => {
    event.preventDefault()
    const validationError = validate(form)
    if (validationError) {
      setError(validationError)
      return
    }

    setBusy('submit')
    setError('')
    try {
      await login(form.email.trim().toLowerCase(), form.password)
      nav('/classes', { replace: true })
    } catch (requestError) {
      setError(requestError?.message || 'Sign-in failed.')
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
          <p className="ui-eyebrow">Your teaching workspace</p>
          <h2 id="login-title">Welcome back</h2>
          <p className="muted login-form-copy">
            Sign in with the email and password connected to your school. Teacher accounts are created by school administrators.
          </p>

          <form className="login-auth-form" onSubmit={submit} noValidate>
            <label className="login-field">
              <span>Email address</span>
              <input name="email" type="email" value={form.email} onChange={setField} autoComplete="email" placeholder="you@school.org" autoFocus />
            </label>
            <label className="login-field">
              <span>Password</span>
              <span className="login-password-field">
                <input name="password" type={inputType} value={form.password} onChange={setField} autoComplete="current-password" placeholder="Your password" />
                <button type="button" className="login-password-toggle" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </span>
            </label>

            <ErrorNotice message={error} />
            <button className="btn btn-primary login-submit" type="submit" disabled={!!busy}>
              {busy === 'submit' ? <Spinner size={17} /> : null}
              Sign in
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
