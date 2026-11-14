import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/** Neutral label (storage, origin, policy version). Not a status. */
export function Tag({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn('inline-flex h-[26px] items-center gap-1.5 rounded-chip bg-sunken px-2 text-[13px] font-semibold text-ink-2', className)}
      {...props}
    />
  );
}
