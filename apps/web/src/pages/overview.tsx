import { Link } from 'react-router';
import { formatDuration, SeverityBadge, StatusChip, timeAgo, usePolling } from '../components/status';
import { ProblemNotice } from '../components/ui';
import { api } from '../lib/api';
import { useOrg } from './shell';

export function OverviewPage() {
  const { org, canManage } = useOrg();
  const { data, error } = usePolling(() => api.overview(org.id), [org.id], 30_000);

  if (error) return <ProblemNotice error={error} />;
  if (!data) return <p aria-live="polite">Loading…</p>;
  const m = data.monitors;
  const allClear = m.total > 0 && m.down === 0 && m.degraded === 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Overview</h1>
          <p>
            {m.total === 0
              ? `Nothing monitored in ${org.name} yet.`
              : allClear
                ? `All ${m.up} active services in ${org.name} are operational.`
                : `${m.down} down and ${m.degraded} degraded of ${m.total} services in ${org.name}.`}
          </p>
        </div>
        {canManage && <Link className="button button--primary" to={`/o/${org.id}/services/new`}>Add service</Link>}
      </div>

      {m.total === 0 ? (
        <section className="panel empty">
          <h2>Add your first service</h2>
          <p>Monitor a website, an API endpoint, an SSL certificate or a DNS record. Checks start within a minute.</p>
          {canManage ? (
            <Link className="button button--primary" to={`/o/${org.id}/services/new`}>Add service</Link>
          ) : (
            <p className="muted">Ask an owner or admin of {org.name} to add one.</p>
          )}
        </section>
      ) : (
        <>
          <div className="kpis" role="list">
            <div className="kpi" role="listitem"><small>Operational</small><strong className="tnum">{m.up}</strong></div>
            <div className={`kpi ${m.down ? 'kpi--critical' : ''}`} role="listitem"><small>Down</small><strong className="tnum">{m.down}</strong></div>
            <div className={`kpi ${m.degraded ? 'kpi--warn' : ''}`} role="listitem"><small>Degraded</small><strong className="tnum">{m.degraded}</strong></div>
            <div className="kpi" role="listitem"><small>Open incidents</small><strong className="tnum">{data.openIncidents.length}</strong></div>
            <div className="kpi" role="listitem"><small>Awaiting first check · paused</small><strong className="tnum">{m.pending} · {m.paused}</strong></div>
          </div>

          <section className="panel section">
            <h2>Open incidents</h2>
            {data.openIncidents.length === 0 ? (
              <p className="muted">No open incidents.</p>
            ) : (
              <ul className="list">
                {data.openIncidents.map((i) => (
                  <li key={i.id}>
                    <Link to={`/o/${org.id}/incidents/${i.id}`}>INC-{i.number}: {i.title}</Link>
                    <span className="list__meta"><SeverityBadge severity={i.severity} /> open for {formatDuration((Date.now() - new Date(i.started_at).getTime()) / 1000)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel section">
            <h2>Needs attention</h2>
            {data.needsAttention.length === 0 ? (
              <p className="muted">Every service passed its latest check.</p>
            ) : (
              <ul className="list">
                {data.needsAttention.map((s) => (
                  <li key={s.id}>
                    <Link to={`/o/${org.id}/services/${s.id}`}>{s.name}</Link>
                    <span className="list__meta"><StatusChip status={s.status} /> {s.lastMessage} · {timeAgo(s.lastCheckedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
