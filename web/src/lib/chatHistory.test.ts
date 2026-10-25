import { beforeEach, expect, test } from 'vitest';
import { ChatHistory, HISTORY_SIZE } from './chatHistory';

beforeEach(() => localStorage.clear());

test('Up goes back through what was sent, Down comes forward to the text being written', () => {
  const history = new ChatHistory();
  history.add('/chat 2 hello');
  history.add('/start build it');
  expect(history.older('half typed')).toBe('/start build it');
  expect(history.older('/start build it')).toBe('/chat 2 hello');
  expect(history.older('/chat 2 hello')).toBeNull();
  expect(history.newer()).toBe('/start build it');
  expect(history.newer()).toBe('half typed');
  expect(history.newer()).toBeNull();
});

test('the same message twice in a row is kept once, and sending starts again from the newest', () => {
  const history = new ChatHistory();
  history.add('/stop');
  history.add('/stop');
  history.add('go');
  expect(history.older('')).toBe('go');
  history.add('again');
  expect(history.older('')).toBe('again');
  expect(history.older('')).toBe('go');
  expect(history.older('')).toBe('/stop');
  expect(history.older('')).toBeNull();
});

test('it is remembered in this browser, up to the last 50', () => {
  const history = new ChatHistory();
  for (let i = 0; i < HISTORY_SIZE + 5; i++) history.add(`m${i}`);
  const again = new ChatHistory();
  expect(again.older('')).toBe(`m${HISTORY_SIZE + 4}`);
  let oldest = '';
  for (let next = again.older(''); next !== null; next = again.older('')) oldest = next;
  expect(oldest).toBe('m5');
});

test('junk in storage is an empty history', () => {
  localStorage.setItem('idea-board-chat-history', '{not json');
  expect(new ChatHistory().older('x')).toBeNull();
});
