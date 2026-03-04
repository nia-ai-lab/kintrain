import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAppState } from '../AppState';

const links = [
  { to: '/dashboard', label: 'ホーム' },
  { to: '/training-session', label: '実施' },
  { to: '/calendar', label: 'カレンダー' },
  { to: '/training-menu', label: 'メニュー' },
  { to: '/ai-chat', label: 'AIチャット' }
];

export function AppLayout() {
  const { data } = useAppState();
  const userAvatarUrl = data.userProfile.userAvatarImageUrl;

  return (
    <div className="app-root">
      <header className="top-header">
        <div className="top-header-main">
          <Link to="/dashboard" className="brand">
            <img src="/icons/icon-192.png" alt="" className="brand-icon" aria-hidden="true" />
            KinTrain
          </Link>
          <Link to="/settings" className="header-user-icon-link" aria-label="ユーザ設定">
            {userAvatarUrl ? (
              <img src={userAvatarUrl} alt="ユーザアイコン" className="header-user-avatar-image" />
            ) : (
              <span className="header-user-icon" aria-hidden="true">
                👤
              </span>
            )}
          </Link>
        </div>
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
