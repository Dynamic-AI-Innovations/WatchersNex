import '@fontsource-variable/inter';
import '@fontsource-variable/manrope';
import './styles/tokens.css';
import './styles/app.css';
import { StrictMode, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ProblemNotice } from './components/ui';
import { SessionProvider, useSession } from './lib/session';
import {
  CheckEmailPage,
  ForgotPasswordPage,
  ResetPasswordPage,
  SignInPage,
  SignUpPage,
  VerifyEmailPage,
} from './pages/auth';
import { CreateOrganisationPage, WorkspacePage } from './pages/workspace';

/** Pages that need a session; others are reachable signed out. */
function RequireSession({ children }: { children: ReactNode }) {
  const session = useSession();
  if (session.status === 'loading') return <div className="center-screen">Loading…</div>;
  if (session.status === 'error' && session.error) return <div className="center-screen"><ProblemNotice error={session.error} /></div>;
  if (session.status !== 'signed-in') return <Navigate to="/sign-in" replace />;
  return <>{children}</>;
}

/** Pages for signed-out visitors; signed-in users go to their workspace. */
function GuestOnly({ children }: { children: ReactNode }) {
  const session = useSession();
  if (session.status === 'loading') return <div className="center-screen">Loading…</div>;
  if (session.status === 'signed-in') return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Home() {
  const { organisations } = useSession();
  const first = organisations[0];
  return first ? <Navigate to={`/o/${first.id}`} replace /> : <Navigate to="/onboarding" replace />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route path="/sign-in" element={<GuestOnly><SignInPage /></GuestOnly>} />
          <Route path="/sign-up" element={<GuestOnly><SignUpPage /></GuestOnly>} />
          <Route path="/check-email" element={<CheckEmailPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/forgot-password" element={<GuestOnly><ForgotPasswordPage /></GuestOnly>} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/onboarding" element={<RequireSession><CreateOrganisationPage /></RequireSession>} />
          <Route path="/o/:orgId" element={<RequireSession><WorkspacePage /></RequireSession>} />
          <Route path="/" element={<RequireSession><Home /></RequireSession>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
