import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { formatDateTime, SeverityBadge, usePolling } from '../components/status';
import { Field, Notice, ProblemNotice, useSubmit } from '../components/ui';
import { AlertPolicy, AlertPolicyInput, api, ApiError, Member, Role, Severity } from '../lib/api';
import { useSession } from '../lib/session';
import { useOrg } from './shell';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including billing, ownership and deleting the organisation',
  admin: 'Services, alert rules, members and the audit log',
  operator: 'Acknowledge, annotate and resolve incidents',
  viewer: 'Read-only access to dashboards, incidents and reports',
};

export function SettingsLayout() {
  const context = useOrg();
  const { org, canManage } = context;
  const tabs = [
    { to: '', label: 'General', show: true },
    { to: 'members', label: 'Members', show: true },
    { to: 'alerts', label: 'Alerts', show: true },
    { to: 'plan', label: 'Plan & usage', show: true },
    { to: 'audit', label: 'Audit log', show: canManage },
  ];
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Organisation, team, alerting and plan for {org.name}.</p>
        </div>
      </div>
      <nav className="tabs" aria-label="Settings sections">
        {tabs.filter((t) => t.show).map((t) => (
          <NavLink key={t.label} to={`/o/${org.id}/settings${t.to ? `/${t.to}` : ''}`} end>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet context={context} />
    </>
  );
}

export function GeneralSettings() {
  const { org } = useOrg();
  const isOwner = org.role === 'owner';
  const [name, setName] = useState(org.name);
  const [timezone, setTimezone] = useState(org.timezone);
  const [saved, setSaved] = useState(false);
  const zones = Intl.supportedValuesOf('timeZone');
  const { submit, pending, error } = useSubmit(() => api.updateOrg(org.id, { name, timezone }), () => setSaved(true));

  return (
    <section className="panel form form--wide">
      <h2>Organisation</h2>
      {!isOwner && <Notice kind="info">Only an owner can change these details.</Notice>}
      {saved && <Notice kind="success">Saved. Reload to see the new name in the sidebar.</Notice>}
      {error && error.code !== 'validation' && <ProblemNotice error={error} />}
      <form className="form" onSubmit={submit} noValidate>
        <Field label="Organisation name" value={name} disabled={!isOwner} onChange={(e) => { setName(e.target.value); setSaved(false); }} error={error?.fieldError('name')} />
        <div className="field">
          <label htmlFor="tz">Time zone</label>
          <select id="tz" value={timezone} disabled={!isOwner} onChange={(e) => { setTimezone(e.target.value); setSaved(false); }}>
            {!zones.includes(timezone) && <option value={timezone}>{timezone}</option>}
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
          <span className="hint">Used for reports and the times shown in emails.</span>
          {error?.fieldError('timezone') && <span className="error">{error.fieldError('timezone')}</span>}
        </div>
        <dl className="facts-list">
          <div><dt>Organisation address</dt><dd>{org.slug}</dd></div>
          <div><dt>Organisation ID</dt><dd className="mono">{org.id}</dd></div>
          <div><dt>Created</dt><dd>{formatDateTime(org.created_at)}</dd></div>
        </dl>
        {isOwner && <div className="actions"><button className="button button--primary" disabled={pending}>{pending ? 'Saving…' : 'Save changes'}</button></div>}
      </form>
    </section>
  );
}

export function MembersSettings() {
  const { org, canManage } = useOrg();
  const { user } = useSession();
  const { data, error, reload } = usePolling(() => api.members(org.id), [org.id], 60_000);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('operator');
  const [sent, setSent] = useState<string | undefined>();
  const [actionError, setActionError] = useState<ApiError | undefined>();
  const invite = useSubmit(() => api.invite(org.id, { email, role }), () => { setSent(email); setEmail(''); void reload(); });

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(undefined);
    try { await fn(); await reload(); } catch (e) { setActionError(e instanceof ApiError ? e : undefined); }
  };
  const isOwner = org.role === 'owner';
  const roleOptions: Role[] = isOwner ? ['owner', 'admin', 'operator', 'viewer'] : ['admin', 'operator', 'viewer'];

  return (
    <>
      {canManage && (
        <section className="panel form form--wide">
          <h2>Invite a teammate</h2>
          {sent && <Notice kind="success">Invitation sent to {sent}. The link works for 7 days.</Notice>}
          {invite.error && invite.error.code !== 'validation' && <ProblemNotice error={invite.error} />}
          <form className="form invite-row" onSubmit={invite.submit} noValidate>
            <Field label="Email address" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setSent(undefined); }} error={invite.error?.fieldError('email')} />
            <div className="field">
              <label htmlFor="invite-role">Role</label>
              <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                <option value="admin">Admin</option>
                <option value="operator">Operator</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
            <button className="button button--primary" disabled={invite.pending || !email}>{invite.pending ? 'Sending…' : 'Send invitation'}</button>
          </form>
          <p className="muted small">{ROLE_HELP[role]}.</p>
        </section>
      )}

      {error && <ProblemNotice error={error} />}
      {actionError && <ProblemNotice error={actionError} />}
      {data && (
        <section className="panel section">
          <h2>Members ({data.members.length})</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Joined</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.members.map((m: Member) => {
                  const self = m.id === user?.id;
                  const editable = canManage && (isOwner || m.role !== 'owner');
                  return (
                    <tr key={m.id}>
                      <td data-label="Name"><strong>{m.name}</strong>{self && <span className="muted"> (you)</span>}<div className="muted small">{m.email}</div></td>
                      <td data-label="Role">
                        {editable ? (
                          <select aria-label={`Role for ${m.name}`} value={m.role} onChange={(e) => void act(() => api.changeRole(org.id, m.id, e.target.value as Role))}>
                            {(roleOptions.includes(m.role) ? roleOptions : [m.role, ...roleOptions]).map((r) => <option key={r} value={r}>{r[0]!.toUpperCase() + r.slice(1)}</option>)}
                          </select>
                        ) : (
                          <span className="role">{m.role}</span>
                        )}
                      </td>
                      <td data-label="Joined">{formatDateTime(m.joinedAt)}</td>
                      <td data-label="">
                        {(self || editable) && (
                          <button
                            className="button button--danger button--small"
                            onClick={() => {
                              const question = self ? `Leave ${org.name}? You'll lose access immediately.` : `Remove ${m.name} from ${org.name}?`;
                              if (window.confirm(question)) void act(() => api.removeMember(org.id, m.id)).then(() => { if (self) window.location.assign('/'); });
                            }}
                          >
                            {self ? 'Leave' : 'Remove'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.invitations.length > 0 && (
            <>
              <h2 className="section">Pending invitations</h2>
              <ul className="list">
                {data.invitations.map((i) => (
                  <li key={i.id}>
                    <span><strong>{i.email}</strong> <span className="muted">as {i.role}, invited by {i.invitedBy}, expires {formatDateTime(i.expiresAt)}</span></span>
                    {canManage && <button className="button button--secondary button--small" onClick={() => void act(() => api.revokeInvitation(org.id, i.id))}>Revoke</button>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <dl className="facts-list section">
            {(Object.keys(ROLE_HELP) as Role[]).map((r) => <div key={r}><dt className="role">{r}</dt><dd>{ROLE_HELP[r]}</dd></div>)}
          </dl>
        </section>
      )}
    </>
  );
}

const SEVERITY_OPTIONS: Array<{ value: Severity; label: string }> = [
  { value: 'sev1', label: 'SEV1 only (critical)' },
  { value: 'sev2', label: 'SEV2 and above' },
  { value: 'sev3', label: 'SEV3 and above' },
  { value: 'sev4', label: 'All incidents' },
];

function PolicyForm({ members, initial, onSave, onCancel }: { members: Member[]; initial?: AlertPolicy; onSave: (input: AlertPolicyInput) => Promise<unknown>; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [minSeverity, setMinSeverity] = useState<Severity>(initial?.minSeverity ?? 'sev4');
  const [notifyOn, setNotifyOn] = useState<Array<'opened' | 'resolved'>>(initial?.notifyOn ?? ['opened', 'resolved']);
  const [memberIds, setMemberIds] = useState<string[]>(initial?.memberIds ?? []);
  const [external, setExternal] = useState((initial?.externalEmails ?? []).join(', '));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const { submit, pending, error } = useSubmit(() =>
    onSave({ name, minSeverity, notifyOn, memberIds, externalEmails: external.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean), enabled }),
  );

  return (
    <form className="panel form form--wide" onSubmit={submit} noValidate>
      <h2>{initial ? `Edit "${initial.name}"` : 'New alert rule'}</h2>
      {error && error.code !== 'validation' && <ProblemNotice error={error} />}
      {error?.code === 'validation' && error.fieldErrors.some((f) => f.field === 'memberIds') && <Notice kind="error">{error.fieldError('memberIds')}</Notice>}
      <Field label="Rule name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Critical incidents to on-call" error={error?.fieldError('name')} />
      <div className="field">
        <label htmlFor="sev">Which incidents</label>
        <select id="sev" value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as Severity)}>
          {SEVERITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <fieldset className="choice">
        <legend>Send when an incident</legend>
        {(['opened', 'resolved'] as const).map((ev) => (
          <label key={ev} className={`choice__item ${notifyOn.includes(ev) ? 'is-selected' : ''}`}>
            <input type="checkbox" checked={notifyOn.includes(ev)} onChange={() => setNotifyOn(toggle(notifyOn, ev))} />
            {ev === 'opened' ? 'Opens' : 'Resolves'}
          </label>
        ))}
      </fieldset>
      {error?.fieldError('notifyOn') && <span className="error">{error.fieldError('notifyOn')}</span>}
      <fieldset className="choice choice--list">
        <legend>Team members</legend>
        {members.map((m) => (
          <label key={m.id} className={`choice__item ${memberIds.includes(m.id) ? 'is-selected' : ''}`}>
            <input type="checkbox" checked={memberIds.includes(m.id)} onChange={() => setMemberIds(toggle(memberIds, m.id))} />
            <span>{m.name} <span className="muted small">{m.email}</span></span>
          </label>
        ))}
      </fieldset>
      <Field label="Other email addresses (optional)" value={external} onChange={(e) => setExternal(e.target.value)} hint="Comma-separated, e.g. an on-call alias. Up to 20." error={error?.fieldErrors.find((f) => f.field.startsWith('externalEmails'))?.message} />
      <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span>Rule is active</span></label>
      <div className="actions">
        <button className="button button--primary" disabled={pending}>{pending ? 'Saving…' : 'Save rule'}</button>
        <button type="button" className="button button--secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function AlertsSettings() {
  const { org, canManage } = useOrg();
  const policies = usePolling(() => api.alertPolicies(org.id), [org.id], 60_000);
  const members = usePolling(() => api.members(org.id), [org.id], 60_000);
  const [editing, setEditing] = useState<AlertPolicy | 'new' | undefined>();
  const [actionError, setActionError] = useState<ApiError | undefined>();
  const memberName = (id: string) => members.data?.members.find((m) => m.id === id)?.name ?? 'Former member';

  const save = async (input: AlertPolicyInput) => {
    if (editing === 'new') await api.createAlertPolicy(org.id, input);
    else if (editing) await api.updateAlertPolicy(org.id, editing.id, input);
    setEditing(undefined);
    await policies.reload();
  };

  if (editing && members.data) return <PolicyForm members={members.data.members} initial={editing === 'new' ? undefined : editing} onSave={save} onCancel={() => setEditing(undefined)} />;

  return (
    <section className="panel section">
      <div className="section-head">
        <h2>Alert rules</h2>
        {canManage && <button className="button button--primary" onClick={() => setEditing('new')}>Add rule</button>}
      </div>
      {policies.error && <ProblemNotice error={policies.error} />}
      {actionError && <ProblemNotice error={actionError} />}
      {policies.data && policies.data.items.length === 0 && (
        <Notice kind="info" title="Using the default">
          With no rules, every incident emails all owners and admins when it opens and when it resolves. Add a rule to choose who hears about what.
        </Notice>
      )}
      {policies.data && policies.data.items.length > 0 && (
        <ul className="list">
          {policies.data.items.map((p) => (
            <li key={p.id}>
              <div>
                <strong>{p.name}</strong> {!p.enabled && <span className="chip chip--unknown">Off</span>}
                <div className="muted small">
                  <SeverityBadge severity={p.minSeverity} /> {p.minSeverity === 'sev4' ? 'all incidents' : 'and above'} · on {p.notifyOn.join(' and ')} · to{' '}
                  {[...p.memberIds.map(memberName), ...p.externalEmails].join(', ')}
                </div>
              </div>
              {canManage && (
                <span className="actions">
                  <button className="button button--secondary button--small" onClick={() => setEditing(p)}>Edit</button>
                  <button className="button button--danger button--small" onClick={async () => {
                    if (!window.confirm(`Delete the rule "${p.name}"?`)) return;
                    try { await api.deleteAlertPolicy(org.id, p.id); await policies.reload(); } catch (e) { setActionError(e instanceof ApiError ? e : undefined); }
                  }}>Delete</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small section">Email is the only channel today. SMS, WhatsApp, Slack and Teams come in Release 2. In staging, emails are written to the log rather than delivered.</p>
    </section>
  );
}

function Meter({ label, used, limit, unit = '' }: { label: string; used: number; limit: number; unit?: string }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <div className="meter">
      <div className="meter__head"><span>{label}</span><strong className="tnum">{used}{unit} of {limit}{unit}</strong></div>
      <div className="meter__bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        <span style={{ width: `${ratio * 100}%` }} className={ratio >= 0.9 ? 'is-high' : ''} />
      </div>
    </div>
  );
}

export function PlanSettings() {
  const { org } = useOrg();
  const { data, error } = usePolling(() => api.plan(org.id), [org.id], 60_000);
  if (error) return <ProblemNotice error={error} />;
  if (!data) return <p aria-live="polite">Loading…</p>;
  const l = data.plan.limits;
  return (
    <section className="panel section">
      <h2>{data.plan.name} plan</h2>
      <div className="meters">
        <Meter label="Services monitored" used={data.usage.monitors} limit={l.monitors} />
        <Meter label="Team seats" used={data.usage.members + data.usage.invitations} limit={l.seats} />
      </div>
      <dl className="facts-list section">
        <div><dt>Fastest check interval</dt><dd>Every {l.min_interval_seconds / 60} minute{l.min_interval_seconds === 60 ? '' : 's'}</dd></div>
        <div><dt>Check data kept</dt><dd>{l.retention_days} days of raw results</dd></div>
        <div><dt>Probe regions</dt><dd>Up to {l.regions} (1 active today: Europe, Amsterdam)</dd></div>
        <div><dt>Pending invitations</dt><dd>{data.usage.invitations} (count towards seats)</dd></div>
      </dl>
      <p className="muted small">Pilot plans are arranged directly with Dynamics Technology. Self-service plans and billing come with general availability.</p>
    </section>
  );
}

function describeAudit(e: { action: string; metadata: Record<string, unknown> }): string {
  const m = e.metadata ?? {};
  switch (e.action) {
    case 'organisation.create': return `Created the organisation`;
    case 'organisation.update': return `Updated organisation details`;
    case 'monitor.create': return `Added service "${String(m.name ?? '')}"`;
    case 'monitor.update': return 'Changed a service';
    case 'monitor.pause': return 'Paused a service';
    case 'monitor.resume': return 'Resumed a service';
    case 'monitor.delete': return 'Deleted a service';
    case 'incident.acknowledge': return 'Acknowledged an incident';
    case 'incident.resolve': return 'Resolved an incident';
    case 'incident.note': return 'Added an incident note';
    case 'member.invite': return `Invited ${String(m.email ?? '')} as ${String(m.role ?? '')}`;
    case 'member.invite_revoke': return 'Revoked an invitation';
    case 'member.join': return `Joined as ${String(m.role ?? '')}`;
    case 'member.role_change': return `Changed a role from ${String(m.from ?? '')} to ${String(m.to ?? '')}`;
    case 'member.remove': return 'Removed a member';
    case 'member.leave': return 'Left the organisation';
    case 'alert_policy.create': return `Created alert rule "${String(m.name ?? '')}"`;
    case 'alert_policy.update': return `Changed alert rule "${String(m.name ?? '')}"`;
    case 'alert_policy.delete': return 'Deleted an alert rule';
    default: return e.action;
  }
}

export function AuditLogSettings() {
  const { org } = useOrg();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.auditEvents>>['items']>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>();
  const load = async (before?: string) => {
    try {
      const page = await api.auditEvents(org.id, before);
      setItems((prev) => (before ? [...prev, ...page.items] : page.items));
      setNext(page.nextBefore);
    } catch (e) { setError(e instanceof ApiError ? e : undefined); }
  };
  useEffect(() => { void load(); }, [org.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="panel section">
      <h2>Audit log</h2>
      <p className="muted small">Every material change in {org.name}, newest first. Entries can't be edited or deleted.</p>
      {error && <ProblemNotice error={error} />}
      <div className="table-wrap section">
        <table className="table">
          <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">From</th></tr></thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td data-label="When"><time dateTime={e.occurredAt}>{formatDateTime(e.occurredAt)}</time></td>
                <td data-label="Who">{e.actorName ?? (e.actorType === 'system' ? 'WatchersNex' : 'Unknown')}</td>
                <td data-label="What">{describeAudit(e)}</td>
                <td data-label="From" className="mono small">{e.ip ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next && <div className="actions section"><button className="button button--secondary" onClick={() => void load(next)}>Load older entries</button></div>}
    </section>
  );
}
