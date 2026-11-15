import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

// Orange (primary) means "act" and is used for nothing else; status never uses a pill (direction.md §3).
export const buttonVariants = cva(
  // `btn` (globals.css): neumorphic raise, shimmer sweep on hover, springy press; the border keeps a visible edge.
  'btn relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill border-[1.5px] border-transparent font-semibold disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'btn-raised btn-primary bg-primary text-primary-foreground',
        secondary: 'btn-raised border-ink bg-surface text-ink hover:bg-surface-2',
        quiet: 'bg-transparent px-2.5 text-ink hover:bg-surface-2 active:bg-sunken',
        danger: 'btn-raised border-crit bg-surface text-crit-ink hover:bg-crit-tint',
      },
      size: {
        // 32 px to the eye, 40 px to the pointer (invisible hit area).
        sm: 'h-8 px-3.5 text-sm after:absolute after:-inset-1 after:rounded-pill',
        md: 'h-10 px-5 text-[15px]',
        lg: 'h-12 px-6.5 text-base',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
