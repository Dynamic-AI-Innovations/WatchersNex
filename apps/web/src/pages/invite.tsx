import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AuthLayout, Notice, ProblemNotice } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';

type Preview = Awaited<ReturnType<typeof api.invitationPreview>>;

/** Invitation landing page: works signed out (sign in or create an account first) and signed in. */
export function InvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const session = useSession();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<Preview | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const [accepting, setAccepting] = useState(false);
  const back = `/invite?token=${encodeURIComponent(token)}`;

  useEffect(() => {
    api.invitationPreview(token).then(setPreview, (e) => setError(e instanceof ApiError ? e : undefined));
  }, [token]);

  const accept = async () => {
    setAccepting(true);
    setError(undefined);
    try {
      const { organisationId } = await api.acceptInvitation(token);
      await session.refresh();
      navigate(`/o/${organisationId}`, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e : undefined);
      setAccepting(false);
    }
  };

  const signedInAs = session.user?.email;
  const wrongAccount = preview && signedInAs && signedInAs !== preview.email;

  return (
    <AuthLayout>
      <h1>Join an organisation</h1>
      {!preview && !error && <p className="lede">Checking your invitation…</p>}
      {error && <ProblemNotice error={error} />}
      {preview && (
        <>
          <p className="lede">
            You've been invited to join <strong>{preview.organisationName}</strong> on WatchersNex as {preview.role === 'admin' ? 'an admin' : `an ${preview.role}`}.
          </p>
          {session.status === 'signed-in' ? (
            wrongAccount ? (
              <Notice kind="error" title="Different account">
                This invitation is for {preview.email}, but you're signed in as {signedInAs}. Sign out and sign in with {preview.email}.
              </Notice>
            ) : (
              <button className="button button--primary button--block" disabled={accepting} onClick={accept}>
                {accepting ? 'Joining…' : `Join ${preview.organisationName}`}
              </button>
            )
          ) : (
            <div className="form">
              <Link className="button button--primary button--block" to={`/sign-in?next=${encodeURIComponent(back)}`}>Sign in to accept</Link>
              <Link className="button button--secondary button--block" to={`/sign-up?next=${encodeURIComponent(back)}&email=${encodeURIComponent(preview.email)}`}>Create an account with {preview.email}</Link>
            </div>
          )}
          <p className="auth__alt small">The invitation expires {new Date(preview.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.</p>
        </>
      )}
    </AuthLayout>
  );
}
