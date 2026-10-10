import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAppState } from '../AppState';

const links = [
  {
    to: '/dashboard',
    label: 'ホーム',
    icon: (
      <>
        <path d="M4 10.5 12 4l8 6.5" />
        <path d="M6 9v10a1 1 0 0 0 1 1h3.5v-5.5h3V20H17a1 1 0 0 0 1-1V9" />
      </>
    )
  },
  {
    to: '/training-session',
    label: '実施',
    icon: (
      <>
        <path d="M6.5 7v10M17.5 7v10" />
        <path d="M3.5 9.5v5M20.5 9.5v5" />
        <path d="M6.5 12h11" />
      </>
    )
  },
  {
    to: '/calendar',
    label: 'カレンダー',
    icon: (
      <>
        <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
        <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
      </>
    )
  },
  {
    to: '/training-menu',
    label: 'メニュー',
    icon: (
      <>
        <path d="M9 6.5h10M9 12h10M9 17.5h10" />
        <path d="M5 6.5h.01M5 12h.01M5 17.5h.01" />
      </>
    )
  },
  {
    to: '/ai-chat',
    label: 'AIチャット',
    icon: (
      <>
        <path d="M20 12a7.5 7.5 0 0 1-11 6.6L4.5 20l1.3-4.2A7.5 7.5 0 1 1 20 12Z" />
        <path d="M9 11h.01M12 11h.01M15 11h.01" />
      </>
    )
  }
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
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="8.5" r="4" />
                  <path d="M4.5 20c.6-3.9 3.7-6.5 7.5-6.5s6.9 2.6 7.5 6.5Z" />
                </svg>
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
            <span className="nav-item-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">{link.icon}</svg>
            </span>
            <span className="nav-item-label">{link.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
