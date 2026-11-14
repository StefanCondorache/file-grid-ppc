import { MockMarker } from '@/components/MockMarker';

export default function Home() {
  return (
    <main id="main" className="flex items-center gap-4 p-8">
      <h1 className="text-[28px] font-bold">FileGrid</h1>
      <MockMarker />
    </main>
  );
}
