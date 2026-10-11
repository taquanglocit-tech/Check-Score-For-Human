export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(typeof error.detail === 'string' ? error.detail : JSON.stringify(error.detail));
  }
  return response.json();
}
export function postJSON<T>(path: string, body: unknown) {
  return api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
export function upload<T>(path: string, file: File) {
  const body = new FormData(); body.append('file', file);
  return api<T>(path, { method: 'POST', body });
}
export function uploadZip<T>(path: string, file: File, meta?: { annotator?: string; parent_id?: string; total_seconds?: number }) {
  const body = new FormData();
  body.append('file', file);
  if (meta?.annotator) body.append('annotator', meta.annotator);
  if (meta?.parent_id) body.append('parent_id', meta.parent_id);
  if (meta?.total_seconds !== undefined) body.append('total_seconds', String(meta.total_seconds));
  return api<T>(path, { method: 'POST', body });
}

