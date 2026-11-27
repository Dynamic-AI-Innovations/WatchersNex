/**
 * Thin client for the WatchersNex API. All calls go to /api on the same
 * origin (a Vercel rewrite in production, the Vite proxy in development),
 * so session cookies are first-party and SameSite=Lax applies.
 */

export interface FieldError {
  field: string;
  message: string;
}

/** An RFC 9457 problem returned by the API. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail: string | undefined,
    readonly fieldErrors: FieldError[],
    readonly requestId: string | undefined,
  ) {
    super(detail ?? title);
  }

  /** The short problem name, e.g. "email-not-verified". */
  get code(): string {
    return this.type.split('/').pop() ?? '';
  }

  fieldError(field: string): string | undefined {
    return this.fieldErrors.find((e) => e.field === field)?.message;
  }
}

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
}

export interface Organisation extends OrgSummary {
  timezone: string;
  plan_id: string;
  created_at: string;
}

function csrfToken(): string | undefined {
  // Secure deployments use the __Host- prefixed name; local HTTP uses the plain one.
  const cookies = document.cookie.split('; ');
  for (const name of ['__Host-wnx_csrf', 'wnx_csrf']) {
    const found = cookies.find((c) => c.startsWith(`${name}=`));
    if (found) return decodeURIComponent(found.slice(name.length + 1));
  }
  return undefined;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = csrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Connection problem', 'We could not reach WatchersNex. Check your connection and try again.', [], undefined);
  }

  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const p = (payload ?? {}) as Partial<{ type: string; title: string; detail: string; errors: FieldError[]; requestId: string }>;
    throw new ApiError(
      response.status,
      p.type ?? 'unknown',
      p.title ?? 'Something went wrong',
      p.detail ?? (response.status >= 500 ? 'Something went wrong on our side. Try again shortly.' : undefined),
      p.errors ?? [],
      p.requestId,
    );
  }
  return payload as T;
}

export type MonitorStatus = 'pending' | 'up' | 'suspected' | 'down' | 'recovering' | 'paused';
export type MonitorType = 'http' | 'api' | 'ssl' | 'dns';

export interface Monitor {
  id: string;
  name: string;
  type: MonitorType;
  target: string;
  config: Record<string, unknown>;
  intervalSeconds: number;
  criticality: 'critical' | 'standard' | 'low';
  enabled: boolean;
  createdAt: string;
  status: MonitorStatus;
  lastCheckedAt: string | null;
  lastOutcome: 'up' | 'down' | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  lastFailureClass: string | null;
  lastMessage: string | null;
  openIncidentId: string | null;
  checksPassed24h?: number | null;
}

export interface MonitorDetail extends Monitor {
  stats24h: { checks: number; checksPassed: number | null; latencyP50Ms: number | null; latencyP95Ms: number | null };
  recentChecks: Array<{ checked_at: string; outcome: 'up' | 'down'; latency_ms: number | null; failure_class: string | null; status_code: number | null; message: string | null }>;
  series: Array<{ at: string; outcome: 'up' | 'down'; latencyMs: number | null }>;
  incidents: Array<{ id: string; number: number; title: string; severity: Severity; status: IncidentStatus; started_at: string; resolved_at: string | null }>;
}

export type Severity = 'sev1' | 'sev2' | 'sev3' | 'sev4';
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

export interface IncidentSummary {
  id: string;
  number: number;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  started_at: string;
  detected_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  monitorId: string;
  monitorName: string;
  acknowledgedByName: string | null;
}

export interface IncidentDetail {
  id: string;
  number: number;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  started_at: string;
  detected_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  monitor_id: string;
  monitorName: string;
  monitorTarget: string;
  durationSeconds: number;
  timeline: Array<{ id: string; type: string; occurred_at: string; details: Record<string, unknown>; actorName: string | null }>;
}

export interface Overview {
  monitors: { total: number; up: number; down: number; degraded: number; pending: number; paused: number };
  openIncidents: Array<{ id: string; number: number; title: string; severity: Severity; status: IncidentStatus; started_at: string; monitorName: string }>;
  needsAttention: Monitor[];
}

export interface CreateMonitorInput {
  type: MonitorType;
  name: string;
  target: string;
  intervalSeconds: number;
  criticality: 'critical' | 'standard' | 'low';
  config?: Record<string, unknown>;
  authorisationAttested: boolean;
}

export type Role = 'owner' | 'admin' | 'operator' | 'viewer';

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: Exclude<Role, 'owner'>;
  expiresAt: string;
  invitedBy: string;
}

export interface AlertPolicy {
  id: string;
  name: string;
  minSeverity: Severity;
  notifyOn: Array<'opened' | 'resolved'>;
  memberIds: string[];
  externalEmails: string[];
  enabled: boolean;
  updatedAt: string;
}
export type AlertPolicyInput = Omit<AlertPolicy, 'id' | 'updatedAt'>;

export interface PlanUsage {
  plan: { id: string; name: string; limits: { monitors: number; min_interval_seconds: number; regions: number; seats: number; retention_days: number } };
  usage: { monitors: number; members: number; invitations: number; fastest: number | null };
}

export interface AuditEvent {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  occurredAt: string;
  ip: string | null;
  metadata: Record<string, unknown>;
  actorType: string;
  actorName: string | null;
  actorEmail: string | null;
}

export interface AvailabilityReport {
  from: string;
  to: string;
  method: string;
  summary: { services: number; availability: number | null; downtimeSeconds: number; incidents: number };
  services: Array<{
    monitorId: string; name: string; type: MonitorType; target: string; deleted: boolean; periodSeconds: number; downtimeSeconds: number;
    availability: number | null; incidents: number; checks: number; checksPassed: number | null; latencyP50Ms: number | null; latencyP95Ms: number | null;
  }>;
  incidents: Array<{ id: string; number: number; title: string; severity: Severity; status: IncidentStatus; monitorName: string; startedAt: string; resolvedAt: string | null; durationSeconds: number }>;
}

export const api = {
  register: (input: { email: string; name: string; password: string }) => request<void>('POST', '/auth/register', input),
  verifyEmail: (token: string) => request<void>('POST', '/auth/verify-email', { token }),
  resendVerification: (email: string) => request<void>('POST', '/auth/verify-email/resend', { email }),
  login: (input: { email: string; password: string }) => request<{ user: User }>('POST', '/auth/login', input),
  logout: () => request<void>('POST', '/auth/logout'),
  forgotPassword: (email: string) => request<void>('POST', '/auth/password/forgot', { email }),
  resetPassword: (token: string, password: string) => request<void>('POST', '/auth/password/reset', { token, password }),
  me: () => request<{ user: User; organisations: OrgSummary[] }>('GET', '/me'),
  createOrg: (input: { name: string; slug?: string }) => request<Organisation>('POST', '/orgs', input),
  getOrg: (orgId: string) => request<Organisation>('GET', `/orgs/${orgId}`),
  overview: (orgId: string) => request<Overview>('GET', `/orgs/${orgId}/overview`),
  monitors: (orgId: string) => request<{ items: Monitor[] }>('GET', `/orgs/${orgId}/monitors`),
  monitor: (orgId: string, id: string) => request<MonitorDetail>('GET', `/orgs/${orgId}/monitors/${id}`),
  createMonitor: (orgId: string, input: CreateMonitorInput) => request<Monitor>('POST', `/orgs/${orgId}/monitors`, input),
  pauseMonitor: (orgId: string, id: string) => request<Monitor>('POST', `/orgs/${orgId}/monitors/${id}/pause`),
  resumeMonitor: (orgId: string, id: string) => request<Monitor>('POST', `/orgs/${orgId}/monitors/${id}/resume`),
  deleteMonitor: (orgId: string, id: string) => request<void>('DELETE', `/orgs/${orgId}/monitors/${id}`),
  incidents: (orgId: string, status: 'open' | 'resolved' | 'all' = 'all') => request<{ items: IncidentSummary[] }>('GET', `/orgs/${orgId}/incidents?status=${status}`),
  incident: (orgId: string, id: string) => request<IncidentDetail>('GET', `/orgs/${orgId}/incidents/${id}`),
  acknowledge: (orgId: string, id: string) => request<IncidentDetail>('POST', `/orgs/${orgId}/incidents/${id}/acknowledge`),
  resolve: (orgId: string, id: string) => request<IncidentDetail>('POST', `/orgs/${orgId}/incidents/${id}/resolve`),
  addNote: (orgId: string, id: string, text: string) => request<IncidentDetail>('POST', `/orgs/${orgId}/incidents/${id}/notes`, { text }),

  updateOrg: (orgId: string, input: { name?: string; timezone?: string }) => request<Organisation>('PATCH', `/orgs/${orgId}`, input),
  members: (orgId: string) => request<{ members: Member[]; invitations: PendingInvitation[] }>('GET', `/orgs/${orgId}/members`),
  invite: (orgId: string, input: { email: string; role: Exclude<Role, 'owner'> }) => request<{ members: Member[]; invitations: PendingInvitation[] }>('POST', `/orgs/${orgId}/invitations`, input),
  revokeInvitation: (orgId: string, id: string) => request<void>('DELETE', `/orgs/${orgId}/invitations/${id}`),
  changeRole: (orgId: string, userId: string, role: Role) => request<{ members: Member[]; invitations: PendingInvitation[] }>('PATCH', `/orgs/${orgId}/members/${userId}`, { role }),
  removeMember: (orgId: string, userId: string) => request<void>('DELETE', `/orgs/${orgId}/members/${userId}`),
  alertPolicies: (orgId: string) => request<{ items: AlertPolicy[] }>('GET', `/orgs/${orgId}/alert-policies`),
  createAlertPolicy: (orgId: string, input: AlertPolicyInput) => request<AlertPolicy>('POST', `/orgs/${orgId}/alert-policies`, input),
  updateAlertPolicy: (orgId: string, id: string, input: AlertPolicyInput) => request<AlertPolicy>('PUT', `/orgs/${orgId}/alert-policies/${id}`, input),
  deleteAlertPolicy: (orgId: string, id: string) => request<void>('DELETE', `/orgs/${orgId}/alert-policies/${id}`),
  plan: (orgId: string) => request<PlanUsage>('GET', `/orgs/${orgId}/plan`),
  auditEvents: (orgId: string, before?: string) => request<{ items: AuditEvent[]; nextBefore: string | null }>('GET', `/orgs/${orgId}/audit-events?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  availability: (orgId: string, from: string, to: string) => request<AvailabilityReport>('GET', `/orgs/${orgId}/reports/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  availabilityCsvUrl: (orgId: string, from: string, to: string) => `/api/v1/orgs/${orgId}/reports/availability.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  updateProfile: (name: string) => request<{ user: User }>('PATCH', '/me', { name }),
  changePassword: (currentPassword: string, newPassword: string) => request<void>('POST', '/me/password', { currentPassword, newPassword }),
  invitationPreview: (token: string) => request<{ organisationName: string; role: Role; email: string; expiresAt: string }>('GET', `/invitations/preview?token=${encodeURIComponent(token)}`),
  acceptInvitation: (token: string) => request<{ organisationId: string }>('POST', '/invitations/accept', { token }),
};
