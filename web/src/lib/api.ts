import type { BoardInfo, HistoryRow, Op, Skipped, VersionMeta, Board } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('Could not reach the board server');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String(body.error) : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const op = (o: Op): Promise<unknown> => post('/api/op', { op: o });

export const undo = (): Promise<{ undone: HistoryRow | null; skipped: Skipped[] }> => post('/api/undo');
export const redo = (): Promise<{ undone: HistoryRow | null; skipped: Skipped[] }> => post('/api/redo');
export const undoTurn = (turn: string): Promise<{ undone: number; skipped: Skipped[] }> => post('/api/undo-turn', { turn });

export async function history(limit?: number, before?: number): Promise<HistoryRow[]> {
  const query = new URLSearchParams();
  if (limit !== undefined) query.set('limit', String(limit));
  if (before !== undefined) query.set('before', String(before));
  const suffix = query.size ? `?${query}` : '';
  return (await request<{ entries: HistoryRow[] }>(`/api/history${suffix}`)).entries;
}

export async function versions(): Promise<VersionMeta[]> {
  return (await request<{ versions: VersionMeta[] }>('/api/versions')).versions;
}

export async function saveVersion(name: string): Promise<VersionMeta> {
  return (await post<{ version: VersionMeta }>('/api/versions', { name })).version;
}

export const readVersion = (id: string): Promise<{ meta: VersionMeta; content: Board }> =>
  request(`/api/versions/${encodeURIComponent(id)}`);

export const restoreVersion = (id: string): Promise<{ restored: VersionMeta; backup: VersionMeta }> =>
  post(`/api/versions/${encodeURIComponent(id)}/restore`);

export async function uploadPicture(blob: Blob): Promise<string> {
  const reply = await request<{ asset: string }>('/api/assets', {
    method: 'POST',
    headers: { 'content-type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  return reply.asset;
}

export async function ingestUrl(url: string): Promise<string> {
  return (await post<{ asset: string }>('/api/assets/url', { url })).asset;
}

export async function exportDoc(): Promise<string> {
  return (await post<{ path: string }>('/api/export')).path;
}

export const boardInfo = (): Promise<BoardInfo> => request('/api/board');
