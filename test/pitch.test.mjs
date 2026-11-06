import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PITCH_FRAME, pitchPrompt, pitchSystemPrompt } from '../lib/pitch.mjs';
import { defaults } from '../lib/defaults.mjs';

test('pitchPrompt asks for the count, names the group and the format, and carries guidance', () => {
  const p = pitchPrompt({ count: 20, guidance: 'funnier' });
  assert.match(p, /20 pitches/);
  assert.match(p, /"Pitches"/);
  assert.match(p, /toy : where it lives/);
  assert.match(p, /funnier/);
  assert.doesNotMatch(pitchPrompt({ count: 5 }), /guidance/);
  assert.match(pitchPrompt({ count: 5, snapshot: '{"b":1}' }), /\{"b":1\}/);
});

test('the pitch system prompt starts with the frame', () => {
  assert.ok(pitchSystemPrompt('Pitch.').startsWith(PITCH_FRAME));
  assert.ok(pitchSystemPrompt('Pitch.').endsWith('Pitch.'));
});

test('the default pitch prompt names every placement kind', () => {
  for (const k of ['a person in the game', 'a machine in the setting', 'chance the player can see', 'the setting itself', "the player's own action"]) assert.ok(defaults().prompts.pitch.includes(k), k);
});
