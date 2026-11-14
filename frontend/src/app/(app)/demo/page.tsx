import type { Metadata } from 'next';
import { ControlRoom } from '@/features/demo/ControlRoom';

export const metadata: Metadata = { title: 'Cameră de control · FileGrid' };

/** SC-10 Cameră de control: demo actions against the real backend and their effect on the same screen. */
export default function DemoPage() {
  return <ControlRoom />;
}
