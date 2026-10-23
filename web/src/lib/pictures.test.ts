import { expect, test } from 'vitest';
import { pastedImage, pastedUrl, previewSize } from './pictures';

// jsdom has no ClipboardEvent constructor with clipboardData, so build the parts the helpers read.
function paste(items: { file?: File; text?: string }): ClipboardEvent {
  const files = items.file ? [items.file] : [];
  const clipboardData = {
    files,
    items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    getData: (type: string) => (type === 'text/plain' ? (items.text ?? '') : ''),
  };
  return { clipboardData } as unknown as ClipboardEvent;
}

test('previewSize keeps small pictures and scales big ones to 1568 on the long edge', () => {
  expect(previewSize(800, 600)).toEqual({ w: 800, h: 600 });
  expect(previewSize(4000, 3000)).toEqual({ w: 1568, h: 1176 });
  expect(previewSize(1000, 5000)).toEqual({ w: 314, h: 1568 });
});

test('previewSize honours a smaller edge and an exact fit', () => {
  expect(previewSize(1568, 1568)).toEqual({ w: 1568, h: 1568 });
  expect(previewSize(200, 100, 100)).toEqual({ w: 100, h: 50 });
});

test('pastedImage finds an image file and ignores other files', () => {
  const png = new File(['x'], 'a.png', { type: 'image/png' });
  expect(pastedImage(paste({ file: png }))).toBe(png);
  expect(pastedImage(paste({ file: new File(['x'], 'a.txt', { type: 'text/plain' }) }))).toBeNull();
  expect(pastedImage(paste({ text: 'hello' }))).toBeNull();
});

test('pastedUrl accepts http and https text only', () => {
  expect(pastedUrl(paste({ text: ' https://example.com/a.png ' }))).toBe('https://example.com/a.png');
  expect(pastedUrl(paste({ text: 'http://example.com/x' }))).toBe('http://example.com/x');
  expect(pastedUrl(paste({ text: 'ftp://example.com/a.png' }))).toBeNull();
  expect(pastedUrl(paste({ text: 'javascript:alert(1)' }))).toBeNull();
  expect(pastedUrl(paste({ text: 'see https://example.com' }))).toBeNull();
  expect(pastedUrl(paste({ text: '' }))).toBeNull();
});
