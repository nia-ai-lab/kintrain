import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './AuthState';
import { AppLayout } from './components/AppLayout';
import { AiChatPage } from './pages/AiChatPage';
import { CalendarPage } from './pages/CalendarPage';
import { DailyPage } from './pages/DailyPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { PasswordResetPage } from './pages/PasswordResetPage';
import { SettingsPage } from './pages/SettingsPage';
import { TrainingMenuAiGeneratePage } from './pages/TrainingMenuAiGeneratePage';
import { TrainingMenuPage } from './pages/TrainingMenuPage';
import { TrainingSessionPage } from './pages/TrainingSessionPage';

function PlaceholderPage({ title }: { title: string }) {
  return (
    <section className="card">
      <h1>{title}</h1>
      <p className="muted">モックUIでは詳細未実装です。</p>
    </section>
  );
}

function AuthLoadingPage() {
  return (
    <div className="login-root">
      <section className="login-card">
        <p className="muted">認証状態を確認しています...</p>
      </section>
    </div>
  );
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) {
    return <AuthLoadingPage />;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return children;
}

export function App() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) {
    return <AuthLoadingPage />;
  }
  return (
    <Routes>
      <Route path="/" element={<Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />} />
      <Route path="/login" element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginPage />} />
      <Route path="/password-reset" element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <PasswordResetPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/training-session" element={<TrainingSessionPage />} />
        <Route path="/training-menu" element={<TrainingMenuPage />} />
        <Route path="/training-menu/ai-generate" element={<TrainingMenuAiGeneratePage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/daily/:date" element={<DailyPage />} />
        <Route path="/history" element={<PlaceholderPage title="履歴" />} />
        <Route path="/progress" element={<PlaceholderPage title="進捗" />} />
        <Route path="/ai-chat" element={<AiChatPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />} />
    </Routes>
  );
}
