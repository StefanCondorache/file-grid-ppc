import { CloudLightning, Cpu, History, User, type LucideIcon } from 'lucide-react';
import { Tag } from '@/components/ui/tag';
import type { Origin } from '@/lib/api/types';
import { useT } from '@/lib/i18n';

const ICON: Record<Origin, LucideIcon> = { manual: User, simulator: Cpu, storm: CloudLightning, seed: History };

/** Where a stored item came from (BA-64): generated data is real data, tagged so it can be told apart and hidden. */
export function OriginTag({ origin }: { origin: Origin }) {
  const t = useT();
  const Icon = ICON[origin] ?? User;
  return (
    <Tag>
      <Icon aria-hidden="true" className="size-3.5" />
      {t.files.origin[origin] ?? origin}
    </Tag>
  );
}
