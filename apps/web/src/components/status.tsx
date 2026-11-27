import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, IncidentStatus, MonitorStatus, Severity } from '../lib/api';

/* Status language from the brand guide: label + icon + colour, never colour alone. */
const STATUS: Record<MonitorStatus, { label: string; tone: string; icon: string }> = {
  up: { label: 'Operational', tone: 'good', icon: 'M5 12.5l4 4L19 7' },
  suspected: { label: 'Degraded', tone: 'warn', icon: 'M12 8v5M12 16.5v.5' },
  recovering: { label: 'Recovering', tone: 'warn', icon: 'M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4' },
  down: { label: 'Down', tone: 'critical', icon: 'M7 7l10 10M17 7L7 17' },
  pending: { label: 'Awaiting first check', tone: 'unknown', icon: 'M12 7v5l3 2' },
  paused: { label: 'Paused', tone: 'unknown', icon: 'M9 7v10M15 7v10' },
};

function Icon({ path }: { path: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

export function StatusChip({ status }: { status: MonitorStatus }) {
  const s = STATUS[status];
  return (
    <span className={`chip chip--${s.tone}`}>
      <Icon path={s.icon} />
      {s.label}
    </span>
  );
}

const SEVERITY: Record<Severity, { label: string; tone: string }> = {
  sev1: { label: 'SEV1 Critical', tone: 'critical' },
  sev2: { label: 'SEV2 Major', tone: 'warn' },
  sev3: { label: 'SEV3 Minor', tone: 'info' },
  sev4: { label: 'SEV4 Info', tone: 'unknown' },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY[severity];
  return <span className={`sev sev--${s.tone}`}>{s.label}</span>;
}

const INCIDENT: Record<IncidentStatus, { label: string; tone: string }> = {
  open: { label: 'Open', tone: 'critical' },
  acknowledged: { label: 'Acknowledged', tone: 'warn' },
  resolved: { label: 'Resolved', tone: 'good' },
};

export function IncidentStatusChip({ status }: { status: IncidentStatus }) {
  const s = INCIDENT[status];
  return <span className={`chip chip--${s.tone}`}>{s.label}</span>;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function percent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined) return '—';
  return `${(ratio * 100).toFixed(ratio === 1 ? 0 : 2)}%`;
}

/** Fetches data and refreshes it on an interval while the page is visible. */
export function usePolling<T>(load: () => Promise<T>, deps: unknown[], intervalMs = 30_000) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e : undefined);
    }
  }, []);

  useEffect(() => {
    setData(undefined);
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, reload };
}

/**
 * Response time over 24 hours: a line for successful checks, red ticks for
 * failures. Axis labelled with units; a text summary accompanies it on the page.
 */
export function LatencyChart({ series }: { series: Array<{ at: string; outcome: 'up' | 'down'; latencyMs: number | null }> }) {
  if (series.length < 2) {
    return <p className="muted">The chart appears after a few checks have run.</p>;
  }
  const W = 720;
  const H = 180;
  const pad = { l: 48, r: 12, t: 12, b: 24 };
  const times = series.map((p) => new Date(p.at).getTime());
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const ups = series.filter((p) => p.outcome === 'up' && p.latencyMs !== null);
  const maxLatency = Math.max(100, ...ups.map((p) => p.latencyMs!));
  const yMax = Math.ceil(maxLatency / 100) * 100;
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  const path = ups.map((p, i) => `${i ? 'L' : 'M'}${x(new Date(p.at).getTime()).toFixed(1)},${y(p.latencyMs!).toFixed(1)}`).join(' ');
  const ticks = [0, yMax / 2, yMax];

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Response time over the last 24 hours, up to ${yMax} milliseconds`}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="chart__grid" />
          <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="chart__label">{v} ms</text>
        </g>
      ))}
      <path d={path} className="chart__line" />
      {series
        .filter((p) => p.outcome === 'down')
        .map((p) => (
          <line key={p.at} x1={x(new Date(p.at).getTime())} x2={x(new Date(p.at).getTime())} y1={pad.t} y2={H - pad.b} className="chart__fail" />
        ))}
      <text x={pad.l} y={H - 6} className="chart__label">{formatDateTime(new Date(t0).toISOString())}</text>
      <text x={W - pad.r} y={H - 6} textAnchor="end" className="chart__label">{formatDateTime(new Date(t1).toISOString())}</text>
    </svg>
  );
}
