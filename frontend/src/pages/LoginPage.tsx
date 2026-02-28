import { FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthState';

interface LoginRouteState {
  from?: {
    pathname?: string;
  };
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, isLoading } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const state = location.state as LoginRouteState | null;
  const redirectTo = state?.from?.pathname || '/dashboard';

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const result = await login(email, password);
    if (!result.ok) {
      if (result.nextAction === 'require_new_password') {
        navigate('/password-reset', {
          state: {
            mode: 'new-password-required',
            email: email.trim().toLowerCase()
          }
        });
        return;
      }
      setError(result.message ?? 'ログインに失敗しました。');
      return;
    }
    navigate(redirectTo, { replace: true });
  }

  return (
    <div className="login-root">
      <section className="login-card">
        <h1>KinTrain ログイン</h1>
        <p className="muted">メールアドレスとパスワードでログインしてください。</p>

        <form className="stack-md" onSubmit={onSubmit}>
          <label>
            メールアドレス
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>

          <label>
            パスワード
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8文字以上"
              minLength={8}
              required
            />
          </label>

          {error && <p className="status-text">{error}</p>}

          <button type="submit" className="btn primary large" disabled={isLoading}>
            {isLoading ? 'ログイン中...' : 'ログイン'}
          </button>

          <Link to="/password-reset" className="text-link">
            パスワードを再設定する
          </Link>
        </form>
      </section>
    </div>
  );
}
