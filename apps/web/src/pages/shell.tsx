import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import { ProblemNotice } from '../components/ui';
import { api, ApiError, Organisation } from '../lib/api';
import { useSession } from '../lib/session';

export interface OrgContext {
  org: Organisation;
  canManage: boolean;
  canRespond: boolean;
}

export function useOrg(): OrgContext {
  return useOutletContext<OrgContext>();
}

const ICONS = {
  overview: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  services: 'M4 6h16M4 12h16M4 18h16',
  incidents: 'M12 3l9 16H3l9-16zM12 10v4M12 17v.5',
};

function NavIcon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** Authenticated app shell: sidebar navigation plus the current page. */
export function OrgShell() {
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

  const context: OrgContext | undefined = org && {
    org,
    canManage: org.role === 'owner' || org.role === 'admin',
    canRespond: org.role !== 'viewer',
  };

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
          <NavLink to={`/o/${orgId}`} end><NavIcon d={ICONS.overview} /> Overview</NavLink>
          <NavLink to={`/o/${orgId}/services`}><NavIcon d={ICONS.services} /> Services</NavLink>
          <NavLink to={`/o/${orgId}/incidents`}><NavIcon d={ICONS.incidents} /> Incidents</NavLink>
        </nav>
        <nav className="mobile-nav" aria-label="Sections">
          <NavLink to={`/o/${orgId}`} end>Overview</NavLink>
          <NavLink to={`/o/${orgId}/services`}>Services</NavLink>
          <NavLink to={`/o/${orgId}/incidents`}>Incidents</NavLink>
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
        {error ? <ProblemNotice error={error} /> : context ? <Outlet context={context} /> : <p aria-live="polite">Loading…</p>}
      </main>
    </div>
  );
}
