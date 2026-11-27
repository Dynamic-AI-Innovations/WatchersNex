import { FormEvent, InputHTMLAttributes, ReactNode, useId, useState } from 'react';
import { ApiError } from '../lib/api';

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth__brand">
        <div className="auth__product">WatchersNex</div>
        <div className="auth__promise">
          <span className="auth__signal" aria-hidden="true" />
          <h2>Complete Visibility. Intelligent Control.</h2>
          <p>Know what is working, understand what is failing, and know what to do next, across every website and API you run.</p>
        </div>
        <div className="auth__foot">A Dynamics Technology product · Staging environment</div>
      </aside>
      <main className="auth__main">
        <div className="auth__card">{children}</div>
      </main>
    </div>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Field({ label, hint, error, ...input }: FieldProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {hint && !error && <span id={`${id}-hint`} className="hint">{hint}</span>}
      {error && <span id={`${id}-error`} className="error">{error}</span>}
    </div>
  );
}

export function Notice({ kind, title, children }: { kind: 'error' | 'success' | 'info'; title?: string; children?: ReactNode }) {
  return (
    <div className={`notice notice--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div>
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

/** Shows an API problem: its detail, plus the request ID for support when the fault is ours. */
export function ProblemNotice({ error }: { error: ApiError }) {
  return (
    <Notice kind="error" title={error.title}>
      {error.detail}
      {error.status >= 500 && error.requestId && <div>Reference: {error.requestId}</div>}
    </Notice>
  );
}

/** Wraps a submit handler with pending and error state. */
export function useSubmit<T>(action: () => Promise<T>, onSuccess?: (result: T) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await action();
      onSuccess?.(result);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'unknown', 'Something went wrong', 'Please try again.', [], undefined));
    } finally {
      setPending(false);
    }
  };
  return { submit, pending, error };
}
