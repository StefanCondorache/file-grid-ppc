'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/errors';
import { safeNext } from '@/lib/auth/safe-next';
import { useT } from '@/lib/i18n';
import { ro } from '@/lib/i18n/ro';
import { useLogin } from './queries';
import { ROLE_OPTIONS, ROLE_ORDER } from './roles';

const schema = z.object({
  role: z.enum(ROLE_ORDER as [string, ...string[]]),
  password: z.string().min(1, ro.auth.passwordRequired),
});
type Values = z.infer<typeof schema>;

type Props = { next: string | null; reason: string | null; onLoggedIn: (path: string) => void };

/** ADR-0022: choose the role (one demo account per role) and enter the password. */
export function LoginForm({ next, reason, onLoggedIn }: Props) {
  const t = useT();
  const login = useLogin();
  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { role: 'auditor', password: '' },
  });

  const onSubmit = handleSubmit(async (v) => {
    await login.mutateAsync({ role: v.role as (typeof ROLE_ORDER)[number], password: v.password });
    onLoggedIn(safeNext(next));
  });

  const err = login.error instanceof ApiError ? login.error : null;
  const errorText = err ? ((t.errors as Record<string, string>)[err.code] ?? t.errors.generic) : null;

  return (
    <form onSubmit={(e) => void onSubmit(e).catch(() => {})} noValidate className="flex flex-col gap-5">
      <h1 className="text-[26px] font-bold">{t.auth.title}</h1>
      {reason === 'expired' && (
        <p className="rounded-panel bg-info-tint px-4 py-3 text-info-ink">{t.auth.expired}</p>
      )}
      <div className="flex flex-col gap-1.5 text-sm font-semibold">
        <label htmlFor="login-role">{t.auth.roleLabel}</label>
        <select
          id="login-role"
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
      {errorText && (
        <p role="alert" className="rounded-panel border border-crit bg-crit-tint px-4 py-3 font-semibold text-crit-ink">
          {errorText}
        </p>
      )}
      <Button type="submit" size="lg" disabled={login.isPending}>
        {login.isPending ? t.auth.submitting : t.auth.submit}
      </Button>
      <p className="text-sm text-ink-2">{t.auth.secureNote}</p>
    </form>
  );
}
