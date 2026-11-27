import { useState } from 'react';
import { Link } from 'react-router';
import { formatDateTime, formatDuration, percent, SeverityBadge, usePolling } from '../components/status';
import { ProblemNotice } from '../components/ui';
import { api } from '../lib/api';
import { useOrg } from './shell';

const PRESETS = [
  { days: 1, label: 'Last 24 hours' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function ReportsPage() {
  const { org } = useOrg();
  const [days, setDays] = useState<number | 'custom'>(7);
  const [customFrom, setCustomFrom] = useState(isoDate(new Date(Date.now() - 7 * 86_400_000)));
  const [customTo, setCustomTo] = useState(isoDate(new Date()));

  const range = (() => {
    if (days === 'custom') {
      return { from: new Date(`${customFrom}T00:00:00`).toISOString(), to: new Date(`${customTo}T23:59:59`).toISOString() };
    }
    const to = new Date();
    return { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() };
  })();
  // Presets refresh on their own; custom ranges reload when the dates change.
  const key = days === 'custom' ? `${customFrom}|${customTo}` : String(days);
  const { data, error } = usePolling(() => api.availability(org.id, range.from, range.to), [org.id, key], 120_000);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <p>Availability and incidents for {org.name}.</p>
        </div>
        <div className="actions no-print">
          <a className="button button--secondary" href={api.availabilityCsvUrl(org.id, range.from, range.to)} download>Download CSV</a>
          <button className="button button--secondary" onClick={() => window.print()}>Print or save as PDF</button>
        </div>
      </div>

      <div className="panel report-controls no-print">
        <div className="segmented" role="group" aria-label="Report period">
          {PRESETS.map((p) => (
            <button key={p.days} className={days === p.days ? 'is-active' : ''} aria-pressed={days === p.days} onClick={() => setDays(p.days)}>{p.label}</button>
          ))}
          <button className={days === 'custom' ? 'is-active' : ''} aria-pressed={days === 'custom'} onClick={() => setDays('custom')}>Custom</button>
        </div>
        {days === 'custom' && (
          <div className="date-range">
            <label>From <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} /></label>
            <label>To <input type="date" value={customTo} min={customFrom} max={isoDate(new Date())} onChange={(e) => setCustomTo(e.target.value)} /></label>
          </div>
        )}
      </div>

      {error && <ProblemNotice error={error} />}
      {!data && !error && <p aria-live="polite">Loading…</p>}
      {data && (
        <>
          <p className="print-only report-title">
            <strong>{org.name}: availability report</strong>
            <br />
            {formatDateTime(data.from)} to {formatDateTime(data.to)}
          </p>
          <div className="kpis">
            <div className="kpi"><small>Overall availability</small><strong className="tnum">{percent(data.summary.availability)}</strong></div>
            <div className="kpi"><small>Confirmed downtime</small><strong className="tnum">{formatDuration(data.summary.downtimeSeconds)}</strong></div>
            <div className="kpi"><small>Incidents started</small><strong className="tnum">{data.summary.incidents}</strong></div>
            <div className="kpi"><small>Services covered</small><strong className="tnum">{data.summary.services}</strong></div>
          </div>

          <section className="panel section">
            <h2>Availability by service</h2>
            {data.services.length === 0 ? (
              <p className="muted">No services were monitored in this period.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Service</th>
                      <th scope="col" className="num">Availability</th>
                      <th scope="col" className="num">Downtime</th>
                      <th scope="col" className="num">Incidents</th>
                      <th scope="col" className="num">Checks passed</th>
                      <th scope="col" className="num">Median / 95th response</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.services.map((s) => (
                      <tr key={s.monitorId}>
                        <td data-label="Service">
                          {s.deleted ? <span>{s.name} <span className="muted small">(deleted)</span></span> : <Link to={`/o/${org.id}/services/${s.monitorId}`}>{s.name}</Link>}
                          <div className="muted small">{s.target}</div>
                        </td>
                        <td data-label="Availability" className="num tnum">{percent(s.availability)}</td>
                        <td data-label="Downtime" className="num tnum">{s.downtimeSeconds ? formatDuration(s.downtimeSeconds) : '—'}</td>
                        <td data-label="Incidents" className="num tnum">{s.incidents}</td>
                        <td data-label="Checks passed" className="num tnum">{s.checks ? `${percent(s.checksPassed)} of ${s.checks}` : '—'}</td>
                        <td data-label="Response" className="num tnum">{s.latencyP50Ms !== null ? `${s.latencyP50Ms} / ${s.latencyP95Ms} ms` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel section">
            <h2>Incidents in this period</h2>
            {data.incidents.length === 0 ? (
              <p className="muted">No incidents in this period.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th scope="col">Incident</th><th scope="col">Severity</th><th scope="col">Started</th><th scope="col" className="num">Duration</th></tr></thead>
                  <tbody>
                    {data.incidents.map((i) => (
                      <tr key={i.id}>
                        <td data-label="Incident"><Link to={`/o/${org.id}/incidents/${i.id}`}>INC-{i.number}: {i.title}</Link><div className="muted small">{i.monitorName} · {i.status}</div></td>
                        <td data-label="Severity"><SeverityBadge severity={i.severity} /></td>
                        <td data-label="Started">{formatDateTime(i.startedAt)}</td>
                        <td data-label="Duration" className="num tnum">{formatDuration(i.durationSeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="muted small section"><strong>Method.</strong> {data.method}</p>
        </>
      )}
    </>
  );
}
