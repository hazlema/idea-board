import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardStore } from '../lib/store.mjs';
import { Library, DEFAULT_LIBRARY } from '../lib/colab/library.mjs';
import { OpenRouterError } from '../lib/colab/openrouter.mjs';
import { agentId } from '../lib/authors.mjs';
import { PictureMaker, PICTURES_PER_TURN } from '../lib/colab/pictures.mjs';

const A = agentId('acme/alpha', 'art');
const B = agentId('acme/beta', 'qa');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const ROLE_COPY = 'Only roles that can make pictures can use generate_image.';
const NO_MODEL_COPY = 'No image model is set; choose one in the sidebar.';
const BUDGET_COPY = 'The budget is used up; raise it or press Reset to make pictures.';
const LIMIT_COPY = 'Picture limit reached for this turn (2).';

function setup({ image } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-'));
  const store = new BoardStore(path.join(dir, 'board.json'));
  const library = new Library(path.join(dir, 'colab.json'));
  library.save({ ...DEFAULT_LIBRARY, roles: [...DEFAULT_LIBRARY.roles, { id: 'art', name: 'Concept Art', job: 'Draw.', pictures: true }] });
  store.addColabRoster([
    { id: A, model: 'acme/alpha', roleId: 'art', name: 'A', color: 'violet' },
    { id: B, model: 'acme/beta', roleId: 'qa', name: 'B', color: 'green' },
  ]);
  Object.assign(store.board.colab.lineup, { imageModel: 'acme/painter', budget: 5 });
  const calls = [];
  const openrouter = {
    image: async (req) => {
      calls.push(req);
      return image ? image(req) : { data: PNG, cost: 0.05 };
    },
  };
  const pictures = new PictureMaker({ store, library, openrouter });
  const done = () => {
    store.historyLog.flush();
    fs.rmSync(dir, { recursive: true });
  };
  return { dir, store, library, pictures, calls, done };
}

test('only a picture role can make pictures', async () => {
  const { pictures, calls, done } = setup();
  try {
    assert.equal(PICTURES_PER_TURN, 2);
    assert.equal(pictures.canMake(A), true);
    assert.equal(pictures.canMake(B), false);
    assert.equal(pictures.canMake('nobody'), false);
    await assert.rejects(pictures.make({ author: B, prompt: 'a cat' }), { message: ROLE_COPY });
    assert.equal(calls.length, 0);
  } finally {
    done();
  }
});

test("Claude's permission follows claudeRoleId", () => {
  const { store, pictures, done } = setup();
  try {
    store.board.colab.lineup.claudeRoleId = 'art';
    assert.equal(pictures.canMake('claude'), true);
    store.board.colab.lineup.claudeRoleId = 'qa';
    assert.equal(pictures.canMake('claude'), false);
  } finally {
    done();
  }
});

test('no image model', async () => {
  const { store, pictures, calls, done } = setup();
  try {
    store.board.colab.lineup.imageModel = '';
    await assert.rejects(pictures.make({ author: A, prompt: 'a cat' }), { message: NO_MODEL_COPY });
    assert.equal(calls.length, 0);
  } finally {
    done();
  }
});

test('the budget is checked first and spend is counted', async () => {
  const { store, pictures, calls, done } = setup();
  try {
    store.setColabSpent(5);
    await assert.rejects(pictures.make({ author: A, prompt: 'a cat' }), { message: BUDGET_COPY });
    assert.equal(calls.length, 0);
    store.setColabSpent(1);
    const { asset } = await pictures.make({ author: A, prompt: 'a cat' });
    assert.ok(fs.existsSync(store.assets.resolve(asset)));
    assert.ok(Math.abs(store.board.colab.spent - 1.05) < 1e-9);
    assert.deepEqual(calls.map((c) => [c.model, c.prompt]), [['acme/painter', 'a cat']]);
  } finally {
    done();
  }
});

test('two per turn', async () => {
  const { store, pictures, done } = setup();
  try {
    await pictures.make({ author: A, prompt: 'one' });
    await pictures.make({ author: A, prompt: 'two' });
    await assert.rejects(pictures.make({ author: A, prompt: 'three' }), { message: LIMIT_COPY });
    store.apply({ type: 'chat', text: 'my turn is done', answers: [] }, A);
    await pictures.make({ author: A, prompt: 'three' });
  } finally {
    done();
  }
});

test('no picture back still costs', async () => {
  const { store, pictures, done } = setup({
    image: () => { throw Object.assign(new OpenRouterError('The image model returned no picture.', 200), { cost: 0.01 }); },
  });
  try {
    await assert.rejects(pictures.make({ author: A, prompt: 'a cat' }), /returned no picture/);
    assert.ok(Math.abs(store.board.colab.spent - 0.01) < 1e-9);
    assert.equal(fs.existsSync(store.assets.dir) ? fs.readdirSync(store.assets.dir).length : 0, 0);
  } finally {
    done();
  }
});
