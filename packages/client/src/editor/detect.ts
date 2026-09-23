export interface DetectedNode {
  color: string;
  x: number;
  y: number;
  pixels: number;
}

const MIN_PIXELS = 30;
const MIN_ALPHA = 200;

/**
 * Finds node dots in a nodes image: every connected blob of one exact opaque color is a node,
 * located at its centroid. Two dots may share a color; they are still separate nodes.
 */
export async function detectNodes(image: Blob): Promise<{ nodes: DetectedNode[]; width: number; height: number }> {
  const bitmap = await createImageBitmap(image);
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;
  const rgb = new Int32Array(width * height).fill(-1);
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] >= MIN_ALPHA) rgb[i] = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
  }
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const nodes: DetectedNode[] = [];
  for (let start = 0; start < rgb.length; start++) {
    if (rgb[start] < 0 || seen[start]) continue;
    const color = rgb[start];
    let top = 0;
    let count = 0;
    let sx = 0;
    let sy = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const p = stack[--top];
      const x = p % width;
      const y = (p - x) / width;
      count++;
      sx += x;
      sy += y;
      const push = (q: number) => { if (!seen[q] && rgb[q] === color) { seen[q] = 1; stack[top++] = q; } };
      if (x > 0) push(p - 1);
      if (x < width - 1) push(p + 1);
      if (y > 0) push(p - width);
      if (y < height - 1) push(p + width);
    }
    if (count >= MIN_PIXELS) {
      nodes.push({ color: `#${color.toString(16).padStart(6, '0')}`, x: Math.round(sx / count), y: Math.round(sy / count), pixels: count });
    }
  }
  return { nodes, width, height };
}
