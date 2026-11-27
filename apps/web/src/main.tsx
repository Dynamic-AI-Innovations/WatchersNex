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
import { AccountPage } from './pages/account';
import { IncidentDetailPage, IncidentsPage } from './pages/incidents';
import { InvitePage } from './pages/invite';
import { OverviewPage } from './pages/overview';
import { NewServicePage, ServiceDetailPage, ServicesPage } from './pages/services';
import { PreviewPage, SHOW_PREVIEW_MODULES } from './pages/preview';
import { ReportsPage } from './pages/reports';
import { AlertsSettings, AuditLogSettings, GeneralSettings, MembersSettings, PlanSettings, SettingsLayout } from './pages/settings';
import { OrgShell } from './pages/shell';
import { CreateOrganisationPage } from './pages/workspace';

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
          <Route path="/o/:orgId" element={<RequireSession><OrgShell /></RequireSession>}>
            <Route index element={<OverviewPage />} />
            <Route path="services" element={<ServicesPage />} />
            <Route path="services/new" element={<NewServicePage />} />
            <Route path="services/:monitorId" element={<ServiceDetailPage />} />
            <Route path="incidents" element={<IncidentsPage />} />
            <Route path="incidents/:incidentId" element={<IncidentDetailPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="account" element={<AccountPage />} />
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<GeneralSettings />} />
              <Route path="members" element={<MembersSettings />} />
              <Route path="alerts" element={<AlertsSettings />} />
              <Route path="plan" element={<PlanSettings />} />
              <Route path="audit" element={<AuditLogSettings />} />
            </Route>
            {SHOW_PREVIEW_MODULES && (
              <>
                <Route path="observability" element={<PreviewPage module="observability" />} />
                <Route path="dependencies" element={<PreviewPage module="dependencies" />} />
                <Route path="slos" element={<PreviewPage module="slos" />} />
                <Route path="automation" element={<PreviewPage module="automation" />} />
                <Route path="integrations" element={<PreviewPage module="integrations" />} />
              </>
            )}
          </Route>
          <Route path="/invite" element={<InvitePage />} />
          <Route path="/" element={<RequireSession><Home /></RequireSession>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
