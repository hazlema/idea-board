/** "just now", "5m ago", "3h ago", or a date. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** The first non-blank line of `text`, trimmed and cut to `max` characters (for "Talking about" labels). */
export function firstLine(text: string, max = 60): string {
  return (text.split('\n').find((line) => line.trim()) ?? '').trim().slice(0, max);
}
