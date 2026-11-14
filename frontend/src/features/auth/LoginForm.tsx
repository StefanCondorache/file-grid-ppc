'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/errors';
import { safeNext } from '@/lib/auth/safe-next';
import { useT } from '@/lib/i18n';
import { ro } from '@/lib/i18n/ro';
import { useLogin, useLoginOptions } from './queries';
import { ROLE_OPTIONS, ROLE_ORDER } from './roles';

const role = z.enum(ROLE_ORDER as [string, ...string[]]);
const withPassword = zodResolver(z.object({ role, password: z.string().min(1, ro.auth.passwordRequired) }));
// Passwordless demo login: the password field is not shown, so it is not validated either.
const roleOnly = zodResolver(z.object({ role, password: z.string() }));
type Values = { role: string; password: string };

type Props = { next: string | null; reason: string | null; onLoggedIn: (path: string) => void };

/**
 * ADR-0022: choose the role (one demo account per role) and enter the password. While the backend's
 * temporary demo switch is on (GET /auth/login-options), only the role is asked for.
 */
export function LoginForm({ next, reason, onLoggedIn }: Props) {
  const t = useT();
  const login = useLogin();
  const options = useLoginOptions();
  const loading = options.isPending;
  // If the options cannot be read, fall back to the usual form with a password.
  const passwordless = options.data?.passwordless === true;
  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: passwordless ? roleOnly : withPassword,
    defaultValues: { role: 'auditor', password: '' },
  });

  const onSubmit = handleSubmit(async (v) => {
    const chosen = v.role as (typeof ROLE_ORDER)[number];
    await login.mutateAsync(passwordless ? { role: chosen } : { role: chosen, password: v.password });
    onLoggedIn(safeNext(next));
  });

  const err = login.error instanceof ApiError ? login.error : null;
  const errorText = err ? ((t.errors as Record<string, string>)[err.code] ?? t.errors.generic) : null;

  return (
    <form
      onSubmit={(e) => void onSubmit(e).catch(() => {})}
      noValidate
      aria-busy={loading || undefined}
      className="flex flex-col gap-5"
    >
      <h1 className="text-[26px] font-bold">{t.auth.title}</h1>
      {reason === 'expired' && (
        <p className="rounded-panel bg-info-tint px-4 py-3 text-info-ink">{t.auth.expired}</p>
      )}
      {/* Disabled until the login options are known, so the form never flips under the user's hands. */}
      <fieldset disabled={loading} className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-col gap-1.5 text-sm font-semibold">
          <label htmlFor="login-role">{t.auth.roleLabel}</label>
          <select
            id="login-role"
            aria-describedby={passwordless ? 'login-passwordless-note' : undefined}
            {...register('role')}
            className="h-11 rounded-control border-[1.5px] border-input bg-surface px-3 text-[15px] font-normal text-ink"
          >
            {ROLE_OPTIONS.map((o) => (
              <option key={o.role} value={o.role}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {!loading && !passwordless && (
          <div className="flex flex-col gap-1.5 text-sm font-semibold">
            <label htmlFor="login-password">{t.auth.passwordLabel}</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              aria-invalid={formState.errors.password ? true : undefined}
              aria-describedby={formState.errors.password ? 'password-error' : undefined}
              {...register('password')}
              className="h-11 rounded-control border-[1.5px] border-input bg-surface px-3 text-[15px] font-normal text-ink"
            />
            {formState.errors.password && (
              <span id="password-error" className="font-normal text-crit-ink">
                {formState.errors.password.message}
              </span>
            )}
          </div>
        )}
        {errorText && (
          <p role="alert" className="rounded-panel border border-crit bg-crit-tint px-4 py-3 font-semibold text-crit-ink">
            {errorText}
          </p>
        )}
        <Button type="submit" size="lg" disabled={login.isPending}>
          {login.isPending ? t.auth.submitting : t.auth.submit}
        </Button>
      </fieldset>
      {passwordless && (
        <p id="login-passwordless-note" className="text-sm font-semibold text-info-ink">
          {t.auth.passwordlessNote}
        </p>
      )}
      <p className="text-sm text-ink-2">{t.auth.secureNote}</p>
    </form>
  );
}
