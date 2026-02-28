import { Link, NavLink, Outlet } from 'react-router-dom';

const links = [
  { to: '/dashboard', label: 'ホーム' },
  { to: '/training-session', label: '実施' },
  { to: '/calendar', label: 'カレンダー' },
  { to: '/training-menu', label: 'メニュー' },
  { to: '/ai-chat', label: 'AIチャット' }
];

export function AppLayout() {
  return (
    <div className="app-root">
      <header className="top-header">
        <div className="top-header-main">
          <Link to="/dashboard" className="brand">
            <span className="brand-dot" />
            KinTrain Mock
          </Link>
          <Link to="/settings" className="header-user-icon-link" aria-label="ユーザ設定">
            <span className="header-user-icon" aria-hidden="true">
              👤
            </span>
          </Link>
        </div>
        <p className="header-subtitle">AIコーチ（ニャル子）対応 / モックUI</p>
      </header>

      <main className="page-shell">
        <Outlet />
      </main>

      <nav className="bottom-nav" aria-label="メインナビゲーション">
        {links.map((link) => (
          <NavLink key={link.to} to={link.to} className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
            {link.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
