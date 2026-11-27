import { Resolver } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import tls from 'node:tls';
import { parseTargetUrl, PUBLIC_ONLY, resolveTarget, TargetPolicy, TargetRejected } from './ssrf.js';

export type FailureClass =
  | 'dns' | 'blocked' | 'connect' | 'tls' | 'timeout' | 'status' | 'assertion' | 'cert_expiring' | 'error';

export interface CheckResult {
  outcome: 'up' | 'down';
  failureClass?: FailureClass;
  statusCode?: number;
  latencyMs: number;
  timings?: { connect?: number; tls?: number; firstByte?: number; total: number };
  /** Short, human-readable, never containing response bodies or headers. */
  message: string;
  finalUrl?: string;
}

export interface HttpConfig {
  method?: 'GET' | 'HEAD';
  timeoutMs?: number;
  followRedirects?: boolean;
  expectedStatus?: { min: number; max: number };
  keyword?: string;
}

export interface SslConfig {
  warnDays?: number;
}

export interface DnsConfig {
  recordType?: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT';
  expectedValue?: string;
}

const USER_AGENT = 'WatchersNex-Monitor/0.1 (+https://watchersnex.vercel.app)';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A lookup that always answers with the address the SSRF guard already approved. */
function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as unknown as LookupFunction;
}

function elapsed(since: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - since) / 1e6);
}

interface HopResponse {
  statusCode: number;
  location?: string;
  body: string;
  connect?: number;
  tls?: number;
  firstByte?: number;
}

function requestOnce(url: URL, address: string, family: 4 | 6, method: string, deadline: AbortSignal, wantBody: boolean, started: bigint): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const timings: { connect?: number; tls?: number; firstByte?: number } = {};
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity' },
        lookup: pinnedLookup(address, family),
        signal: deadline,
        agent: false, // never reuse a socket across checks
        servername: url.hostname.replace(/^\[|\]$/g, ''),
      },
      (res) => {
        timings.firstByte = elapsed(started);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (!wantBody) return;
          size += chunk.length;
          if (size <= MAX_BODY_BYTES) chunks.push(chunk);
          else res.destroy(); // cap reached: stop reading, keep what we have
        });
        const finish = () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
            body: Buffer.concat(chunks).toString('utf8'),
            ...timings,
          });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', reject);
      },
    );
    req.on('socket', (socket) => {
      socket.once('connect', () => (timings.connect = elapsed(started)));
      socket.once('secureConnect', () => (timings.tls = elapsed(started)));
    });
    req.on('error', reject);
    req.end();
  });
}

function classifyNetworkError(error: unknown, deadline: AbortSignal): { failureClass: FailureClass; message: string } {
  if (deadline.aborted) return { failureClass: 'timeout', message: 'No complete response before the timeout.' };
  const code = (error as { code?: string }).code ?? '';
  if (code.startsWith('ERR_TLS') || code.includes('CERT') || code === 'EPROTO') {
    return { failureClass: 'tls', message: `TLS handshake failed (${code}).` };
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) {
    return { failureClass: 'connect', message: `Connection failed (${code}).` };
  }
  return { failureClass: 'error', message: code ? `Request failed (${code}).` : 'Request failed.' };
}

/** HTTP/HTTPS availability check with SSRF protection on every hop. */
export async function runHttpCheck(target: string, config: HttpConfig = {}, policy: TargetPolicy = PUBLIC_ONLY): Promise<CheckResult> {
  const started = process.hrtime.bigint();
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? 10_000, 1_000), 30_000);
  const deadline = AbortSignal.timeout(timeoutMs);
  const expected = config.expectedStatus ?? { min: 200, max: 399 };
  const method = config.method ?? 'GET';
  const follow = config.followRedirects ?? true;

  let url: URL;
  try {
    url = parseTargetUrl(target);
  } catch (error) {
    return { outcome: 'down', failureClass: 'blocked', latencyMs: 0, message: (error as Error).message };
  }

  for (let hop = 0; ; hop += 1) {
    let pinned;
    try {
      pinned = await resolveTarget(url.hostname, policy);
    } catch (error) {
      const rejected = error as TargetRejected;
      return {
        outcome: 'down',
        failureClass: rejected.reason === 'dns' ? 'dns' : 'blocked',
        latencyMs: elapsed(started),
        message: rejected.message,
        finalUrl: url.toString(),
      };
    }

    let response: HopResponse;
    try {
      response = await requestOnce(url, pinned.address, pinned.family, method, deadline, Boolean(config.keyword), started);
    } catch (error) {
      return { outcome: 'down', ...classifyNetworkError(error, deadline), latencyMs: elapsed(started), finalUrl: url.toString() };
    }

    if (follow && REDIRECTS.has(response.statusCode) && response.location) {
      if (hop + 1 > MAX_REDIRECTS) {
        return { outcome: 'down', failureClass: 'status', statusCode: response.statusCode, latencyMs: elapsed(started), message: `More than ${MAX_REDIRECTS} redirects.` };
      }
      let next: URL;
      try {
        next = parseTargetUrl(new URL(response.location, url).toString());
      } catch (error) {
        return { outcome: 'down', failureClass: 'blocked', statusCode: response.statusCode, latencyMs: elapsed(started), message: `Redirect refused: ${(error as Error).message}` };
      }
      if (url.protocol === 'https:' && next.protocol === 'http:') {
        return { outcome: 'down', failureClass: 'blocked', statusCode: response.statusCode, latencyMs: elapsed(started), message: 'Redirect from HTTPS to plain HTTP refused.' };
      }
      url = next;
      continue;
    }

    const total = elapsed(started);
    const timings = { connect: response.connect, tls: response.tls, firstByte: response.firstByte, total };
    const base = { statusCode: response.statusCode, latencyMs: total, timings, finalUrl: url.toString() };
    if (response.statusCode < expected.min || response.statusCode > expected.max) {
      return { outcome: 'down', failureClass: 'status', ...base, message: `Unexpected status ${response.statusCode} (expected ${expected.min}-${expected.max}).` };
    }
    if (config.keyword && !response.body.includes(config.keyword)) {
      return { outcome: 'down', failureClass: 'assertion', ...base, message: 'The expected text was not found in the response.' };
    }
    return { outcome: 'up', ...base, message: `HTTP ${response.statusCode} in ${total} ms.` };
  }
}

/** Certificate validity and expiry (FR-015). */
export async function runSslCheck(host: string, config: SslConfig = {}, policy: TargetPolicy = PUBLIC_ONLY, port = 443): Promise<CheckResult> {
  const started = process.hrtime.bigint();
  const warnDays = Math.min(Math.max(config.warnDays ?? 14, 1), 90);
  let pinned;
  try {
    pinned = await resolveTarget(host, policy);
  } catch (error) {
    const rejected = error as TargetRejected;
    return { outcome: 'down', failureClass: rejected.reason === 'dns' ? 'dns' : 'blocked', latencyMs: elapsed(started), message: rejected.message };
  }

  return new Promise<CheckResult>((resolve) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      lookup: pinnedLookup(pinned.address, pinned.family),
      timeout: 10_000,
      rejectUnauthorized: false, // inspect and report, rather than throw
    });
    const done = (result: CheckResult) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const latencyMs = elapsed(started);
      if (!socket.authorized) {
        return done({ outcome: 'down', failureClass: 'tls', latencyMs, message: `Certificate not trusted (${String(socket.authorizationError)}).` });
      }
      const expiresAt = new Date(cert.valid_to);
      const daysLeft = Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000);
      if (daysLeft < 0) return done({ outcome: 'down', failureClass: 'tls', latencyMs, message: `Certificate expired on ${expiresAt.toISOString().slice(0, 10)}.` });
      if (daysLeft < warnDays) {
        return done({ outcome: 'down', failureClass: 'cert_expiring', latencyMs, message: `Certificate expires in ${daysLeft} days (${expiresAt.toISOString().slice(0, 10)}).` });
      }
      done({ outcome: 'up', latencyMs, message: `Certificate valid for ${daysLeft} more days (until ${expiresAt.toISOString().slice(0, 10)}).` });
    });
    socket.once('timeout', () => done({ outcome: 'down', failureClass: 'timeout', latencyMs: elapsed(started), message: 'TLS handshake timed out.' }));
    socket.once('error', (error) => done({ outcome: 'down', failureClass: 'tls', latencyMs: elapsed(started), message: `TLS connection failed (${(error as { code?: string }).code ?? 'error'}).` }));
  });
}

/** DNS resolution through public resolvers, optionally matching an expected value (FR-016). */
export async function runDnsCheck(host: string, config: DnsConfig = {}, servers = ['1.1.1.1', '8.8.8.8']): Promise<CheckResult> {
  const started = process.hrtime.bigint();
  const type = config.recordType ?? 'A';
  const resolver = new Resolver({ timeout: 5_000, tries: 2 });
  resolver.setServers(servers);
  try {
    const raw = (await resolver.resolve(host, type)) as unknown[];
    const values = raw.map((v) =>
      typeof v === 'string' ? v : Array.isArray(v) ? v.join('') : (v as { exchange?: string }).exchange ?? JSON.stringify(v),
    );
    const latencyMs = elapsed(started);
    if (config.expectedValue && !values.some((v) => v.toLowerCase() === config.expectedValue!.toLowerCase())) {
      return { outcome: 'down', failureClass: 'assertion', latencyMs, message: `${type} records do not include the expected value.` };
    }
    return { outcome: 'up', latencyMs, message: `${values.length} ${type} record(s) resolved.` };
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'error';
    return { outcome: 'down', failureClass: code === 'ETIMEOUT' ? 'timeout' : 'dns', latencyMs: elapsed(started), message: `DNS lookup failed (${code}).` };
  }
}
