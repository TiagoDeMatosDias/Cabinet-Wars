import { idb } from './storage/idb';

/** A map as the client handles it: raw config JSON plus its image files. */
export interface MapBundle {
  id: string;
  name: string;
  /** Raw config.json contents; may be incomplete while being edited. */
  config: Record<string, unknown>;
  files: Record<string, Blob>;
  source: 'server' | 'browser';
}

export interface ServerMapInfo {
  id: string;
  name: string;
  files: string[];
  ready: boolean;
  /** Language codes the map offers (English always first). */
  languages?: string[];
  languageNames?: Record<string, string>;
}

export const backgroundName = (m: MapBundle) => String(m.config.background ?? 'map.png');
export const nodesImageName = (m: MapBundle) => String(m.config.nodesImage ?? 'nodes.png');

export async function listServerMaps(): Promise<ServerMapInfo[]> {
  try {
    const res = await fetch('/api/maps');
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

/** Downloads a file, reporting the bytes received so far and the total (0 when unknown). */
async function fetchBlob(url: string, onBytes?: (got: number, total: number) => void): Promise<Blob | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!onBytes || !res.body) return res.blob();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes(got, total);
  }
  return new Blob(chunks, { type: res.headers.get('content-type') ?? '' });
}

/** Loads a map the server provides. `onProgress` gets the share downloaded so far, 0 to 1. */
export async function loadServerMap(id: string, onProgress?: (share: number) => void): Promise<MapBundle> {
  const base = `/api/maps/${encodeURIComponent(id)}/`;
  const text = await fetch(base + 'config.json').then((r) => (r.ok ? r.text() : ''));
  let config: Record<string, unknown> = {};
  try { config = text.trim() ? JSON.parse(text) : {}; } catch { throw new Error(`${id}/config.json is not valid JSON`); }
  const map: MapBundle = { id: `server:${id}`, name: String(config.name ?? id), config, files: {}, source: 'server' };
  const emblemImages = Array.isArray(config.nations)
    ? (config.nations as { emblem?: { image?: string } }[]).map((n) => n.emblem?.image).filter((x): x is string => !!x)
    : [];
  for (const name of new Set([backgroundName(map), nodesImageName(map), ...emblemImages])) {
    // The background image is nearly all of it.
    const onBytes = name === backgroundName(map) && onProgress ? (got: number, total: number) => { if (total) onProgress(got / total); } : undefined;
    const blob = await fetchBlob(base + encodeURIComponent(name), onBytes);
    if (blob) map.files[name] = blob;
  }
  return map;
}

export async function listBrowserMaps(): Promise<MapBundle[]> {
  return (await idb.all<MapBundle>('maps')).map((m) => ({ ...m, source: 'browser' as const }));
}

export async function saveBrowserMap(map: MapBundle) {
  await idb.put('maps', { ...map, source: 'browser' });
}

/** Content hash so peers can tell whether they already have a map. */
export async function mapHash(map: MapBundle): Promise<string> {
  const parts: BlobPart[] = [JSON.stringify(map.config)];
  for (const k of Object.keys(map.files).sort()) parts.push(k, map.files[k]);
  const buf = await new Blob(parts).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
