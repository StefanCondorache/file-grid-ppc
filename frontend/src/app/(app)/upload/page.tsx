import type { Metadata } from 'next';
import { UploadScreen } from '@/features/upload/UploadScreen';

export const metadata: Metadata = { title: 'Încărcare · FileGrid' };

export default function Page() {
  return <UploadScreen />;
}
