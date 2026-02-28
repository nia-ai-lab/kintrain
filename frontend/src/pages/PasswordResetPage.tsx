import { FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthState';

interface PasswordResetRouteState {
  mode?: 'new-password-required';
  email?: string;
}

export function PasswordResetPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { pendingSignInEmail, completeNewPassword, beginForgotPassword, confirmForgotPassword, isLoading } = useAuth();
  const routeState = (location.state as PasswordResetRouteState | null) ?? {};

  const requiredEmail = pendingSignInEmail || routeState.email || '';
  const isNewPasswordRequired = routeState.mode === 'new-password-required' || !!pendingSignInEmail;

  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState('');

  const [email, setEmail] = useState(requiredEmail);
  const [isCodeSent, setIsCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [forgotPassword, setForgotPassword] = useState('');
  const [forgotPasswordConfirm, setForgotPasswordConfirm] = useState('');

  function validatePasswordPair(passwordA: string, passwordB: string): boolean {
    if (passwordA.trim().length < 8) {
      setErrorText('パスワードは8文字以上で入力してください。');
      return false;
    }
    if (passwordA !== passwordB) {
      setErrorText('確認用パスワードが一致しません。');
      return false;
    }
    return true;
  }

  async function onSubmitNewPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatusText('');
    setErrorText('');
    if (!validatePasswordPair(newPassword, newPasswordConfirm)) {
      return;
    }
    const result = await completeNewPassword(newPassword);
    if (!result.ok) {
      setErrorText(result.message ?? 'パスワード設定に失敗しました。');
      return;
    }
    navigate('/dashboard', { replace: true });
  }

  async function onSendCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatusText('');
    setErrorText('');
    const result = await beginForgotPassword(email);
    if (!result.ok) {
      setErrorText(result.message ?? '確認コード送信に失敗しました。');
      return;
    }
    setIsCodeSent(true);
    setStatusText('確認コードを送信しました。メールを確認してください。');
  }

  async function onConfirmForgotPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatusText('');
    setErrorText('');
    if (!validatePasswordPair(forgotPassword, forgotPasswordConfirm)) {
      return;
    }
    const result = await confirmForgotPassword(email, code, forgotPassword);
    if (!result.ok) {
      setErrorText(result.message ?? 'パスワード再設定に失敗しました。');
      return;
    }
    setStatusText('パスワードを再設定しました。ログイン画面に戻ってください。');
  }

  return (
    <div className="login-root">
      <section className="login-card">
        <h1>パスワード再設定</h1>
        <p className="muted">テストユーザで再設定が必要な場合は、以下から設定してください。</p>

        {isNewPasswordRequired && (
          <form className="stack-md" onSubmit={onSubmitNewPassword}>
            <h2>新しいパスワード設定</h2>
            <p className="muted">対象: {requiredEmail || 'ログイン中ユーザ'}</p>
            <label>
              新しいパスワード
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </label>
            <label>
              新しいパスワード（確認）
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={newPasswordConfirm}
                onChange={(e) => setNewPasswordConfirm(e.target.value)}
                required
              />
            </label>
            <button type="submit" className="btn primary large" disabled={isLoading}>
              {isLoading ? '設定中...' : '設定してログイン'}
            </button>
          </form>
        )}

        <form className="stack-md" onSubmit={onSendCode}>
          <h2>メールで再設定</h2>
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
          <button type="submit" className="btn ghost" disabled={isLoading}>
            確認コードを送信
          </button>
        </form>

        {isCodeSent && (
          <form className="stack-md" onSubmit={onConfirmForgotPassword}>
            <label>
              確認コード
              <input value={code} onChange={(e) => setCode(e.target.value)} required />
            </label>
            <label>
              新しいパスワード
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={forgotPassword}
                onChange={(e) => setForgotPassword(e.target.value)}
                required
              />
            </label>
            <label>
              新しいパスワード（確認）
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={forgotPasswordConfirm}
                onChange={(e) => setForgotPasswordConfirm(e.target.value)}
                required
              />
            </label>
            <button type="submit" className="btn primary">
              パスワードを再設定
            </button>
          </form>
        )}

        {errorText && <p className="status-text">{errorText}</p>}
        {statusText && <p className="status-text">{statusText}</p>}
        <Link to="/login" className="text-link">
          ログイン画面へ戻る
        </Link>
      </section>
    </div>
  );
}
