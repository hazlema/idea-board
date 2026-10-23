import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';

vi.mock('$lib/api', () => ({ op: vi.fn().mockResolvedValue({}) }));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import Chat from './Chat.svelte';
import { chatPrefs } from '$lib/chatPrefs.svelte';
import { preview } from '../memory/preview.svelte';
import type { VersionMeta } from '$lib/types';

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.op).mockClear();
  live.board = emptyBoard();
  live.pointing = null;
  live.agent = 'idle';
  live.presence = false;
  preview.close();
});

async function typeAndSend(text: string) {
  const input = screen.getByPlaceholderText(/tell claude/i);
  await fireEvent.input(input, { target: { value: text } });
  await fireEvent.keyDown(input, { key: 'Enter' });
}

test('the pointing chip shows and its context is sent with the message', async () => {
  live.pointing = { kind: 'object', id: 'g_1', label: 'Wizards' };
  render(Chat);
  expect(screen.getByText('Talking about:')).toBeInTheDocument();
  expect(screen.getByText('Wizards')).toBeInTheDocument();

  await typeAndSend('expand this');

  await waitFor(() =>
    expect(api.op).toHaveBeenCalledWith({
      type: 'chat',
      text: 'expand this',
      context: [{ kind: 'object', id: 'g_1', label: 'Wizards' }],
    }),
  );
});

test('the chip clears the pointer and later messages carry no context', async () => {
  live.pointing = { kind: 'node', id: 'n_1', label: 'Combat' };
  render(Chat);
  await fireEvent.click(screen.getByRole('button', { name: 'Stop talking about Combat' }));
  expect(live.pointing).toBeNull();
  expect(screen.queryByText('Talking about:')).not.toBeInTheDocument();

  await typeAndSend('hello');
  await waitFor(() => expect(api.op).toHaveBeenCalledWith({ type: 'chat', text: 'hello', context: undefined }));
});

test('Shift+Enter does not send', async () => {
  render(Chat);
  const input = screen.getByPlaceholderText(/tell claude/i);
  await fireEvent.input(input, { target: { value: 'line one' } });
  await fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  expect(api.op).not.toHaveBeenCalled();
});

test('a long pointer label is cut to the 200 characters the server accepts', async () => {
  live.pointing = { kind: 'object', id: 'g_1', label: 'x'.repeat(300) };
  render(Chat);
  await typeAndSend('hi');
  await waitFor(() => expect(api.op).toHaveBeenCalled());
  const sent = vi.mocked(api.op).mock.calls[0][0] as unknown as { context: { label: string }[] };
  expect(sent.context[0].label).toHaveLength(200);
});

test('messages show who said them, and the agent status line follows the agent', async () => {
  const board = emptyBoard();
  board.chat = [
    { id: 'm_1', role: 'user', text: 'What about wizards?', at: '2026-10-22T10:00:00.000Z', handled: true },
    { id: 'm_2', role: 'claude', text: 'Wizards could be a class.', at: '2026-10-22T10:00:05.000Z', handled: true },
  ];
  live.board = board;
  live.agent = 'working';
  render(Chat);
  expect(screen.getByText('You')).toBeInTheDocument();
  expect(screen.getByText('Claude')).toBeInTheDocument();
  expect(screen.getByText('Wizards could be a class.')).toBeInTheDocument();
  expect(screen.getByText('Claude is working on the board')).toBeInTheDocument();
});

test('chat waits while a version is being previewed', async () => {
  const meta: VersionMeta = { id: 'v_1', name: 'Old', at: '', author: 'user', auto: false, stats: { groups: 0, entries: 0, notes: 0, pictures: 0, cards: 0 } };
  preview.current = { meta, content: emptyBoard() };
  render(Chat);

  const input = screen.getByPlaceholderText('Close the preview to chat');
  expect(input).toBeDisabled();
  await fireEvent.input(input, { target: { value: 'hello' } });
  await fireEvent.keyDown(input, { key: 'Enter' });
  expect(api.op).not.toHaveBeenCalled();

  preview.close();
  await waitFor(() => expect(screen.getByPlaceholderText(/tell claude/i)).toBeEnabled());
  await fireEvent.keyDown(screen.getByPlaceholderText(/tell claude/i), { key: 'Enter' });
  await waitFor(() => expect(api.op).toHaveBeenCalledWith({ type: 'chat', text: 'hello', context: undefined }));
});

test('the text size slider sizes the chat and is remembered', async () => {
  chatPrefs.fontSize = 17;
  render(Chat);
  const chat = screen.getByRole('region', { name: 'Chat with Claude' });
  expect(chat.style.fontSize).toBe('17px');

  await fireEvent.input(screen.getByRole('slider', { name: 'Chat text size' }), { target: { value: '24' } });
  expect(chat.style.fontSize).toBe('24px');
  expect(JSON.parse(localStorage.getItem('idea-board-chat') ?? '{}').fontSize).toBe(24);
});
