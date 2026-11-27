import type { CookieOptions, Response } from 'express';
import type { AppConfig } from '../config/config.js';

export const SESSION_ABSOLUTE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * With HTTPS, the __Host- prefix makes the browser reject the cookie unless it
 * is Secure, has Path=/ and no Domain, so a sibling subdomain can't set or
 * overwrite it. Plain names are used only for local HTTP development and tests.
 */
export function cookieNames(config: AppConfig): { session: string; csrf: string } {
  return config.SESSION_COOKIE_SECURE
    ? { session: '__Host-wnx_session', csrf: '__Host-wnx_csrf' }
    : { session: 'wnx_session', csrf: 'wnx_csrf' };
}

function base(config: AppConfig): CookieOptions {
  return { secure: config.SESSION_COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: SESSION_ABSOLUTE_MS };
}

export function setSessionCookies(
  res: Response,
  config: AppConfig,
  sessionToken: string,
  csrfToken: string,
): void {
  const names = cookieNames(config);
  res.cookie(names.session, sessionToken, { ...base(config), httpOnly: true });
  // Readable by the web app, which echoes it in X-CSRF-Token (double-submit).
  res.cookie(names.csrf, csrfToken, { ...base(config), httpOnly: false });
}

export function clearSessionCookies(res: Response, config: AppConfig): void {
  const names = cookieNames(config);
  const { maxAge: _maxAge, ...options } = base(config);
  res.clearCookie(names.session, { ...options, httpOnly: true });
  res.clearCookie(names.csrf, options);
}
