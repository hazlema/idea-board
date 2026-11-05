import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WIKI_DIR, WikiStore, markdownToHtml, wikiPage } from '../lib/wiki.mjs';

const withWiki = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-wiki-'));
  try {
    return fn(new WikiStore(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
};

test('pages list with their title and summary; a page without them lists by name; other files are left out', () => withWiki((wiki, dir) => {
  fs.writeFileSync(path.join(dir, 'social-presence.md'), '# Social presence\n\n> Other people being there.\n\nPlay side by side.\n');
  fs.writeFileSync(path.join(dir, 'mine.md'), 'Just notes.\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  assert.deepEqual(wiki.list(), [{ name: 'mine' }, { name: 'social-presence', title: 'Social presence', summary: 'Other people being there.' }]);
}));

test('a page reads by name, with or without .md, in chunks that point at read_wiki', () => withWiki((wiki, dir) => {
  fs.writeFileSync(path.join(dir, 'pacing.md'), ['# Pacing', ...Array.from({ length: 600 }, (_, i) => `line ${i}`)].join('\n'));
  const first = wiki.read('pacing');
  assert.equal(first.name, 'pacing');
  assert.match(first.text, /^# Pacing/);
  assert.match(first.more, /read_wiki again with from_line 501/);
  assert.equal(wiki.read('pacing.md', 501).from_line, 501);
  assert.throws(() => wiki.read('nope'), /no wiki page called nope\.md/);
  assert.throws(() => wiki.read('../board'), /not a wiki page name/);
}));

test('the markdown the pages use becomes HTML, with text escaped', () => {
  const html = markdownToHtml('# Belonging\n\n> A home.\n\nGuilds are **family** and *home*.\nSee [Oldenburg](https://example.com/a?b=1&c=2).\n\n- one <b>\n- two\n\n## Sources', 'belonging');
  assert.equal(html, [
    '<h2 id="belonging">Belonging</h2>',
    '<blockquote>A home.</blockquote>',
    '<p>Guilds are <strong>family</strong> and <em>home</em>. See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noreferrer">Oldenburg</a>.</p>',
    '<ul>', '<li>one &lt;b&gt;</li>', '<li>two</li>', '</ul>',
    '<h3>Sources</h3>',
  ].join('\n'));
  assert.doesNotMatch(markdownToHtml('[x](javascript:alert(1))'), /href/);
});

test('the wiki page holds a list of contents and every page', () => withWiki((wiki, dir) => {
  fs.writeFileSync(path.join(dir, 'pacing.md'), '# Pacing\n\n> Rhythm.\n\nRest beats.\n');
  const html = wikiPage(wiki);
  assert.match(html, /<title>Design wiki<\/title>/);
  assert.match(html, /<a href="#pacing">Pacing<\/a> · Rhythm\./);
  assert.match(html, /<h2 id="pacing">Pacing<\/h2>/);
}));

// The shipped reference: every page has a title, a summary, questions to ask and sources with links.
test('every shipped page has a title, a summary, questions to ask and linked sources', () => {
  const pages = new WikiStore(WIKI_DIR).list();
  assert.ok(pages.length >= 9, `only ${pages.length} pages`);
  for (const page of pages) {
    assert.ok(page.title && page.summary, page.name);
    const text = fs.readFileSync(path.join(WIKI_DIR, `${page.name}.md`), 'utf8');
    assert.match(text, /^## Questions to ask of a design$/m, page.name);
    assert.match(text.slice(text.indexOf('## Sources')), /\]\(https?:\/\//, page.name);
  }
});
