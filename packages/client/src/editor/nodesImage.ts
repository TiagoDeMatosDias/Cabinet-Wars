const DOT_RADIUS = 19;

/**
 * Draws a nodes image from node positions: one solid dot per node in its exact color on a
 * transparent background. Pixels are written directly (no anti-aliasing) so detection finds
 * the same colors again.
 */
export async function renderNodesImage(nodes: { color: string; x: number; y: number }[], width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (const n of nodes) {
    const c = parseInt(n.color.replace('#', ''), 16);
    const [r, g, b] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
    for (let dy = -DOT_RADIUS; dy <= DOT_RADIUS; dy++) {
      for (let dx = -DOT_RADIUS; dx <= DOT_RADIUS; dx++) {
        if (dx * dx + dy * dy > DOT_RADIUS * DOT_RADIUS) continue;
        const x = Math.round(n.x) + dx;
        const y = Math.round(n.y) + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = (y * width + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** A random color not used by any existing node, so each dot stays identifiable. */
export function unusedColor(used: Iterable<string>): string {
  const taken = new Set([...used].map((c) => c.toLowerCase()));
  for (;;) {
    const c = `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
    if (!taken.has(c)) return c;
  }
}
