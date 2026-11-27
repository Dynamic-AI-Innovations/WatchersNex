import { useOrg } from './shell';

/**
 * Preview pages for modules on the roadmap but not yet built. They explain
 * what is coming and when, and show no sample or invented data (kickoff rule:
 * a dashboard without a working product behind it misleads). Hidden entirely
 * when VITE_SHOW_PREVIEW_MODULES=false.
 */
export const PREVIEW_MODULES = {
  observability: {
    title: 'Observability',
    release: 'Release 2',
    summary: 'Metrics, logs and traces from your applications and infrastructure, alongside the availability checks you already have.',
    points: [
      'OpenTelemetry ingestion, so you can send data without being locked to one vendor',
      'Infrastructure metrics: CPU, memory, disk and network from lightweight agents',
      'Application performance: request rates, error rates and latency per endpoint',
      'Log search and distributed traces linked to the incidents they explain',
    ],
  },
  dependencies: {
    title: 'Dependencies',
    release: 'Release 2',
    summary: 'A map of how your services depend on each other and on third parties, so you can see what a failure will affect.',
    points: [
      'Service topology: applications, APIs, databases and third-party providers',
      'Upstream and downstream impact when something fails',
      'Dependency health at a glance, built from your monitors and telemetry',
    ],
  },
  slos: {
    title: 'SLOs & Reliability',
    release: 'Release 3',
    summary: 'Service level objectives and error budgets, so reliability is measured against targets your business agrees on.',
    points: [
      'SLIs and SLOs per service, with error-budget burn and alerts on fast burn',
      'MTTD, MTTA and MTTR trends from your incident history',
      'Reliability scoring and executive summaries',
    ],
  },
  automation: {
    title: 'Automation',
    release: 'Release 4',
    summary: 'Approved runbooks that can restart, scale or roll back services, with human approval and a full audit trail.',
    points: [
      'Runbooks with permissions, approval steps and execution limits',
      'Every action recorded and reversible, with recovery verification',
      'Nothing runs against production without an explicit approval policy',
    ],
  },
  integrations: {
    title: 'Integrations',
    release: 'Release 2',
    summary: 'Connect WatchersNex to the tools your team already uses for alerts and work tracking.',
    points: [
      'Alert channels: SMS, WhatsApp Business, Slack and Microsoft Teams',
      'Ticketing: Jira and similar tools, opened from incidents',
      'A public API with keys for your own automation',
    ],
  },
} as const;

export type PreviewKey = keyof typeof PREVIEW_MODULES;

export const SHOW_PREVIEW_MODULES = import.meta.env.VITE_SHOW_PREVIEW_MODULES !== 'false';

export function PreviewPage({ module }: { module: PreviewKey }) {
  const { org } = useOrg();
  const m = PREVIEW_MODULES[module];
  return (
    <>
      <div className="page-header">
        <div>
          <h1>{m.title}</h1>
          <p>{m.summary}</p>
        </div>
        <span className="badge">Preview · planned for {m.release}</span>
      </div>
      <section className="panel preview">
        <h2>What this module will do</h2>
        <ul className="preview__list">
          {m.points.map((p) => <li key={p}>{p}</li>)}
        </ul>
        <p className="muted small">
          Not available yet in {org.name}. This page shows the plan only; no data here is real or sample data.
          Delivery follows the WatchersNex roadmap and is confirmed by customer evidence after the MVP.
        </p>
      </section>
    </>
  );
}
