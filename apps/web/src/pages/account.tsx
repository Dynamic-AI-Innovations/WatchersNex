import { useState } from 'react';
import { Field, Notice, ProblemNotice, useSubmit } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

export function AccountPage() {
  const { user, refresh } = useSession();
  const [name, setName] = useState(user?.name ?? '');
  const [profileSaved, setProfileSaved] = useState(false);
  const profile = useSubmit(() => api.updateProfile(name), async () => { setProfileSaved(true); await refresh(); });

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);
  const password = useSubmit(() => api.changePassword(current, next), () => { setPasswordSaved(true); setCurrent(''); setNext(''); });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Your account</h1>
          <p>Signed in as {user?.email}.</p>
        </div>
      </div>

      <section className="panel form form--wide">
        <h2>Profile</h2>
        {profileSaved && <Notice kind="success">Name updated.</Notice>}
        {profile.error && profile.error.code !== 'validation' && <ProblemNotice error={profile.error} />}
        <form className="form" onSubmit={profile.submit} noValidate>
          <Field label="Full name" autoComplete="name" value={name} onChange={(e) => { setName(e.target.value); setProfileSaved(false); }} error={profile.error?.fieldError('name')} />
          <Field label="Email address" value={user?.email ?? ''} disabled hint="Email changes aren't available yet." />
          <div className="actions"><button className="button button--primary" disabled={profile.pending}>{profile.pending ? 'Saving…' : 'Save name'}</button></div>
        </form>
      </section>

      <section className="panel form form--wide section">
        <h2>Password</h2>
        {passwordSaved && <Notice kind="success">Password changed. You've been signed out on every other device.</Notice>}
        {password.error && password.error.code !== 'validation' && <ProblemNotice error={password.error} />}
        <form className="form" onSubmit={password.submit} noValidate>
          <Field label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={password.error?.fieldError('currentPassword')} />
          <Field label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} hint="At least 10 characters." error={password.error?.fieldError('newPassword')} />
          <div className="actions"><button className="button button--primary" disabled={password.pending || !current || !next}>{password.pending ? 'Changing…' : 'Change password'}</button></div>
        </form>
      </section>

      <section className="panel section">
        <h2>Two-factor sign-in</h2>
        <p className="muted">An authenticator-app code at sign-in (TOTP). Being built next; required for owners before general availability.</p>
      </section>
    </>
  );
}
