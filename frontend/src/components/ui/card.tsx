import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, hero = false, ...props }: ComponentProps<'section'> & { hero?: boolean }) {
  return (
    <section
      className={cn('glass-card tilt-soft p-6 text-card-foreground', hero ? 'rounded-hero' : 'rounded-card', className)}
      {...props}
    />
  );
}
