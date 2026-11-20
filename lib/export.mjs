// Turns a board into a plain-markdown design document: what was agreed, what
// is still open, and what was ruled out and why. Pure; the store writes it.
import { Marked } from 'marked';
import { authorName } from './authors.mjs';
import { objectLabel } from './brainstorm.mjs';
import { READER_STYLE } from './wiki.mjs';

const UNREVIEWED = ' _(Claude added, not reviewed)_';
const CHECK_MARK = { done: '[x] ', open: '[ ] ', none: '' };

// Keeps an entry on one bullet line.
const oneLine = (value) => String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
const withLabel = (text, label) => (label ? `${text} (${label})` : text);

function briefSection(board) {
  const sections = board.brief.sections.filter((s) => s.title || s.text);
  if (!sections.length) return [];
  const parts = ['## Brief'];
  for (const s of sections) parts.push(`### ${oneLine(s.title) || 'Untitled section'}${s.text ? `\n\n${s.text}` : ''}`);
  return parts;
}

function groupSection(group) {
  const lines = group.entries
    .filter((e) => !e.ruledOut)
    .map((e) => `- ${CHECK_MARK[e.check] ?? ''}**${oneLine(e.label)}:** ${oneLine(e.text)}`.trimEnd() + (e.claudeAdded ? UNREVIEWED : ''));
  if (!lines.length) return null;
  return `### ${oneLine(group.title)}${group.claudeAdded ? UNREVIEWED : ''}\n\n${lines.join('\n')}`;
}

// A picture embedded as an image, so whoever builds from the doc sees the reference art.
// The path is in <…> so a board name with spaces still links; brackets in alt text are escaped.
function pictureBlock(board, picture, assetsDirName) {
  const caption = oneLine(picture.caption) || 'Picture';
  const alt = caption.replace(/[[\]\\]/g, '\\$&');
  const by = `**${caption}** · ${authorName(board, picture.author)}${picture.claudeAdded ? UNREVIEWED : ''}`;
  return `${by}\n\n![${alt}](<${assetsDirName}/${picture.asset}>)`;
}

function brainstormSection(board, assetsDirName) {
  const parts = [];
  for (const page of board.brainstorm.pages) {
    const of = (kind) => page.objects.filter((o) => o.kind === kind);
    for (const group of of('group')) {
      const section = groupSection(group);
      if (section) parts.push(section);
    }
    const notes = of('note').filter((n) => n.text.trim());
    if (notes.length) {
      const quoted = notes.map((n) => n.text.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n'));
      parts.push(`### Notes\n\n${quoted.join('\n\n')}`);
    }
    const pictures = of('picture');
    if (pictures.length) parts.push(`### Pictures\n\n${pictures.map((p) => pictureBlock(board, p, assetsDirName)).join('\n\n')}`);
    const byId = new Map(page.objects.map((o) => [o.id, o]));
    const links = page.links
      .filter((l) => byId.has(l.from) && byId.has(l.to))
      .map((l) => `- ${withLabel(`${oneLine(objectLabel(byId.get(l.from)))} → ${oneLine(objectLabel(byId.get(l.to)))}`, oneLine(l.label))}`);
    if (links.length) parts.push(`### Links\n\n${links.join('\n')}`);
  }
  return parts.length ? ['## Brainstorm', ...parts] : [];
}

function flowchartSection(board) {
  const accepted = board.flow.nodes.filter((n) => n.status === 'accepted');
  if (!accepted.length) return [];
  const byId = new Map(accepted.map((n) => [n.id, n]));
  const cards = accepted.map((n) => {
    const first = oneLine((n.notes ?? '').split('\n').find((line) => line.trim()));
    return `- **${oneLine(n.title)}**${first ? `: ${first}` : ''}`;
  });
  const parts = ['## Flowchart', `### Accepted cards\n\n${cards.join('\n')}`];
  const edges = board.flow.edges
    .filter((e) => byId.has(e.from) && byId.has(e.to))
    .map((e) => `- ${withLabel(`${oneLine(byId.get(e.from).title)} → ${oneLine(byId.get(e.to).title)}`, oneLine(e.label))}`);
  if (edges.length) parts.push(`### Connections\n\n${edges.join('\n')}`);
  return parts;
}

function ruledOutSection(board) {
  if (!board.ruledOut.length) return [];
  const items = board.ruledOut.map((r) => {
    const reason = oneLine(r.reason);
    const where = [authorName(board, r.by), String(r.at).slice(0, 10), r.source?.label ? `from ${oneLine(r.source.label)}` : '']
      .filter(Boolean).join(', ');
    return `- **${oneLine(r.text)}**${reason ? `: "${reason}"` : ''} (${where})`;
  });
  return ['## Ruled out', items.join('\n')];
}

// The game as written, for a playtest's referee: the Brief, the Brainstorm and the accepted
// flowchart, without the ruled-out list or anything about the export.
export function renderRules(board) {
  const blocks = [`# ${oneLine(board.title) || 'Idea board'}`, ...briefSection(board), ...brainstormSection(board, 'pictures'), ...flowchartSection(board)];
  return `${blocks.join('\n\n')}\n`;
}

export function renderDesignDoc(board, { assetsDirName, date }) {
  const blocks = [
    `# ${oneLine(board.title) || 'Idea board'}`,
    `_Exported ${date} from idea board._`,
    ...briefSection(board),
    ...brainstormSection(board, assetsDirName),
    ...flowchartSection(board),
    ...ruledOutSection(board),
  ];
  return `${blocks.join('\n\n')}\n`;
}

// The exported doc as a page to read. Raw HTML in it is shown as text and only
// web and relative links are kept, since agents wrote much of it. Its picture
// paths stay as written: <base> puts them under /export/, beside the doc.
const reader = new Marked({
  renderer: { html: ({ text }) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;') },
  walkTokens(token) {
    if ((token.type === 'link' || token.type === 'image') && /^[a-z][a-z0-9+.-]*:/i.test(token.href) && !/^https?:/i.test(token.href)) token.href = '#';
  },
});

export function designDocPage(markdown) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<base href="/export/">
<title>Design doc</title>
<style>
${READER_STYLE}</style></head>
<body><main>
${reader.parse(markdown)}
</main></body></html>`;
}
