import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, hero = false, ...props }: ComponentProps<'section'> & { hero?: boolean }) {
  return (
    <section
      className={cn('border border-border bg-card p-6 text-card-foreground shadow-e1', hero ? 'rounded-hero' : 'rounded-card', className)}
      {...props}
    />
  );
}
