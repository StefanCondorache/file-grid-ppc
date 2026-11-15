import type { Metadata } from 'next';
import { LiveMapScreen } from '@/features/map/LiveMapScreen';

export const metadata: Metadata = { title: 'Hartă live · FileGrid' };

export default function Page() {
  return <LiveMapScreen />;
}
