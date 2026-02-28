import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { AiChatPage } from './pages/AiChatPage';
import { CalendarPage } from './pages/CalendarPage';
import { DailyPage } from './pages/DailyPage';
import { DashboardPage } from './pages/DashboardPage';
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

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route element={<AppLayout />}>
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
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
