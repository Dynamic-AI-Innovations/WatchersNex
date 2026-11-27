import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AuthLayout, Field, Notice, ProblemNotice, useSubmit } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

/** Only same-site relative paths are accepted as a return destination (no open redirect). */
function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

export function SignInPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resent, setResent] = useState(false);
  const { submit, pending, error } = useSubmit(
    () => api.login({ email, password }),
    async () => {
      await refresh();
      navigate(next, { replace: true });
    },
  );

  return (
    <AuthLayout>
      <h1>Sign in</h1>
      <p className="lede">Welcome back. Sign in to your workspace.</p>
      <form className="form" onSubmit={submit} noValidate>
        {error && error.code !== 'validation' && <ProblemNotice error={error} />}
        {error?.code === 'email-not-verified' && !resent && (
          <button type="button" className="button button--secondary" onClick={async () => { await api.resendVerification(email).catch(() => undefined); setResent(true); }}>
            Send a new verification link
          </button>
        )}
        {resent && <Notice kind="success">If that account needs verifying, a new link is on its way.</Notice>}
        <Field label="Email address" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={error?.fieldError('email')} />
        <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={error?.fieldError('password')} />
        <button className="button button--primary button--block" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="auth__alt">
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
      <p className="auth__alt">
        New to WatchersNex? <Link to={next === '/' ? '/sign-up' : `/sign-up?next=${encodeURIComponent(next)}`}>Create an account</Link>
      </p>
    </AuthLayout>
  );
}

export function SignUpPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [form, setForm] = useState({ name: '', email: params.get('email') ?? '', password: '' });
  const { submit, pending, error } = useSubmit(
    () => api.register(form),
    () => navigate(next === '/' ? '/check-email' : `/check-email?next=${encodeURIComponent(next)}`),
  );
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  return (
    <AuthLayout>
      <h1>Create your account</h1>
      <p className="lede">Start monitoring your websites and APIs.</p>
      <form className="form" onSubmit={submit} noValidate>
        {error && error.code !== 'validation' && <ProblemNotice error={error} />}
        <Field label="Full name" autoComplete="name" required value={form.name} onChange={set('name')} error={error?.fieldError('name')} />
        <Field label="Work email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} error={error?.fieldError('email')} />
        <Field label="Password" type="password" autoComplete="new-password" required minLength={10} value={form.password} onChange={set('password')} hint="At least 10 characters. A short phrase works well." error={error?.fieldError('password')} />
        <button className="button button--primary button--block" disabled={pending}>
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="auth__alt">
        Already have an account? <Link to={next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`}>Sign in</Link>
      </p>
    </AuthLayout>
  );
}

export function CheckEmailPage() {
  return (
    <AuthLayout>
      <h1>Check your email</h1>
      <p className="lede">If the details are valid, we have sent a link to confirm your email address. It works for 24 hours.</p>
      <Notice kind="info" title="Staging build">
        Email delivery isn't switched on in staging yet. Ask the WatchersNex team for your verification link.
      </Notice>
      <p className="auth__alt">
        <Link to="/sign-in">Back to sign in</Link>
      </p>
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // React strict mode runs effects twice in development
    started.current = true;
    api.verifyEmail(token).then(() => setState('done'), () => setState('failed'));
  }, [token]);

  return (
    <AuthLayout>
      <h1>Verify your email</h1>
      {state === 'working' && <p className="lede">Confirming your email address…</p>}
      {state === 'done' && (
        <>
          <Notice kind="success" title="Email verified">Your account is ready.</Notice>
          <p className="auth__alt"><Link to="/sign-in">Sign in</Link></p>
        </>
      )}
      {state === 'failed' && (
        <>
          <Notice kind="error" title="Link not valid">This link is invalid or has expired. Sign in to request a new one.</Notice>
          <p className="auth__alt"><Link to="/sign-in">Go to sign in</Link></p>
        </>
      )}
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { submit, pending, error } = useSubmit(() => api.forgotPassword(email), () => setSent(true));

  return (
    <AuthLayout>
      <h1>Reset your password</h1>
      <p className="lede">Enter your email and we'll send a link to choose a new password.</p>
      {sent ? (
        <Notice kind="success" title="Check your email">If an account exists for that address, a reset link is on its way. It works for 30 minutes.</Notice>
      ) : (
        <form className="form" onSubmit={submit} noValidate>
          {error && error.code !== 'validation' && <ProblemNotice error={error} />}
          <Field label="Email address" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={error?.fieldError('email')} />
          <button className="button button--primary button--block" disabled={pending}>{pending ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}
      <p className="auth__alt"><Link to="/sign-in">Back to sign in</Link></p>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const { submit, pending, error } = useSubmit(() => api.resetPassword(params.get('token') ?? '', password), () => setDone(true));

  return (
    <AuthLayout>
      <h1>Choose a new password</h1>
      {done ? (
        <>
          <Notice kind="success" title="Password changed">You've been signed out everywhere. Sign in with your new password.</Notice>
          <p className="auth__alt"><Link to="/sign-in">Sign in</Link></p>
        </>
      ) : (
        <form className="form" onSubmit={submit} noValidate>
          <p className="lede">Choose a password of at least 10 characters.</p>
          {error && error.code !== 'validation' && <ProblemNotice error={error} />}
          <Field label="New password" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} error={error?.fieldError('password') ?? error?.fieldError('token')} />
          <button className="button button--primary button--block" disabled={pending}>{pending ? 'Saving…' : 'Save new password'}</button>
        </form>
      )}
    </AuthLayout>
  );
}
