import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS_HINT, parseCommand } from '../lib/commands.mjs';

const CHAT_USAGE = 'Use /chat N <message>, where N is a connection\'s number.';

test('plain text and parsed commands', () => {
  const cases = [
    ['Do you like it?', { kind: 'say', text: 'Do you like it?' }],
    ['/chat 2 hi there', { kind: 'chat', n: 2, text: 'hi there' }],
    ['  /C 3 yo', { kind: 'chat', n: 3, text: 'yo' }],
    ['/start ok guys', { kind: 'start', text: 'ok guys' }],
    ['/stop', { kind: 'stop' }],
    ['//home', { kind: 'say', text: '/home' }],
    ['/chat 2 a\nb', { kind: 'chat', n: 2, text: 'a\nb' }],
    ['/r and the ghost?', { kind: 'reply', text: 'and the ghost?' }],
    ['/R yo', { kind: 'reply', text: 'yo' }],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(parseCommand(input), expected, `input: ${JSON.stringify(input)}`);
  }
});

test('bad commands give the exact error copy', () => {
  const cases = [
    ['/home/x', 'Unknown command /home/x. Commands: /chat N (or /c N), /r, /start, /stop, /prune, /audit. Start with // to send a message that begins with /.'],
    ['/chat2 hi', 'Unknown command /chat2. Commands: /chat N (or /c N), /r, /start, /stop, /prune, /audit. Start with // to send a message that begins with /.'],
    ['/chat x hi', CHAT_USAGE],
    ['/chat 2', 'Add a message after /chat N.'],
    ['/start', 'Add a kickoff message after /start.'],
    ['/stop now', '/stop takes no message.'],
    ['/r', 'Add a message after /r.'],
  ];
  for (const [input, error] of cases) {
    assert.deepEqual(parseCommand(input), { kind: 'error', error }, `input: ${JSON.stringify(input)}`);
  }
});

test('COMMANDS_HINT names the commands', () => {
  assert.equal(COMMANDS_HINT, '/chat N (or /c N) · /r · /start · /stop · /prune · /audit');
});

test('/prune takes optional guidance', () => {
  assert.deepEqual(parseCommand('/prune focus on X'), { kind: 'prune', text: 'focus on X' });
  assert.deepEqual(parseCommand('/prune'), { kind: 'prune', text: '' });
});

test('/audit takes optional focus text', () => {
  assert.deepEqual(parseCommand('/audit the rules'), { kind: 'audit', text: 'the rules' });
  assert.deepEqual(parseCommand('/audit'), { kind: 'audit', text: '' });
});
