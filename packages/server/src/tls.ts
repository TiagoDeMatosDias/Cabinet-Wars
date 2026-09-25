import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { generate } from 'selfsigned';
import { env } from './env';

export interface TlsFiles {
  key: string;
  cert: string;
  /** True when the certificate was made here and browsers will warn about it. */
  selfSigned: boolean;
}

/** IPv4 addresses of this machine on its local networks. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
}

/**
 * The certificate for HTTPS: CABINET_WARS_TLS_CERT/CABINET_WARS_TLS_KEY when given, otherwise a
 * self-signed one kept in `dir`, made again whenever this machine's names or addresses change.
 */
export async function loadTls(dir: string): Promise<TlsFiles> {
  const certFile = env('TLS_CERT');
  const keyFile = env('TLS_KEY');
  if (certFile && keyFile) return { cert: await readFile(certFile, 'utf8'), key: await readFile(keyFile, 'utf8'), selfSigned: false };

  const names = ['localhost', hostname(), `${hostname()}.local`];
  const ips = ['127.0.0.1', '::1', ...lanAddresses()];
  const wanted = JSON.stringify([...names, ...ips].sort());
  try {
    const [cert, key, covers] = await Promise.all(['cert.pem', 'key.pem', 'names.json'].map((f) => readFile(join(dir, f), 'utf8')));
    if (covers === wanted) return { cert, key, selfSigned: true };
  } catch { /* none yet */ }

  const now = new Date();
  const pems = await generate([{ name: 'commonName', value: 'Cabinet Wars' }], {
    keyType: 'ec',
    curve: 'P-256',
    notBeforeDate: new Date(now.getTime() - 86_400_000),
    notAfterDate: new Date(now.getTime() + 825 * 86_400_000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [...names.map((value) => ({ type: 2 as const, value })), ...ips.map((ip) => ({ type: 7 as const, ip }))] },
    ],
  });
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, 'cert.pem'), pems.cert),
    writeFile(join(dir, 'key.pem'), pems.private, { mode: 0o600 }),
    writeFile(join(dir, 'names.json'), wanted),
  ]);
  return { cert: pems.cert, key: pems.private, selfSigned: true };
}
