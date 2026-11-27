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
};
