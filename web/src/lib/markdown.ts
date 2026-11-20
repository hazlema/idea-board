// Basic markdown for chat messages, as tokens Svelte renders itself (never HTML), so a message cannot inject markup.

export type Span = { text: string; bold?: true; italic?: true; code?: true; href?: string; file?: string };

export type Block =
  | { kind: 'p' | 'quote'; spans: Span[] }
  | { kind: 'h'; level: number; spans: Span[] }
  | { kind: 'ul'; items: Span[][] }
  | { kind: 'ol'; start: number; items: Span[][] }
  | { kind: 'code'; text: string }
  | { kind: 'hr' };

// One alternation, first match wins: `code`, **bold**, *italic*, [text](http…), and "📎 name" (a file the host attached).
const INLINE =
  /`([^`\n]+)`|\*\*(?!\s)(.+?)(?<!\s)\*\*|\*(?!\s)([^*\n]+?)(?<!\s)\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|📎 ([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/g;

export function inline(text: string, style: Omit<Span, 'text'> = {}): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ ...style, text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ ...style, text: m[1], code: true });
    else if (m[2] !== undefined) out.push(...inline(m[2], { ...style, bold: true }));
    else if (m[3] !== undefined) out.push(...inline(m[3], { ...style, italic: true }));
    else if (m[4] !== undefined) out.push({ ...style, text: m[4], href: m[5] });
    else out.push({ ...style, text: m[0], file: m[6] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ ...style, text: text.slice(last) });
  return out;
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

export function markdown(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  // Lines matching `pattern`, taken while they keep matching; returns the first capture of each.
  const run = (pattern: RegExp, group = 1): string[] => {
    const taken: string[] = [];
    for (let m; i < lines.length && (m = pattern.exec(lines[i])); i++) taken.push(m[group]);
    return taken;
  };
  while (i < lines.length) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (!line.trim()) {
      i++;
    } else if (FENCE.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      i++;
      blocks.push({ kind: 'code', text: body.join('\n') });
    } else if ((m = HEADING.exec(line))) {
      blocks.push({ kind: 'h', level: m[1].length, spans: inline(m[2]) });
      i++;
    } else if (RULE.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
    } else if ((m = NUMBERED.exec(line))) {
      blocks.push({ kind: 'ol', start: Number(m[1]), items: run(NUMBERED, 2).map((item) => inline(item)) });
    } else if (BULLET.test(line)) {
      blocks.push({ kind: 'ul', items: run(BULLET).map((item) => inline(item)) });
    } else if (QUOTE.test(line)) {
      blocks.push({ kind: 'quote', spans: inline(run(QUOTE).join('\n')) });
    } else {
      // A paragraph runs until a blank line or another kind of block; its line breaks are kept.
      const body: string[] = [];
      for (; i < lines.length; i++) {
        const next = lines[i];
        if (!next.trim() || [FENCE, HEADING, RULE, BULLET, NUMBERED, QUOTE].some((p) => p.test(next))) break;
        body.push(next);
      }
      blocks.push({ kind: 'p', spans: inline(body.join('\n')) });
    }
  }
  return blocks;
}
