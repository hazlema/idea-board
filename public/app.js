// Idea board page: canvas with pan/zoom, draggable nodes, connections, a
// detail panel on the right and a chat dock. The server is the source of
// truth; every change is an op POSTed to /api/op and echoed back over SSE.
const $ = (sel) => document.querySelector(sel);
const viewport = $('#viewport');
const world = $('#world');
const edgeLayer = $('#edge-layer');
const nodesLayer = $('#nodes');
const panel = $('#panel');
const chatLog = $('#chat-log');
const chatInput = $('#chat-input');

const SVG = 'http://www.w3.org/2000/svg';
const STATUS_LABEL = { idea: 'Idea', accepted: 'Accepted', rejected: 'Rejected' };

const state = {
  board: null,
  selected: null, // { kind: 'node' | 'edge', id }
  view: JSON.parse(localStorage.getItem('idea-board-view') || 'null') || { x: 80, y: 80, k: 1 },
  agent: 'idle',
  presence: false,
  hideRejected: localStorage.getItem('idea-board-hide-rejected') === '1',
  notices: [],
  panelDirty: false,
  briefOpen: localStorage.getItem('idea-board-brief') !== '0',
  saving: 0,
  saveFailed: false,
};

const nodeEls = new Map();
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}

async function op(o) {
  state.saving += 1;
  renderSaveStatus();
  try {
    const res = await fetch('/api/op', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: o }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    state.saveFailed = false;
    return body;
  } catch (error) {
    state.saveFailed = true;
    toast(`Could not save: ${error.message}`);
    return null;
  } finally {
    state.saving -= 1;
    renderSaveStatus();
  }
}

function renderSaveStatus() {
  const el = $('#save-status');
  if (state.saving) { el.textContent = 'Saving…'; el.className = 'save-status'; }
  else if (state.saveFailed) { el.textContent = 'Last change not saved'; el.className = 'save-status failed'; }
  else { el.textContent = 'All changes saved'; el.className = 'save-status'; }
}

const nodeById = (id) => state.board?.nodes.find((n) => n.id === id);
const visible = (node) => !(state.hideRejected && node.status === 'rejected');

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
const whoName = (author) => (author === 'claude' ? 'Claude' : 'You');

/* ---------- view (pan / zoom) ---------- */

function applyView() {
  const { x, y, k } = state.view;
  world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  viewport.style.backgroundSize = `${24 * k}px ${24 * k}px`;
  viewport.style.backgroundPosition = `${x}px ${y}px`;
  localStorage.setItem('idea-board-view', JSON.stringify(state.view));
}

function toWorld(clientX, clientY) {
  const r = viewport.getBoundingClientRect();
  return { x: (clientX - r.left - state.view.x) / state.view.k, y: (clientY - r.top - state.view.y) / state.view.k };
}

function fit() {
  const nodes = state.board.nodes.filter(visible);
  if (!nodes.length) { state.view = { x: 80, y: 80, k: 1 }; applyView(); return; }
  const rects = nodes.map(rectOf);
  const minX = Math.min(...rects.map((r) => r.x)), minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w)), maxY = Math.max(...rects.map((r) => r.y + r.h));
  const { width, height } = viewport.getBoundingClientRect();
  const pad = 60;
  const k = Math.min(1.25, Math.max(0.2, Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxY - minY))));
  state.view = { k, x: (width - (maxX - minX) * k) / 2 - minX * k, y: (height - (maxY - minY) * k) / 2 - minY * k };
  applyView();
}

function centerOn(node) {
  const { width, height } = viewport.getBoundingClientRect();
  const r = rectOf(node);
  state.view.x = width / 2 - (r.x + r.w / 2) * state.view.k;
  state.view.y = height / 2 - (r.y + r.h / 2) * state.view.k;
  applyView();
}

viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = viewport.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const k = Math.min(2.5, Math.max(0.2, state.view.k * Math.exp(-e.deltaY * 0.0015)));
  state.view.x = sx - ((sx - state.view.x) * k) / state.view.k;
  state.view.y = sy - ((sy - state.view.y) * k) / state.view.k;
  state.view.k = k;
  applyView();
}, { passive: false });

viewport.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.node, .edge') || e.button !== 0) return;
  const start = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y };
  let moved = false;
  viewport.setPointerCapture(e.pointerId);
  viewport.classList.add('panning');
  const move = (ev) => {
    if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 3) moved = true;
    state.view.x = start.vx + ev.clientX - start.x;
    state.view.y = start.vy + ev.clientY - start.y;
    applyView();
  };
  const up = () => {
    viewport.removeEventListener('pointermove', move);
    viewport.removeEventListener('pointerup', up);
    viewport.classList.remove('panning');
    if (!moved) select(null);
  };
  viewport.addEventListener('pointermove', move);
  viewport.addEventListener('pointerup', up);
});

viewport.addEventListener('dblclick', async (e) => {
  if (e.target.closest('.node, .edge')) return;
  const p = toWorld(e.clientX, e.clientY);
  await addNodeAt(p.x - 110, p.y - 28);
});

async function addNodeAt(x, y) {
  const result = await op({ type: 'addNode', title: 'New idea', x, y });
  if (result) {
    state.selected = { kind: 'node', id: result.node.id };
    state.focusTitle = true;
  }
}

/* ---------- nodes ---------- */

function rectOf(node) {
  const el = nodeEls.get(node.id);
  return { x: node.x, y: node.y, w: el?.offsetWidth || 220, h: el?.offsetHeight || 56 };
}

function nodeHtml(node) {
  const props = node.props.length ? `<span>${node.props.length} prop${node.props.length > 1 ? 's' : ''}</span>` : '';
  const notes = node.notes.trim() ? '<span>notes</span>' : '';
  return `<div class="node-row">
      <input type="checkbox" class="node-check" title="Accepted" ${node.status === 'accepted' ? 'checked' : ''} />
      <div class="node-title" title="${escapeHtml(node.title)}">${escapeHtml(node.title)}</div>
    </div>
    <div class="node-meta"><span class="who ${node.author}">${whoName(node.author)}</span>${props}${notes}</div>
    <div class="handle" title="Drag to another idea to connect"></div>`;
}

function renderNodes() {
  const seen = new Set();
  for (const node of state.board.nodes) {
    if (!visible(node)) continue;
    seen.add(node.id);
    let el = nodeEls.get(node.id);
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = node.id;
      bindNode(el);
      nodesLayer.append(el);
      nodeEls.set(node.id, el);
    }
    const html = nodeHtml(node);
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.className = `node status-${node.status}${state.selected?.kind === 'node' && state.selected.id === node.id ? ' selected' : ''}${el.classList.contains('flash') ? ' flash' : ''}${el.classList.contains('dragging') ? ' dragging' : ''}`;
    if (!el.classList.contains('dragging')) {
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
    }
  }
  for (const [id, el] of nodeEls) if (!seen.has(id)) { el.remove(); nodeEls.delete(id); }
  $('#empty').hidden = state.board.nodes.length > 0;
}

function flash(id) {
  const el = nodeEls.get(id);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1700);
}

function bindNode(el) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const id = el.dataset.id;
    if (e.target.classList.contains('node-check')) { e.stopPropagation(); return; }
    if (e.target.classList.contains('handle')) { startConnect(e, id); return; }
    e.stopPropagation();
    select({ kind: 'node', id });
    const node = nodeById(id);
    const start = toWorld(e.clientX, e.clientY);
    const origin = { x: node.x, y: node.y };
    let moved = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const p = toWorld(ev.clientX, ev.clientY);
      const x = Math.round(origin.x + p.x - start.x), y = Math.round(origin.y + p.y - start.y);
      if (!moved && Math.abs(x - origin.x) + Math.abs(y - origin.y) < 3) return;
      moved = true;
      el.classList.add('dragging');
      node.x = x; node.y = y;
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      renderEdges();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.classList.remove('dragging');
      if (moved) op({ type: 'updateNode', id, x: node.x, y: node.y });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
  el.addEventListener('change', (e) => {
    if (!e.target.classList.contains('node-check')) return;
    op({ type: 'updateNode', id: el.dataset.id, status: e.target.checked ? 'accepted' : 'idea' });
  });
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    select({ kind: 'node', id: el.dataset.id });
    $('#panel .title-input')?.select();
  });
}

/* ---------- edges ---------- */

function anchors(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x, dy = bc.y - ac.y;
  if (Math.abs(dx) * 0.6 >= Math.abs(dy)) {
    const dir = dx >= 0 ? 1 : -1;
    return { s: { x: dir > 0 ? a.x + a.w : a.x, y: ac.y }, t: { x: dir > 0 ? b.x : b.x + b.w, y: bc.y }, sd: { x: dir, y: 0 }, td: { x: -dir, y: 0 } };
  }
  const dir = dy >= 0 ? 1 : -1;
  return { s: { x: ac.x, y: dir > 0 ? a.y + a.h : a.y }, t: { x: bc.x, y: dir > 0 ? b.y : b.y + b.h }, sd: { x: 0, y: dir }, td: { x: 0, y: -dir } };
}

function curve(s, t, sd, td) {
  const d = Math.max(40, Math.hypot(t.x - s.x, t.y - s.y) / 2.5);
  const c1 = { x: s.x + sd.x * d, y: s.y + sd.y * d }, c2 = { x: t.x + td.x * d, y: t.y + td.y * d };
  const mid = { x: (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8, y: (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8 };
  return { d: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${t.x},${t.y}`, mid };
}

function edgeElement(pathD, mid, label, cls) {
  const g = document.createElementNS(SVG, 'g');
  g.setAttribute('class', `edge ${cls}`);
  const hit = document.createElementNS(SVG, 'path');
  hit.setAttribute('class', 'hit');
  hit.setAttribute('d', pathD);
  const line = document.createElementNS(SVG, 'path');
  line.setAttribute('class', 'line');
  line.setAttribute('d', pathD);
  line.setAttribute('marker-end', cls.includes('selected') ? 'url(#arrow-selected)' : 'url(#arrow)');
  g.append(hit, line);
  if (label) {
    const text = document.createElementNS(SVG, 'text');
    text.setAttribute('x', mid.x);
    text.setAttribute('y', mid.y);
    text.textContent = label;
    g.append(text);
  }
  return g;
}

function renderEdges(draft) {
  edgeLayer.replaceChildren();
  for (const edge of state.board.edges) {
    const a = nodeById(edge.from), b = nodeById(edge.to);
    if (!a || !b || !visible(a) || !visible(b)) continue;
    const { s, t, sd, td } = anchors(rectOf(a), rectOf(b));
    const { d, mid } = curve(s, t, sd, td);
    const selected = state.selected?.kind === 'edge' && state.selected.id === edge.id;
    const g = edgeElement(d, mid, edge.label, selected ? 'selected' : '');
    g.addEventListener('pointerdown', (e) => { e.stopPropagation(); select({ kind: 'edge', id: edge.id }); });
    edgeLayer.append(g);
  }
  if (draft) edgeLayer.append(edgeElement(draft.d, draft.mid, '', 'draft'));
}

function startConnect(e, fromId) {
  e.stopPropagation();
  e.preventDefault();
  const fromEl = nodeEls.get(fromId);
  fromEl.setPointerCapture(e.pointerId);
  let target = null;
  const move = (ev) => {
    const r = rectOf(nodeById(fromId));
    const s = { x: r.x + r.w, y: r.y + r.h / 2 };
    const p = toWorld(ev.clientX, ev.clientY);
    renderEdges(curve(s, p, { x: 1, y: 0 }, { x: Math.sign(s.x - p.x) || -1, y: 0 }));
    const hovered = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
    const next = hovered && hovered !== fromEl ? hovered : null;
    if (next !== target) { target?.classList.remove('connect-target'); next?.classList.add('connect-target'); target = next; }
  };
  const up = async () => {
    fromEl.removeEventListener('pointermove', move);
    fromEl.removeEventListener('pointerup', up);
    target?.classList.remove('connect-target');
    renderEdges();
    if (target) {
      const result = await op({ type: 'addEdge', from: fromId, to: target.dataset.id });
      if (result) select({ kind: 'edge', id: result.edge.id });
    }
  };
  fromEl.addEventListener('pointermove', move);
  fromEl.addEventListener('pointerup', up);
}

/* ---------- side panel ---------- */

function select(sel) {
  state.selected = sel;
  state.panelDirty = false;
  render();
  renderPanel(true);
}

function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
}

function renderPanel(force = false) {
  // Don't rebuild the panel while the user is typing in it; catch up when they leave the field.
  const active = document.activeElement;
  if (!force && panel.contains(active) && active.matches('input, textarea') && !state.focusTitle) { state.panelDirty = true; return; }
  const sel = state.selected;
  if (sel?.kind === 'node' && nodeById(sel.id)) return renderNodePanel(nodeById(sel.id));
  if (sel?.kind === 'edge' && state.board.edges.some((e) => e.id === sel.id)) return renderEdgePanel(state.board.edges.find((e) => e.id === sel.id));
  if (state.briefOpen) return renderBriefPanel();
  panel.hidden = true;
  panel.replaceChildren();
}

function fitArea(area) {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight + 2}px`;
}

function renderBriefPanel() {
  const sections = state.board.brief.sections;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="panel-head"><span>Brief · what we're building</span><button data-close title="Hide the brief">×</button></div>
    <p class="muted brief-hint">Free-form notes about the project. Claude reads this before every change and adds to it when you settle something.</p>
    <div class="brief">${sections.map((x, i) => `
      <section class="brief-box" data-id="${x.id}">
        <div class="box-head">
          <input type="text" class="box-title" maxlength="200" placeholder="Heading" value="${escapeHtml(x.title)}" />
          <button data-move="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-move="1" title="Move down" ${i === sections.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-remove title="Remove this box">×</button>
        </div>
        <textarea class="box-text" placeholder="Write anything…">${escapeHtml(x.text)}</textarea>
        <div class="muted box-meta">Last edit: ${whoName(x.updatedBy)} · ${ago(x.updatedAt)}</div>
      </section>`).join('')}
    </div>
    <button class="add-prop" data-add-box>+ Add text box</button>`;

  panel.querySelectorAll('.brief-box').forEach((box) => {
    const id = box.dataset.id;
    const title = box.querySelector('.box-title');
    const area = box.querySelector('.box-text');
    fitArea(area);
    const saveTitle = debounce(() => op({ type: 'updateSection', id, title: title.value }), 400);
    const saveText = debounce(() => op({ type: 'updateSection', id, text: area.value }), 500);
    title.addEventListener('input', saveTitle);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); area.focus(); } });
    title.addEventListener('blur', () => saveTitle.flush());
    area.addEventListener('input', () => { fitArea(area); saveText(); });
    area.addEventListener('blur', () => saveText.flush());
    box.querySelectorAll('[data-move]').forEach((btn) => btn.addEventListener('click', async () => {
      await op({ type: 'moveSection', id, by: Number(btn.dataset.move) });
      renderPanel(true);
    }));
    box.querySelector('[data-remove]').addEventListener('click', async () => {
      if ((area.value.trim() || title.value.trim()) && !confirm(`Remove "${title.value || 'this box'}"?`)) return;
      await op({ type: 'deleteSection', id });
      renderPanel(true);
    });
  });
  panel.querySelector('[data-add-box]').addEventListener('click', async () => {
    const result = await op({ type: 'addSection', title: '', text: '' });
    if (!result) return;
    renderPanel(true);
    panel.querySelector(`.brief-box[data-id="${result.section.id}"] .box-title`)?.focus();
  });
  panel.querySelector('[data-close]').addEventListener('click', () => toggleBrief(false));
}

function toggleBrief(open = !state.briefOpen) {
  state.briefOpen = open;
  localStorage.setItem('idea-board-brief', open ? '1' : '0');
  if (open) state.selected = null;
  $('#brief-toggle').classList.toggle('on', open);
  render();
  renderPanel(true);
}

function renderNodePanel(node) {
  const b = state.board;
  const out = b.edges.filter((e) => e.from === node.id);
  const inc = b.edges.filter((e) => e.to === node.id);
  const link = (dir, otherId, label) => {
    const other = nodeById(otherId);
    return `<li><span class="dir">${dir}</span><button class="goto" data-goto="${otherId}">${escapeHtml(other?.title ?? '?')}</button>${label ? `<span class="lbl">${escapeHtml(label)}</span>` : ''}</li>`;
  };
  panel.hidden = false;
  panel.innerHTML = `
    <div class="panel-head"><span>Added by ${whoName(node.author)} · ${ago(node.createdAt)}</span><button data-close title="Close (Esc)">×</button></div>
    <div class="segmented">${Object.entries(STATUS_LABEL).map(([key, label]) => `<button class="${key}${node.status === key ? ' on' : ''}" data-status="${key}">${label}</button>`).join('')}</div>
    <div class="field"><label for="f-title">Title</label><input type="text" id="f-title" class="title-input" maxlength="200" value="${escapeHtml(node.title)}" /></div>
    <div class="field"><span class="field-label">Properties</span><div class="props" id="props"></div><button class="add-prop" data-add-prop>+ Add property</button></div>
    <div class="field"><label for="f-notes">Notes</label><textarea id="f-notes" placeholder="Details, open questions, examples…">${escapeHtml(node.notes)}</textarea></div>
    <div class="field"><span class="field-label">Connections</span>${out.length || inc.length
      ? `<ul class="links">${out.map((e) => link('→', e.to, e.label)).join('')}${inc.map((e) => link('←', e.from, e.label)).join('')}</ul>`
      : '<span class="muted">None yet. Drag the dot on the card\'s right edge to another idea.</span>'}</div>
    <div class="panel-foot"><span class="muted">Last edit: ${whoName(node.updatedBy || node.author)} · ${ago(node.updatedAt)}</span><button class="danger" data-delete>Delete</button></div>`;

  const props = node.props.map((p) => ({ ...p }));
  const propsEl = panel.querySelector('#props');
  const saveProps = () => op({ type: 'updateNode', id: node.id, props: props.filter((p) => p.key.trim() || p.value.trim()) });
  const drawProps = () => {
    propsEl.innerHTML = props.map((p, i) => `<div class="prop">
        <input type="text" class="key" data-i="${i}" data-k="key" placeholder="name" value="${escapeHtml(p.key)}" />
        <input type="text" data-i="${i}" data-k="value" placeholder="value" value="${escapeHtml(p.value)}" />
        <button data-remove="${i}" title="Remove">×</button></div>`).join('');
  };
  drawProps();
  propsEl.addEventListener('input', (e) => { const { i, k } = e.target.dataset; if (i !== undefined) props[i][k] = e.target.value; });
  propsEl.addEventListener('change', saveProps);
  propsEl.addEventListener('click', (e) => {
    if (e.target.dataset.remove === undefined) return;
    props.splice(Number(e.target.dataset.remove), 1);
    drawProps();
    saveProps();
  });
  panel.querySelector('[data-add-prop]').addEventListener('click', () => {
    props.push({ key: '', value: '' });
    drawProps();
    propsEl.querySelector('.prop:last-child .key').focus();
  });

  const title = panel.querySelector('#f-title');
  const saveTitle = debounce(() => { if (title.value.trim()) op({ type: 'updateNode', id: node.id, title: title.value }); }, 400);
  title.addEventListener('input', saveTitle);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { saveTitle.flush(); title.blur(); } });
  const notes = panel.querySelector('#f-notes');
  const saveNotes = debounce(() => op({ type: 'updateNode', id: node.id, notes: notes.value }), 500);
  notes.addEventListener('input', saveNotes);
  notes.addEventListener('blur', () => saveNotes.flush());

  panel.querySelectorAll('[data-status]').forEach((btn) => btn.addEventListener('click', () => op({ type: 'updateNode', id: node.id, status: btn.dataset.status })));
  panel.querySelectorAll('[data-goto]').forEach((btn) => btn.addEventListener('click', () => {
    const other = nodeById(btn.dataset.goto);
    if (!other) return;
    if (!visible(other)) { state.hideRejected = false; $('#hide-rejected').checked = false; }
    select({ kind: 'node', id: other.id });
    centerOn(other);
  }));
  panel.querySelector('[data-close]').addEventListener('click', () => select(null));
  panel.querySelector('[data-delete]').addEventListener('click', () => deleteSelected());

  if (state.focusTitle) {
    state.focusTitle = false;
    title.focus();
    title.select();
  }
}

function renderEdgePanel(edge) {
  const from = nodeById(edge.from), to = nodeById(edge.to);
  panel.hidden = false;
  panel.innerHTML = `
    <div class="panel-head"><span>Connection · added by ${whoName(edge.author)}</span><button data-close title="Close (Esc)">×</button></div>
    <div class="field"><span class="field-label">From → to</span>
      <ul class="links"><li><button class="goto" data-goto="${edge.from}">${escapeHtml(from?.title ?? '?')}</button></li>
      <li><span class="dir">→</span><button class="goto" data-goto="${edge.to}">${escapeHtml(to?.title ?? '?')}</button></li></ul></div>
    <div class="field"><label for="f-label">Label</label><input type="text" id="f-label" maxlength="200" placeholder="e.g. unlocks, requires, costs" value="${escapeHtml(edge.label)}" /></div>
    <div class="panel-foot"><span></span><button class="danger" data-delete>Delete connection</button></div>`;
  const label = panel.querySelector('#f-label');
  const save = debounce(() => op({ type: 'updateEdge', id: edge.id, label: label.value }), 400);
  label.addEventListener('input', save);
  label.addEventListener('keydown', (e) => { if (e.key === 'Enter') { save.flush(); label.blur(); } });
  panel.querySelectorAll('[data-goto]').forEach((btn) => btn.addEventListener('click', () => select({ kind: 'node', id: btn.dataset.goto })));
  panel.querySelector('[data-close]').addEventListener('click', () => select(null));
  panel.querySelector('[data-delete]').addEventListener('click', () => deleteSelected());
}

panel.addEventListener('focusout', () => {
  setTimeout(() => {
    const active = document.activeElement;
    if (state.panelDirty && !(panel.contains(active) && active.matches('input, textarea'))) { state.panelDirty = false; renderPanel(); }
  }, 0);
});

async function deleteSelected() {
  const sel = state.selected;
  if (!sel) return;
  if (sel.kind === 'node') {
    const node = nodeById(sel.id);
    if (!node || !confirm(`Delete "${node.title}" and its connections?`)) return;
    await op({ type: 'deleteNode', id: sel.id });
  } else {
    await op({ type: 'deleteEdge', id: sel.id });
  }
  select(null);
}

/* ---------- chat ---------- */

function renderChat() {
  const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
  const items = [
    ...state.board.chat.map((m) => ({ at: m.at, html: `<div class="msg ${m.role}"><span class="from">${whoName(m.role)}</span>${escapeHtml(m.text)}</div>` })),
    ...state.notices.map((n) => ({ at: n.at, html: `<div class="msg notice">${escapeHtml(n.text)}</div>` })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  chatLog.innerHTML = items.length ? items.map((i) => i.html).join('') : '<div class="muted" style="color:var(--muted)">Tell Claude what you are thinking about. It can read and change the board.</div>';
  if (atBottom || renderChat.first !== false) chatLog.scrollTop = chatLog.scrollHeight;
  renderChat.first = false;

  const status = $('#agent-status');
  status.className = 'agent-status';
  if (state.agent === 'working') { status.textContent = 'Claude is working on the board'; status.classList.add('working'); }
  else if (state.presence) status.textContent = 'A Claude session is listening';
  else if (state.agent === 'off') status.textContent = 'Background Claude is off; chat waits for a session';
  else status.textContent = '';
}

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  autosize();
  const sent = await op({ type: 'chat', text });
  if (!sent) chatInput.value = text;
});
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); }
});
function autosize() { chatInput.style.height = 'auto'; chatInput.style.height = `${Math.min(chatInput.scrollHeight, 140)}px`; }
chatInput.addEventListener('input', autosize);
$('#chat-toggle').addEventListener('click', () => {
  const chat = $('.chat');
  chat.classList.toggle('collapsed');
  $('#chat-toggle').setAttribute('aria-expanded', String(!chat.classList.contains('collapsed')));
});

/* ---------- top bar, keys, wiring ---------- */

function renderTop() {
  const title = $('#board-title');
  if (document.activeElement !== title) title.value = state.board.title;
  document.title = `${state.board.title} · Idea board`;
  const count = (s) => state.board.nodes.filter((n) => n.status === s).length;
  $('#counts').innerHTML = `<b>${count('idea')}</b> ideas · <b>${count('accepted')}</b> accepted · <b>${count('rejected')}</b> rejected`;
}

function render() {
  if (!state.board) return;
  renderTop();
  renderNodes();
  renderEdges();
  renderPanel();
  renderChat();
}

$('#board-title').addEventListener('change', (e) => { if (e.target.value.trim()) op({ type: 'setTitle', title: e.target.value }); });
$('#board-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('#add-node').addEventListener('click', () => {
  const r = viewport.getBoundingClientRect();
  const p = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  addNodeAt(p.x - 110 + (Math.random() * 40 - 20), p.y - 28 + (Math.random() * 40 - 20));
});
$('#fit').addEventListener('click', fit);
$('#tidy').addEventListener('click', async () => {
  state.fitNext = true;
  if (!(await op({ type: 'tidy' }))) state.fitNext = false;
});
$('#brief-toggle').classList.toggle('on', state.briefOpen);
$('#brief-toggle').addEventListener('click', () => toggleBrief());
$('#hide-rejected').checked = state.hideRejected;
$('#hide-rejected').addEventListener('change', (e) => {
  state.hideRejected = e.target.checked;
  localStorage.setItem('idea-board-hide-rejected', e.target.checked ? '1' : '0');
  render();
});

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea');
  if (e.key === 'Escape') { if (typing) e.target.blur(); else select(null); return; }
  if (typing) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) { e.preventDefault(); deleteSelected(); }
  if (e.key === 'f' || e.key === 'F') fit();
});

function connect() {
  const events = new EventSource('/api/events');
  events.onmessage = (msg) => {
    const event = JSON.parse(msg.data);
    if (event.type === 'board') {
      const firstLoad = !state.board;
      state.board = event.board;
      if (state.selected && !(state.selected.kind === 'node' ? nodeById(state.selected.id) : state.board.edges.some((e) => e.id === state.selected.id))) state.selected = null;
      render();
      if ((firstLoad && !localStorage.getItem('idea-board-view')) || state.fitNext) { state.fitNext = false; fit(); }
      if (event.author === 'claude' && event.changed) flash(event.changed);
    } else if (event.type === 'agent') {
      state.agent = event.state === 'error' ? 'idle' : event.state;
      if (event.state === 'error') state.notices.push({ at: new Date().toISOString(), text: `Claude could not answer: ${event.message}` });
      if (state.board) renderChat();
    } else if (event.type === 'presence') {
      state.presence = event.attached;
      if (state.board) renderChat();
    }
  };
}

fetch('/api/board').then((r) => r.json()).then((info) => {
  state.agent = info.agent;
  state.presence = info.presence;
}).catch(() => {});
applyView();
connect();
