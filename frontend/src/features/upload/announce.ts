import { ro } from '@/lib/i18n/ro';
import type { UploadItemView } from '@/lib/upload/store';

export interface Announcement {
  text: string;
  priority: 'polite' | 'assertive';
}

const MARKS = [25, 50, 75, 100];
const pct = (i: UploadItemView) => (i.size > 0 ? Math.floor((Math.min(i.size, i.bytesConfirmed) / i.size) * 100) : 0);

/** What a screen reader hears when an upload row changes: state changes always, progress only at 25/50/75/100 %. */
export function uploadAnnouncements(prev: UploadItemView, next: UploadItemView): Announcement | null {
  const u = ro.upload;
  const name = next.displayName;
  if (prev.state !== next.state) {
    if (next.state === 'failed') {
      const why = next.error?.message ?? u.failure[next.failReason ?? 'unknown'];
      return { text: `${name}: ${u.stateLabel.failed}. ${why}`, priority: 'assertive' };
    }
    return { text: `${name}: ${u.stateLabel[next.state]}`, priority: 'polite' };
  }
  const a = pct(prev);
  const b = pct(next);
  if (next.state === 'uploading' && MARKS.some((m) => a < m && b >= m)) {
    const mark = [...MARKS].reverse().find((m) => a < m && b >= m)!;
    return { text: `${name}: ${mark}%`, priority: 'polite' };
  }
  return null;
}
