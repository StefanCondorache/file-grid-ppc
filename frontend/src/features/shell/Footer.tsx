import { ro } from '@/lib/i18n/ro';

export function Footer() {
  return (
    <footer className="glass mt-auto flex flex-wrap justify-between gap-2 border-t px-8 py-4 text-[13px] text-ink-2">
      <span>{ro.common.footer}</span>
      <span>{ro.common.footerTagline}</span>
    </footer>
  );
}
