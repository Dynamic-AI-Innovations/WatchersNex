import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import { ProblemNotice } from '../components/ui';
import { api, ApiError, Organisation } from '../lib/api';
import { useSession } from '../lib/session';
import { SHOW_PREVIEW_MODULES } from './preview';

export interface OrgContext {
  org: Organisation;
  canManage: boolean;
  canRespond: boolean;
}

export function useOrg(): OrgContext {
  return useOutletContext<OrgContext>();
}

/* Outline icons, 1.75 px stroke, rounded joins (brand guide, iconography). */
const ICONS: Record<string, string> = {
  overview: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  services: 'M4 6h16M4 12h16M4 18h16',
  observability: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  dependencies: 'M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M18 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7.5 7.5 11 16M16.5 7.5 13 16',
  incidents: 'M12 3l9 16H3l9-16zM12 10v4M12 17v.5',
  slos: 'M12 21a9 9 0 1 1 9-9M12 12l6-6M16 12h5',
  reports: 'M6 3h9l4 4v14H6zM9 12h6M9 16h6',
  automation: 'M13 2 4 14h7l-1 8 9-12h-7z',
  integrations: 'M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20.6 9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 2z',
};

const NAV: Array<{ path: string; label: string; icon: string; preview?: boolean }> = [
  { path: '', label: 'Overview', icon: 'overview' },
  { path: 'services', label: 'Services', icon: 'services' },
  { path: 'observability', label: 'Observability', icon: 'observability', preview: true },
  { path: 'dependencies', label: 'Dependencies', icon: 'dependencies', preview: true },
  { path: 'incidents', label: 'Incidents', icon: 'incidents' },
  { path: 'slos', label: 'SLOs & Reliability', icon: 'slos', preview: true },
  { path: 'reports', label: 'Reports', icon: 'reports' },
  { path: 'automation', label: 'Automation', icon: 'automation', preview: true },
  { path: 'integrations', label: 'Integrations', icon: 'integrations', preview: true },
  { path: 'settings', label: 'Settings', icon: 'settings' },
];

function NavIcon({ name }: { name: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
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
  const items = NAV.filter((n) => SHOW_PREVIEW_MODULES || !n.preview);

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar__product">WatchersNex</div>
        <div className="sidebar__org">
          <small>Organisation</small>
          <span>{org?.name ?? '…'}</span>
        </div>
        <nav className="nav">
          {items.map((n) => (
            <NavLink key={n.label} to={`/o/${orgId}${n.path ? `/${n.path}` : ''}`} end={!n.path}>
              <NavIcon name={n.icon} />
              <span className="nav__label">{n.label}</span>
              {n.preview && <span className="nav__tag">Preview</span>}
            </NavLink>
          ))}
        </nav>
        <nav className="mobile-nav" aria-label="Sections">
          {items.map((n) => (
            <NavLink key={n.label} to={`/o/${orgId}${n.path ? `/${n.path}` : ''}`} end={!n.path}>{n.label}</NavLink>
          ))}
        </nav>
        <div className="sidebar__user">
          <Link to={`/o/${orgId}/account`} className="sidebar__account">
            <strong>{user?.name}</strong>
            <small>{user?.email}</small>
          </Link>
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
