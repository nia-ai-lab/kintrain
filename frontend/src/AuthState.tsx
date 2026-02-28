import { confirmResetPassword, confirmSignIn, fetchAuthSession, resetPassword, signIn, signOut } from 'aws-amplify/auth';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

interface AuthSnapshot {
  isAuthenticated: boolean;
  email: string;
}

interface AuthContextValue extends AuthSnapshot {
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ ok: boolean; message?: string; nextAction?: 'require_new_password' }>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  pendingSignInEmail: string;
  completeNewPassword: (newPassword: string) => Promise<{ ok: boolean; message?: string }>;
  beginForgotPassword: (email: string) => Promise<{ ok: boolean; message?: string }>;
  confirmForgotPassword: (email: string, code: string, newPassword: string) => Promise<{ ok: boolean; message?: string }>;
}

const initialAuth: AuthSnapshot = {
  isAuthenticated: false,
  email: ''
};

const AuthContext = createContext<AuthContextValue | null>(null);

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<AuthSnapshot>(initialAuth);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingSignInEmail, setPendingSignInEmail] = useState('');

  useEffect(() => {
    const hydrate = async () => {
      setIsLoading(true);
      try {
        const session = await fetchAuthSession();
        const accessToken = session.tokens?.accessToken?.toString() ?? '';
        if (!accessToken) {
          setAuth(initialAuth);
          return;
        }
        const emailClaim = session.tokens?.idToken?.payload?.email;
        setAuth({
          isAuthenticated: true,
          email: typeof emailClaim === 'string' ? emailClaim : ''
        });
      } catch {
        setAuth(initialAuth);
      } finally {
        setIsLoading(false);
      }
    };
    void hydrate();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...auth,
      isLoading,
      login: async (email, password) => {
        const normalizedEmail = email.trim().toLowerCase();
        if (!isValidEmail(normalizedEmail)) {
          return { ok: false, message: 'メールアドレス形式が不正です。' };
        }
        if (password.trim().length < 8) {
          return { ok: false, message: 'パスワードは8文字以上で入力してください。' };
        }
        try {
          setIsLoading(true);
          const result = await signIn({ username: normalizedEmail, password });
          if (!result.isSignedIn) {
            if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
              setPendingSignInEmail(normalizedEmail);
              return {
                ok: false,
                nextAction: 'require_new_password',
                message: '新しいパスワードの設定が必要です。'
              };
            }
            return { ok: false, message: '追加の認証ステップが必要です。Cognito設定を確認してください。' };
          }
          const session = await fetchAuthSession();
          const emailClaim = session.tokens?.idToken?.payload?.email;
          setAuth({
            isAuthenticated: true,
            email: typeof emailClaim === 'string' ? emailClaim : normalizedEmail
          });
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'ログインに失敗しました。';
          return { ok: false, message };
        } finally {
          setIsLoading(false);
        }
      },
      logout: async () => {
        try {
          await signOut();
        } finally {
          setPendingSignInEmail('');
          setAuth(initialAuth);
        }
      },
      getAccessToken: async () => {
        try {
          const session = await fetchAuthSession();
          return session.tokens?.accessToken?.toString() ?? null;
        } catch {
          return null;
        }
      },
      pendingSignInEmail,
      completeNewPassword: async (newPassword) => {
        if (newPassword.trim().length < 8) {
          return { ok: false, message: 'パスワードは8文字以上で入力してください。' };
        }
        try {
          setIsLoading(true);
          const result = await confirmSignIn({ challengeResponse: newPassword });
          if (!result.isSignedIn) {
            return { ok: false, message: 'パスワード設定を完了できませんでした。' };
          }
          const session = await fetchAuthSession();
          const emailClaim = session.tokens?.idToken?.payload?.email;
          setAuth({
            isAuthenticated: true,
            email: typeof emailClaim === 'string' ? emailClaim : pendingSignInEmail
          });
          setPendingSignInEmail('');
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'パスワード設定に失敗しました。';
          return { ok: false, message };
        } finally {
          setIsLoading(false);
        }
      },
      beginForgotPassword: async (email) => {
        const normalizedEmail = email.trim().toLowerCase();
        if (!isValidEmail(normalizedEmail)) {
          return { ok: false, message: 'メールアドレス形式が不正です。' };
        }
        try {
          await resetPassword({ username: normalizedEmail });
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : '確認コード送信に失敗しました。';
          return { ok: false, message };
        }
      },
      confirmForgotPassword: async (email, code, newPassword) => {
        const normalizedEmail = email.trim().toLowerCase();
        if (!isValidEmail(normalizedEmail)) {
          return { ok: false, message: 'メールアドレス形式が不正です。' };
        }
        if (!code.trim()) {
          return { ok: false, message: '確認コードを入力してください。' };
        }
        if (newPassword.trim().length < 8) {
          return { ok: false, message: 'パスワードは8文字以上で入力してください。' };
        }
        try {
          await confirmResetPassword({
            username: normalizedEmail,
            confirmationCode: code.trim(),
            newPassword
          });
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'パスワード再設定に失敗しました。';
          return { ok: false, message };
        }
      }
    }),
    [auth, isLoading, pendingSignInEmail]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
