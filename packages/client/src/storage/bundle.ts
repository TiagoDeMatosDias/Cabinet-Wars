import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { LogEntry } from '@krieg/engine';
import type { MapBundle } from '../maps';

/**
 * A .krieg file is a zip: config.json, the map images, and for saved games log.json + meta.json.
 * Saves always carry their map so they can be shared on their own.
 */
export interface SaveMeta {
  title: string;
  date: string;
  mapName: string;
  turn: number;
  current: string;
  /** Which nations were played from which browser, for information only. */
  seats?: Record<string, string>;
}

export interface Bundle {
  map: MapBundle;
  log?: LogEntry[];
  meta?: SaveMeta;
}

export async function packBundle({ map, log, meta }: Bundle): Promise<Blob> {
  const files: Zippable = { 'config.json': strToU8(JSON.stringify(map.config, null, 2)) };
  for (const [name, blob] of Object.entries(map.files)) {
    files[name] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
  }
  if (log) files['log.json'] = strToU8(JSON.stringify(log));
  if (meta) files['meta.json'] = strToU8(JSON.stringify(meta, null, 2));
  return new Blob([zipSync(files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

export async function unpackBundle(blob: Blob, id = `browser:${crypto.randomUUID()}`): Promise<Bundle> {
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const cfgBytes = entries['config.json'];
  if (!cfgBytes) throw new Error('Not a Krieg bundle: config.json is missing');
  const config = JSON.parse(strFromU8(cfgBytes));
  const files: Record<string, Blob> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    const ext = name.split('.').pop()!.toLowerCase();
    if (IMAGE_TYPES[ext]) files[name] = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: IMAGE_TYPES[ext] });
  }
  const map: MapBundle = { id, name: String(config.name ?? 'Unnamed map'), config, files, source: 'browser' };
  return {
    map,
    log: entries['log.json'] ? JSON.parse(strFromU8(entries['log.json'])) : undefined,
    meta: entries['meta.json'] ? JSON.parse(strFromU8(entries['meta.json'])) : undefined,
  };
}
