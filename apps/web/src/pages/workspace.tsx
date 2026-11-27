import { useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { AuthLayout, Field, ProblemNotice, useSubmit } from '../components/ui';
import { api, ApiError, Organisation } from '../lib/api';
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

function OverviewIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </svg>
  );
}

export function WorkspacePage() {
  const { orgId = '' } = useParams();
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const [org, setOrg] = useState<Organisation | undefined>();
  const [error, setError] = useState<ApiError | undefined>();

  useEffect(() => {
    setOrg(undefined);
    setError(undefined);
    api.getOrg(orgId).then(setOrg, (e) => setError(e instanceof ApiError ? e : undefined));
  }, [orgId]);

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar__product">WatchersNex</div>
        <div className="sidebar__org">
          <small>Organisation</small>
          <span>{org?.name ?? '…'}</span>
        </div>
        {/* Only modules that exist are shown (decision DL-005). */}
        <nav className="nav">
          <NavLink to={`/o/${orgId}`} end>
            <OverviewIcon /> Overview
          </NavLink>
        </nav>
        <div className="sidebar__user">
          <div>
            <strong>{user?.name}</strong>
            <small>{user?.email}</small>
          </div>
          <button
            className="button"
            onClick={async () => {
              await signOut();
              navigate('/sign-in', { replace: true });
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        {error ? (
          <ProblemNotice error={error} />
        ) : !org ? (
          <p aria-live="polite">Loading…</p>
        ) : (
          <>
            <div className="page-header">
              <div>
                <h1>Overview</h1>
                <p>Health of every service in {org.name}.</p>
              </div>
              <span className="badge">Staging build</span>
            </div>

            <section className="panel empty" aria-labelledby="empty-title">
              <svg className="empty__mark" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="6" y="10" width="36" height="28" rx="6" />
                <path d="M12 28h6l4-8 5 12 4-6h5" />
              </svg>
              <h2 id="empty-title">No services monitored yet</h2>
              <p>
                Website and API monitoring is the next part of WatchersNex to be built. When it arrives, you'll add your first service here and
                see its status, response time and incidents on this page.
              </p>
            </section>

            <div className="facts">
              <div className="fact"><small>Your role</small><strong style={{ textTransform: 'capitalize' }}>{org.role}</strong></div>
              <div className="fact"><small>Plan</small><strong style={{ textTransform: 'capitalize' }}>{org.plan_id}</strong></div>
              <div className="fact"><small>Organisation address</small><strong>{org.slug}</strong></div>
              <div className="fact"><small>Created</small><strong>{new Date(org.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</strong></div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
