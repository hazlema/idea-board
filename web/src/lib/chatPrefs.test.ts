import { beforeEach, expect, test } from 'vitest';
import { CHAT_FONT, ChatPrefs, fitWindow } from './chatPrefs.svelte';

beforeEach(() => localStorage.clear());

test('a new browser starts with the chat in its tab, a step bigger than the old text', () => {
  const prefs = new ChatPrefs();
  expect(prefs.popped).toBe(false);
  expect(prefs.fontSize).toBe(CHAT_FONT.initial);
  expect(CHAT_FONT.initial).toBeGreaterThan(14);
});

test('the text size, pop-out and window are remembered in this browser', () => {
  const prefs = new ChatPrefs();
  prefs.fontSize = 22;
  prefs.popped = true;
  prefs.window = { x: 40, y: 50, w: 500, h: 600 };

  const again = new ChatPrefs();
  expect(again.fontSize).toBe(22);
  expect(again.popped).toBe(true);
  expect(again.window).toEqual({ x: 40, y: 50, w: 500, h: 600 });
});

test('the text size stays between today\'s size and about double', () => {
  const prefs = new ChatPrefs();
  prefs.fontSize = 4;
  expect(prefs.fontSize).toBe(CHAT_FONT.min);
  prefs.fontSize = 99;
  expect(prefs.fontSize).toBe(CHAT_FONT.max);
  expect(CHAT_FONT.min).toBe(14);
  expect(CHAT_FONT.max).toBe(28);
});

test('junk in storage falls back to the defaults', () => {
  localStorage.setItem('idea-board-chat', '{not json');
  const prefs = new ChatPrefs();
  expect(prefs.fontSize).toBe(CHAT_FONT.initial);
  expect(prefs.window).toBeNull();
});

test('the floating window always fits on screen', () => {
  const screen = { w: 1200, h: 800 };
  // Dragged half off the right and bottom edges: pulled back in.
  expect(fitWindow({ x: 1000, y: 700, w: 400, h: 500 }, screen)).toEqual({ x: 800, y: 300, w: 400, h: 500 });
  // Off the top-left: pulled back in.
  expect(fitWindow({ x: -50, y: -20, w: 400, h: 500 }, screen)).toEqual({ x: 0, y: 0, w: 400, h: 500 });
  // Bigger than a shrunken browser window: it shrinks to fit.
  expect(fitWindow({ x: 100, y: 100, w: 900, h: 900 }, { w: 600, h: 500 })).toEqual({ x: 0, y: 0, w: 600, h: 500 });
});
