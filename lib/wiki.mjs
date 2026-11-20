// The design wiki: a curated game design reference from expert sources, shipped in wiki/ at
// the repo root. Every agent reads it with read_wiki; /design_wiki opens it for the host (/wiki).
// A page is "# Title", a "> summary" line, then the body, in markdown.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FileStore } from './files.mjs';

export const WIKI_DIR = fileURLToPath(new URL('../wiki', import.meta.url));

export class WikiStore extends FileStore {
  constructor(dir = WIKI_DIR) {
    super(dir, { noun: 'wiki page', tool: 'read_wiki' });
  }

  // Every page, in file order, with its title and summary (a page without them lists by name).
  list() {
    return super.list().filter((f) => f.name.endsWith('.md')).map(({ name }) => {
      const head = fs.readFileSync(this.resolve(name), 'utf8').split(/\r?\n/, 6);
      const title = head.find((l) => l.startsWith('# '))?.slice(2).trim();
      const summary = head.find((l) => l.startsWith('> '))?.slice(2).trim();
      return { name: name.slice(0, -3), ...(title ? { title } : {}), ...(summary ? { summary } : {}) };
    });
  }

  // A page by its name, with or without the .md.
  read(name, from) {
    const file = `${String(name).replace(/\.md$/i, '')}.md`;
    return { ...super.read(file, from), name: file.slice(0, -3) };
  }

  text(name) {
    return fs.readFileSync(this.resolve(`${name}.md`), 'utf8');
  }
}

// The reading page style, shared with the exported design doc.
export const READER_STYLE = `:root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1f1d1a; --muted: #6b665e; --line: #e4e0d8; --link: #2f5f9e; }
@media (prefers-color-scheme: dark) { :root { --bg: #17171a; --fg: #e8e6e1; --muted: #a29d94; --line: #2e2e33; --link: #8ab4f0; } }
body { background: var(--bg); color: var(--fg); font: 17px/1.6 Georgia, 'Iowan Old Style', serif; margin: 0; padding: 0 16px 64px; }
main { max-width: 46rem; margin: 0 auto; }
h1 { font-size: 2.2rem; margin: 2.5rem 0 0.25rem; } h2 { font-size: 1.6rem; margin: 0 0 0.25rem; } h3 { font-size: 1.15rem; margin: 1.5rem 0 0.25rem; } h4 { margin: 1.2rem 0 0.2rem; }
section { border-top: 1px solid var(--line); padding-top: 2rem; margin-top: 2.5rem; }
blockquote { color: var(--muted); margin: 0 0 1rem; font-style: italic; }
a { color: var(--link); } ul { padding-left: 1.3rem; } li { margin: 0.25rem 0; }
.lede, nav li { color: var(--muted); }
img { max-width: 100%; border-radius: 6px; } hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
code { font: 0.88em ui-monospace, monospace; } pre { overflow-x: auto; padding: 0.75rem 1rem; border: 1px solid var(--line); border-radius: 6px; }
table { border-collapse: collapse; } th, td { border: 1px solid var(--line); padding: 0.3rem 0.6rem; text-align: left; }
`;

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The markdown the pages use: headings, bullets, quotes, paragraphs, **bold**, *italic* and links.
function inline(text) {
  return escape(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export function markdownToHtml(md, id = '') {
  const out = [];
  let list = false;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
    if (list) out.push('</ul>');
    list = false;
  };
  for (const line of md.split(/\r?\n/)) {
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length + 1;
      out.push(`<h${level}${level === 2 && id ? ` id="${id}"` : ''}>${inline(heading[2])}</h${level}>`);
    } else if (/^[-*] /.test(line)) {
      if (para.length) flush();
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line.startsWith('> ')) {
      flush();
      out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    } else if (!line.trim()) {
      flush();
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join('\n');
}

// The page /design_wiki opens: every page in one, with a list of contents.
export function wikiPage(wiki) {
  const pages = wiki.list();
  const contents = pages.map((p) => `<li><a href="#${p.name}">${escape(p.title ?? p.name)}</a>${p.summary ? ` · ${escape(p.summary)}` : ''}</li>`).join('\n');
  const body = pages.map((p) => `<section>${markdownToHtml(wiki.text(p.name), p.name)}</section>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design wiki</title>
<style>
${READER_STYLE}</style></head>
<body><main>
<h1>Design wiki</h1>
<p class="lede">A curated game design reference from expert sources. The agents read these pages before they make design decisions.</p>
<nav><ul>
${contents}
</ul></nav>
${body}
</main></body></html>`;
}
