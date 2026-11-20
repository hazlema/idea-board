import { expect, test } from 'vitest';
import { inline, markdown } from './markdown';

test('inline styles: code, bold, italic, links, and attached files', () => {
  expect(inline('a `x*y*` **b *c* d** [d](https://e.com) 📎 log.txt')).toEqual([
    { text: 'a ' },
    { text: 'x*y*', code: true },
    { text: ' ' },
    { text: 'b ', bold: true },
    { text: 'c', bold: true, italic: true },
    { text: ' d', bold: true },
    { text: ' ' },
    { text: 'd', href: 'https://e.com' },
    { text: ' ' },
    { text: '📎 log.txt', file: 'log.txt' },
  ]);
});

test('arithmetic stars and non-http links stay plain text', () => {
  expect(inline('2 * 3 * 4 and [x](javascript:alert(1))')).toEqual([{ text: '2 * 3 * 4 and [x](javascript:alert(1))' }]);
});

test('blocks: headings, lists, code, quotes, rules, and paragraphs that keep their line breaks', () => {
  const text = '## Plan\nfirst line\nsecond line\n\n- one\n* two\n\n3. three\n4. four\n\n```\n**raw**\n```\n> said\n---';
  expect(markdown(text)).toEqual([
    { kind: 'h', level: 2, spans: [{ text: 'Plan' }] },
    { kind: 'p', spans: [{ text: 'first line\nsecond line' }] },
    { kind: 'ul', items: [[{ text: 'one' }], [{ text: 'two' }]] },
    { kind: 'ol', start: 3, items: [[{ text: 'three' }], [{ text: 'four' }]] },
    { kind: 'code', text: '**raw**' },
    { kind: 'quote', spans: [{ text: 'said' }] },
    { kind: 'hr' },
  ]);
});

test('plain text is one paragraph', () => {
  expect(markdown('just talking')).toEqual([{ kind: 'p', spans: [{ text: 'just talking' }] }]);
});
