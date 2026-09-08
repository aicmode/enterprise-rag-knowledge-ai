'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/client';

type Mode = 'login' | 'register';

/**
 * Email + password authentication.
 *
 * Error-handling note: Supabase distinguishes "user not found" from "wrong
 * password". Both are surfaced here as one generic message on purpose --
 * separate messages would let an attacker enumerate which company email
 * addresses have accounts.
 */
export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isRegister = mode === 'register';
  const redirectedFrom = searchParams.get('redirectedFrom');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return; // guard against double submit

    setError(null);
    setNotice(null);

    if (!email.trim() || !password) {
      setError('メールアドレスとパスワードを入力してください。');
      return;
    }

    if (isRegister && password.length < 8) {
      setError('パスワードは8文字以上で設定してください。');
      return;
    }

    setIsSubmitting(true);

    try {
      const supabase = createClient();

      if (isRegister) {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { display_name: displayName.trim() || undefined },
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });

        if (signUpError) {
          setError('登録に失敗しました。入力内容を確認してください。');
          return;
        }

        // With email confirmation enabled, Supabase returns a user but no
        // session. Tell the user to check their inbox instead of appearing to
        // do nothing.
        if (!data.session) {
          setNotice('確認メールを送信しました。メール内のリンクから登録を完了してください。');
          return;
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });

        if (signInError) {
          setError('メールアドレスまたはパスワードが正しくありません。');
          return;
        }
      }

      // Only relative paths are accepted, so `?redirectedFrom=` cannot be used
      // as an open redirect to an external site.
      const destination =
        redirectedFrom && redirectedFrom.startsWith('/') && !redirectedFrom.startsWith('//')
          ? redirectedFrom
          : '/dashboard';

      router.replace(destination);
      router.refresh();
    } catch {
      setError('通信に失敗しました。ネットワーク環境を確認してもう一度お試しください。');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="p-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          {isRegister ? 'アカウント作成' : 'ログイン'}
        </h1>
        <p className="mt-1.5 text-sm text-ink-subtle">
          {isRegister
            ? '社内資料を登録して、根拠付きの検索を始めましょう。'
            : '登録済みのアカウントでログインしてください。'}
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
          {isRegister ? (
            <Field
              id="displayName"
              label="表示名"
              optional
              value={displayName}
              onChange={setDisplayName}
              type="text"
              autoComplete="name"
              placeholder="山田 太郎"
              disabled={isSubmitting}
            />
          ) : null}

          <Field
            id="email"
            label="メールアドレス"
            value={email}
            onChange={setEmail}
            type="email"
            autoComplete="email"
            placeholder="you@company.co.jp"
            required
            disabled={isSubmitting}
          />

          <Field
            id="password"
            label="パスワード"
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            required
            disabled={isSubmitting}
            hint={isRegister ? '8文字以上で設定してください。' : undefined}
          />

          {error ? <Alert tone="error">{error}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}

          <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                処理中...
              </>
            ) : isRegister ? (
              'アカウントを作成'
            ) : (
              'ログイン'
            )}
          </Button>
        </form>

        <p className="mt-5 text-center text-sm text-ink-subtle">
          {isRegister ? 'すでにアカウントをお持ちですか？ ' : 'アカウントをお持ちでないですか？ '}
          <Link
            href={isRegister ? '/login' : '/register'}
            className="font-medium text-brand-600 hover:text-brand-700 hover:underline"
          >
            {isRegister ? 'ログイン' : '新規登録'}
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type,
  autoComplete,
  placeholder,
  required,
  disabled,
  optional,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  optional?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-center gap-2 text-sm font-medium text-ink">
        {label}
        {optional ? <span className="text-xs font-normal text-ink-faint">任意</span> : null}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="h-11 w-full rounded-lg border border-border-strong bg-surface px-3.5 text-sm text-ink transition-colors placeholder:text-ink-faint hover:border-ink-faint focus:border-brand-500 disabled:bg-surface-muted disabled:text-ink-subtle"
      />
      {hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-ink-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
