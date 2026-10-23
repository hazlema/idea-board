// Pictures on the Brainstorm tab: the smaller copy Claude looks at, and what
// a paste carries.

/** The longest edge Claude's image input uses without scaling. */
export const PREVIEW_EDGE = 1568;
const PREVIEW_QUALITY = 0.85;

/** The size of the preview: unchanged when it already fits, else scaled so the long edge is `maxEdge`. */
export function previewSize(w: number, h: number, maxEdge = PREVIEW_EDGE): { w: number; h: number } {
  if (w <= maxEdge && h <= maxEdge) return { w, h };
  const scale = maxEdge / Math.max(w, h);
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

/** A JPEG copy of the picture at `previewSize`, on white so transparent parts don't turn black. */
export async function makePreview(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { w, h } = previewSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not make a preview of the picture');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, w, h);
    context.drawImage(bitmap, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('Could not make a preview of the picture'))), 'image/jpeg', PREVIEW_QUALITY),
    );
  } finally {
    bitmap.close();
  }
}

/** The image file a paste carries, if any. */
export function pastedImage(e: ClipboardEvent): File | null {
  const items = Array.from(e.clipboardData?.items ?? []);
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

/** The pasted text when it is a single http(s) address, else null. */
export function pastedUrl(e: ClipboardEvent): string | null {
  const text = (e.clipboardData?.getData('text/plain') ?? '').trim();
  if (!text || /\s/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}
