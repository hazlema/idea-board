import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';

vi.mock('$lib/api', () => ({ op: vi.fn().mockResolvedValue({}) }));

import { chatPrefs } from '$lib/chatPrefs.svelte';
import { live } from '$lib/live.svelte';
import ChatWindow, { defaultWindow } from '../components/ChatWindow.svelte';
import CollaborateView from './CollaborateView.svelte';

beforeEach(() => {
  localStorage.clear();
  live.board = emptyBoard();
  chatPrefs.popped = false;
  chatPrefs.window = null;
});

test('Pop out floats the chat; the tab says so and can bring it back', async () => {
  render(CollaborateView);
  expect(screen.getByPlaceholderText(/message everyone/i)).toBeInTheDocument();

  await fireEvent.click(screen.getByRole('button', { name: /Pop out/ }));
  expect(chatPrefs.popped).toBe(true);
  expect(screen.getByText('The chat is popped out.')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText(/message everyone/i)).toBeNull();

  await fireEvent.click(screen.getByRole('button', { name: 'Bring it back here' }));
  expect(chatPrefs.popped).toBe(false);
  expect(screen.getByPlaceholderText(/message everyone/i)).toBeInTheDocument();
});

test('the chat window opens where it was left, and ✕ puts the chat back in its tab', async () => {
  chatPrefs.popped = true;
  chatPrefs.window = { x: 30, y: 40, w: 400, h: 300 };
  render(ChatWindow);
  const box = screen.getByRole('dialog', { name: 'Chat window' });
  expect(box.style.left).toBe('30px');
  expect(box.style.top).toBe('40px');
  expect(box.style.width).toBe('400px');
  expect(screen.getByPlaceholderText(/message everyone/i)).toBeInTheDocument();

  await fireEvent.click(screen.getByRole('button', { name: 'Close the chat window' }));
  expect(chatPrefs.popped).toBe(false);
});

test('a window never moved starts in the bottom-right corner', () => {
  expect(defaultWindow({ w: 1600, h: 900 })).toEqual({ x: 1136, y: 356, w: 440, h: 520 });
});
