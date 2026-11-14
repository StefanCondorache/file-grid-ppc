import type { Metadata } from 'next';
import { StatisticsScreen } from '@/features/statistics/StatisticsScreen';

export const metadata: Metadata = { title: 'Statistici · FileGrid' };

export default function Page() {
  return <StatisticsScreen />;
}
