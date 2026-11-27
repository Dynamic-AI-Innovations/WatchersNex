import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { formatDateTime, formatDuration, IncidentStatusChip, SeverityBadge, usePolling } from '../components/status';
import { ProblemNotice } from '../components/ui';
import { api, ApiError, IncidentDetail } from '../lib/api';
import { useOrg } from './shell';

export function IncidentsPage() {
  const { org } = useOrg();
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const { data, error } = usePolling(() => api.incidents(org.id, filter), [org.id, filter], 30_000);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Incidents</h1>
          <p>Confirmed outages for {org.name}, newest first.</p>
        </div>
        <div className="segmented" role="group" aria-label="Filter incidents">
          {(['open', 'resolved', 'all'] as const).map((f) => (
            <button key={f} className={filter === f ? 'is-active' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f[0]!.toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {error && <ProblemNotice error={error} />}
      {!data && !error && <p aria-live="polite">Loading…</p>}
      {data && data.items.length === 0 && (
        <section className="panel empty">
          <h2>{filter === 'open' ? 'No open incidents' : 'No incidents'}</h2>
          <p>An incident opens when a service fails two checks in a row. Owners and admins are emailed.</p>
        </section>
      )}
      {data && data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Incident</th>
                <th scope="col">Severity</th>
                <th scope="col">Status</th>
                <th scope="col">Started</th>
                <th scope="col" className="num">Duration</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id}>
                  <td data-label="Incident">
                    <Link to={`/o/${org.id}/incidents/${i.id}`}>INC-{i.number}: {i.title}</Link>
                    <div className="muted small">{i.monitorName}</div>
                  </td>
                  <td data-label="Severity"><SeverityBadge severity={i.severity} /></td>
                  <td data-label="Status"><IncidentStatusChip status={i.status} /></td>
                  <td data-label="Started">{formatDateTime(i.started_at)}</td>
                  <td data-label="Duration" className="num tnum">{formatDuration(((i.resolved_at ? new Date(i.resolved_at).getTime() : Date.now()) - new Date(i.started_at).getTime()) / 1000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const EVENT_LABEL: Record<string, string> = {
  opened: 'Incident opened',
  notified: 'Notifications sent',
  acknowledged: 'Acknowledged',
  note: 'Note',
  severity_changed: 'Severity changed',
  resolved: 'Resolved',
  reopened: 'Reopened',
};

function describe(event: IncidentDetail['timeline'][number]): string {
  const d = event.details as Record<string, unknown>;
  if (event.type === 'opened') return `${String(d.message ?? '')} Confirmed from ${String(d.region ?? 'the probe region')}.`;
  if (event.type === 'notified') return `Email to ${String(d.recipients ?? 0)} owner(s) and admin(s) (${d.event === 'resolved' ? 'recovery' : 'outage'}).`;
  if (event.type === 'note') return String(d.text ?? '');
  if (event.type === 'resolved') return d.automatic ? `Service recovered: ${String(d.message ?? 'two healthy checks in a row')}.` : 'Resolved manually.';
  return '';
}

export function IncidentDetailPage() {
  const { org, canRespond } = useOrg();
  const { incidentId = '' } = useParams();
  const { data, error, reload } = usePolling(() => api.incident(org.id, incidentId), [org.id, incidentId], 30_000);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | undefined>();

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ProblemNotice error={error} />;
  if (!data) return <p aria-live="polite">Loading…</p>;

  return (
    <>
      <p className="crumb"><Link to={`/o/${org.id}/incidents`}>Incidents</Link> /</p>
      <div className="page-header">
        <div>
          <h1>INC-{data.number}: {data.title}</h1>
          <p>
            <Link to={`/o/${org.id}/services/${data.monitor_id}`}>{data.monitorName}</Link> · started {formatDateTime(data.started_at)} ·{' '}
            {data.status === 'resolved' ? `lasted ${formatDuration(data.durationSeconds)}` : `ongoing for ${formatDuration(data.durationSeconds)}`}
          </p>
        </div>
        <div className="actions">
          <SeverityBadge severity={data.severity} />
          <IncidentStatusChip status={data.status} />
        </div>
      </div>
      {actionError && <ProblemNotice error={actionError} />}

      {canRespond && data.status !== 'resolved' && (
        <section className="panel section actions">
          {data.status === 'open' && (
            <button className="button button--primary" disabled={busy} onClick={() => act(() => api.acknowledge(org.id, data.id))}>Acknowledge</button>
          )}
          <button className="button button--secondary" disabled={busy} onClick={() => act(() => api.resolve(org.id, data.id))}>Mark resolved</button>
          <span className="muted small">Incidents also resolve on their own after two healthy checks.</span>
        </section>
      )}

      <section className="panel section">
        <h2>Timeline</h2>
        <ol className="timeline">
          {data.timeline.map((e) => (
            <li key={e.id}>
              <time dateTime={e.occurred_at}>{formatDateTime(e.occurred_at)}</time>
              <div>
                <strong>{EVENT_LABEL[e.type] ?? e.type}</strong>
                {e.actorName && <span className="muted"> by {e.actorName}</span>}
                {describe(e) && <p>{describe(e)}</p>}
              </div>
            </li>
          ))}
        </ol>
        {canRespond && (
          <form
            className="note-form"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (note.trim()) void act(async () => { await api.addNote(org.id, data.id, note.trim()); setNote(''); });
            }}
          >
            <label htmlFor="note" className="sr-only">Add a note</label>
            <textarea id="note" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the team: what you found, what you did." />
            <button className="button button--secondary" disabled={busy || !note.trim()}>Add note</button>
          </form>
        )}
      </section>
    </>
  );
}
