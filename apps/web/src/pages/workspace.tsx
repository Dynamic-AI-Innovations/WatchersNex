import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AuthLayout, Field, ProblemNotice, useSubmit } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

export function CreateOrganisationPage() {
  const navigate = useNavigate();
  const { refresh, user } = useSession();
  const [name, setName] = useState('');
  const { submit, pending, error } = useSubmit(
    () => api.createOrg({ name }),
    async (org) => {
      await refresh();
      navigate(`/o/${org.id}`, { replace: true });
    },
  );

  return (
    <AuthLayout>
      <h1>Set up your organisation</h1>
      <p className="lede">
        {user ? `Hi ${user.name.split(' ')[0]}. ` : ''}Your organisation holds your services, team and reports. You can invite teammates later.
      </p>
      <form className="form" onSubmit={submit} noValidate>
        {error && error.code !== 'validation' && <ProblemNotice error={error} />}
        <Field label="Organisation name" autoComplete="organization" required value={name} onChange={(e) => setName(e.target.value)} error={error?.fieldError('name') ?? error?.fieldError('slug')} hint="For example, your company or team name." />
        <button className="button button--primary button--block" disabled={pending}>{pending ? 'Creating…' : 'Create organisation'}</button>
      </form>
    </AuthLayout>
  );
}
