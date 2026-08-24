import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from '@app/lib/session';
import { ErrorPanel, Loading } from '@app/components/ui';
import { ScrollProgress } from '@app/components/motion';
import { TopBar } from '@app/components/TopBar';
import { Welcome } from '@app/routes/Welcome';

// Route-level splitting keeps the first paint light; the agent page pulls in Three.js.
const Home = lazy(() => import('@app/routes/Home').then((m) => ({ default: m.Home })));
const CreateAgent = lazy(() => import('@app/routes/CreateAgent').then((m) => ({ default: m.CreateAgent })));
const AgentPage = lazy(() => import('@app/routes/AgentPage').then((m) => ({ default: m.AgentPage })));
const ActivityPage = lazy(() => import('@app/routes/ActivityPage').then((m) => ({ default: m.ActivityPage })));
const JobPage = lazy(() => import('@app/routes/JobPage').then((m) => ({ default: m.JobPage })));
const SettingsPage = lazy(() => import('@app/routes/SettingsPage').then((m) => ({ default: m.SettingsPage })));

export function App() {
  const { user, loading, error } = useSession();

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Loading label="Starting XBAM" />
      </main>
    );
  }

  if (error && !user) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl items-center px-6">
        <ErrorPanel
          title="XBAM cannot reach its API."
          detail={`${error}\n\nStart the stack with "docker compose up -d", or run "npm run dev" if you are working locally.`}
          actions={
            <button type="button" className="btn-ghost" onClick={() => window.location.reload()}>
              Try again
            </button>
          }
        />
      </main>
    );
  }

  if (!user) return <Welcome />;

  return (
    <>
      <ScrollProgress />
      <TopBar />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/agents/new" element={<CreateAgent />} />
          <Route path="/agents/:agentId" element={<AgentPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/jobs/:jobId" element={<JobPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
