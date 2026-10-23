import type { Author } from './types';

/** "just now", "5m ago", "3h ago", or a date. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export const whoName = (author: Author): string => (author === 'claude' ? 'Claude' : 'You');
