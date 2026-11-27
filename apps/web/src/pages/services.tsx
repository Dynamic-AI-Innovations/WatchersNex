import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { formatDateTime, LatencyChart, percent, SeverityBadge, StatusChip, timeAgo, usePolling } from '../components/status';
import { Field, Notice, ProblemNotice, useSubmit } from '../components/ui';
import { api, ApiError, MonitorType } from '../lib/api';
import { useOrg } from './shell';

const TYPE_LABEL: Record<MonitorType, string> = { http: 'Website', api: 'API endpoint', ssl: 'SSL certificate', dns: 'DNS record' };
const INTERVALS = [
  { value: 60, label: 'Every minute' },
  { value: 300, label: 'Every 5 minutes' },
  { value: 600, label: 'Every 10 minutes' },
];

export function ServicesPage() {
  const { org, canManage } = useOrg();
  const { data, error } = usePolling(() => api.monitors(org.id), [org.id], 30_000);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Services</h1>
          <p>Websites, APIs, certificates and DNS records monitored for {org.name}.</p>
        </div>
        {canManage && <Link className="button button--primary" to={`/o/${org.id}/services/new`}>Add service</Link>}
      </div>
      {error && <ProblemNotice error={error} />}
      {!data && !error && <p aria-live="polite">Loading…</p>}
      {data && data.items.length === 0 && (
        <section className="panel empty">
          <h2>No services yet</h2>
          <p>Add a website or API and WatchersNex starts checking it within a minute.</p>
          {canManage && <Link className="button button--primary" to={`/o/${org.id}/services/new`}>Add service</Link>}
        </section>
      )}
      {data && data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Status</th>
                <th scope="col">Last check</th>
                <th scope="col" className="num">Response</th>
                <th scope="col" className="num">Checks passed (24 h)</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((m) => (
                <tr key={m.id}>
                  <td data-label="Service">
                    <Link to={`/o/${org.id}/services/${m.id}`}>{m.name}</Link>
                    <div className="muted small">{TYPE_LABEL[m.type]} · {m.target}</div>
                  </td>
                  <td data-label="Status"><StatusChip status={m.status} /></td>
                  <td data-label="Last check">{timeAgo(m.lastCheckedAt)}</td>
                  <td data-label="Response" className="num tnum">{m.lastLatencyMs !== null && m.lastOutcome === 'up' ? `${m.lastLatencyMs} ms` : '—'}</td>
                  <td data-label="Checks passed (24 h)" className="num tnum">{percent(m.checksPassed24h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function NewServicePage() {
  const { org, canManage } = useOrg();
  const navigate = useNavigate();
  const [type, setType] = useState<MonitorType>('http');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(300);
  const [criticality, setCriticality] = useState<'critical' | 'standard' | 'low'>('standard');
  const [keyword, setKeyword] = useState('');
  const [attested, setAttested] = useState(false);

  const urlTarget = type === 'http' || type === 'api';
  const { submit, pending, error } = useSubmit(
    () =>
      api.createMonitor(org.id, {
        type,
        name,
        target,
        intervalSeconds,
        criticality,
        authorisationAttested: attested,
        config: urlTarget && keyword ? { keyword } : undefined,
      }),
    (monitor) => navigate(`/o/${org.id}/services/${monitor.id}`),
  );

  if (!canManage) return <Notice kind="info" title="Not available">Only owners and admins can add services.</Notice>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Add a service</h1>
          <p>Checks start within a minute of saving.</p>
        </div>
      </div>
      <form className="panel form form--wide" onSubmit={submit} noValidate>
        {error && error.code !== 'validation' && error.code !== 'target-rejected' && <ProblemNotice error={error} />}
        <fieldset className="choice">
          <legend>What do you want to monitor?</legend>
          {(Object.keys(TYPE_LABEL) as MonitorType[]).map((t) => (
            <label key={t} className={`choice__item ${type === t ? 'is-selected' : ''}`}>
              <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} />
              {TYPE_LABEL[t]}
            </label>
          ))}
        </fieldset>
        <Field label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Customer website" error={error?.fieldError('name')} />
        <Field
          label={urlTarget ? 'URL' : 'Host name'}
          required
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={urlTarget ? 'https://www.example.com' : 'www.example.com'}
          hint={urlTarget ? 'Public addresses only. We check the status code and response time.' : 'No https://, just the host name.'}
          error={error?.fieldError('target')}
        />
        {urlTarget && (
          <Field label="Text the page must contain (optional)" value={keyword} onChange={(e) => setKeyword(e.target.value)} hint="Catches pages that return 200 but show an error." error={error?.fieldError('config.keyword')} />
        )}
        <div className="field">
          <label htmlFor="interval">Check frequency</label>
          <select id="interval" value={intervalSeconds} onChange={(e) => setIntervalSeconds(Number(e.target.value))}>
            {INTERVALS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
          </select>
          {error?.fieldError('intervalSeconds') && <span className="error">{error.fieldError('intervalSeconds')}</span>}
        </div>
        <div className="field">
          <label htmlFor="criticality">Importance</label>
          <select id="criticality" value={criticality} onChange={(e) => setCriticality(e.target.value as typeof criticality)}>
            <option value="critical">Critical (incidents start as SEV1)</option>
            <option value="standard">Standard (SEV2)</option>
            <option value="low">Low (SEV3)</option>
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
          <span>I am authorised to monitor this address on behalf of {org.name}.</span>
        </label>
        {error?.fieldError('authorisationAttested') && <span className="error">{error.fieldError('authorisationAttested')}</span>}
        <div className="actions">
          <button className="button button--primary" disabled={pending}>{pending ? 'Saving…' : 'Start monitoring'}</button>
          <Link className="button button--secondary" to={`/o/${org.id}/services`}>Cancel</Link>
        </div>
      </form>
    </>
  );
}

export function ServiceDetailPage() {
  const { org, canManage } = useOrg();
  const { monitorId = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, reload } = usePolling(() => api.monitor(org.id, monitorId), [org.id, monitorId], 30_000);
  const [actionError, setActionError] = useState<ApiError | undefined>();
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await fn();
      after ? after() : await reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ProblemNotice error={error} />;
  if (!data) return <p aria-live="polite">Loading…</p>;
  const s = data.stats24h;

  return (
    <>
      <p className="crumb"><Link to={`/o/${org.id}/services`}>Services</Link> /</p>
      <div className="page-header">
        <div>
          <h1>{data.name}</h1>
          <p>{TYPE_LABEL[data.type]} · {data.target} · {INTERVALS.find((i) => i.value === data.intervalSeconds)?.label.toLowerCase()}</p>
        </div>
        {canManage && (
          <div className="actions">
            {data.enabled ? (
              <button className="button button--secondary" disabled={busy} onClick={() => act(() => api.pauseMonitor(org.id, data.id))}>Pause</button>
            ) : (
              <button className="button button--secondary" disabled={busy} onClick={() => act(() => api.resumeMonitor(org.id, data.id))}>Resume</button>
            )}
            <button
              className="button button--danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete "${data.name}"? Checks stop immediately. Past incidents stay in your reports.`)) {
                  void act(() => api.deleteMonitor(org.id, data.id), () => navigate(`/o/${org.id}/services`));
                }
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      {actionError && <ProblemNotice error={actionError} />}

      <section className="panel status-panel">
        <StatusChip status={data.status} />
        <div>
          <strong>{data.lastMessage ?? 'Waiting for the first check to run.'}</strong>
          <div className="muted small">Last checked {timeAgo(data.lastCheckedAt)}{data.openIncidentId && <> · <Link to={`/o/${org.id}/incidents/${data.openIncidentId}`}>View open incident</Link></>}</div>
        </div>
      </section>

      <div className="kpis">
        <div className="kpi"><small>Checks passed (24 h)</small><strong className="tnum">{percent(s.checksPassed)}</strong></div>
        <div className="kpi"><small>Median response</small><strong className="tnum">{s.latencyP50Ms !== null ? `${s.latencyP50Ms} ms` : '—'}</strong></div>
        <div className="kpi"><small>95th percentile</small><strong className="tnum">{s.latencyP95Ms !== null ? `${s.latencyP95Ms} ms` : '—'}</strong></div>
        <div className="kpi"><small>Checks run (24 h)</small><strong className="tnum">{s.checks}</strong></div>
      </div>

      <section className="panel section">
        <h2>Response time, last 24 hours</h2>
        <LatencyChart series={data.series} />
        <p className="muted small">Line: response time of successful checks. Red marks: failed checks.</p>
      </section>

      <section className="panel section">
        <h2>Recent checks</h2>
        {data.recentChecks.length === 0 ? (
          <p className="muted">No checks yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Time</th><th scope="col">Result</th><th scope="col" className="num">Response</th><th scope="col">Detail</th></tr></thead>
              <tbody>
                {data.recentChecks.slice(0, 20).map((c) => (
                  <tr key={c.checked_at}>
                    <td data-label="Time">{formatDateTime(c.checked_at)}</td>
                    <td data-label="Result"><StatusChip status={c.outcome === 'up' ? 'up' : 'down'} /></td>
                    <td data-label="Response" className="num tnum">{c.latency_ms !== null ? `${c.latency_ms} ms` : '—'}</td>
                    <td data-label="Detail" className="small">{c.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel section">
        <h2>Incidents</h2>
        {data.incidents.length === 0 ? (
          <p className="muted">No incidents for this service.</p>
        ) : (
          <ul className="list">
            {data.incidents.map((i) => (
              <li key={i.id}>
                <Link to={`/o/${org.id}/incidents/${i.id}`}>INC-{i.number}: {i.title}</Link>
                <span className="list__meta"><SeverityBadge severity={i.severity} /> {i.status} · {formatDateTime(i.started_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
