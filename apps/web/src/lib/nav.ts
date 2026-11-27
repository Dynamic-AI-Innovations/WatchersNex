/**
 * The return path after sign-in or sign-up. Only same-site relative paths are
 * accepted, so a crafted link can't send someone to another site after they
 * sign in (open redirect): "//host" and "/\host" are rejected.
 */
export function safeNext(value: string | null | undefined): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}
