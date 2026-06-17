// Compact, human relative time ("just now", "3m ago", "2h ago"). Pure so it can
// be unit-tested and rendered client-side, which also dodges the server/UTC
// timezone trap of toLocaleString() on a Vercel function.
export function relativeTime(fromIso: string, nowMs: number = Date.now()): string {
  const then = new Date(fromIso).getTime();
  if (!Number.isFinite(then)) return '';
  const sec = Math.max(0, Math.round((nowMs - then) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
