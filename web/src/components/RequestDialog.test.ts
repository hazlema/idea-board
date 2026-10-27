import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { emptyBoard } from '../test-board';

vi.mock('$lib/api', () => ({ answerRequest: vi.fn().mockResolvedValue(undefined) }));

import * as api from '$lib/api';
import { live } from '$lib/live.svelte';
import RequestDialog from './RequestDialog.svelte';
import type { ForemanRequest } from '$lib/types';

const SYSTEMS = 'agent:x=systems';
const ART = 'agent:y=art';

function withRequest(state: ForemanRequest['state']): void {
  const board = emptyBoard();
  board.colab.claudeName = 'Claude · Foreman';
  board.colab.request = {
    id: 'r_1',
    by: 'claude',
    at: '',
    state,
    step: 0,
    steps: [
      { to: SYSTEMS, name: 'X · Systems', text: 'Rework the save format.' },
      { to: ART, name: 'Y · Art', text: 'Update the mockups to match.' },
    ],
  };
  live.board = board;
}

beforeEach(() => {
  vi.mocked(api.answerRequest).mockClear();
  live.board = emptyBoard();
});

test('shows the whole chain while a request waits', () => {
  withRequest('waiting');
  render(RequestDialog);
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(screen.getByText('Claude · Foreman asks:')).toBeInTheDocument();
  const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
  expect(rows).toEqual(['X · Systems: Rework the save format.', 'Y · Art: Update the mockups to match.']);
});

test('Yes and No answer with the request id', async () => {
  withRequest('waiting');
  render(RequestDialog);
  await fireEvent.click(screen.getByRole('button', { name: 'Yes, send it' }));
  await waitFor(() => expect(api.answerRequest).toHaveBeenCalledWith('r_1', true));
  await fireEvent.click(screen.getByRole('button', { name: 'No' }));
  await waitFor(() => expect(api.answerRequest).toHaveBeenCalledWith('r_1', false));
});

test('an answer the server refuses shows why', async () => {
  vi.mocked(api.answerRequest).mockRejectedValueOnce(new Error('That request has already been answered.'));
  withRequest('waiting');
  render(RequestDialog);
  await fireEvent.click(screen.getByRole('button', { name: 'No' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('That request has already been answered.');
});

test('hidden when nothing waits or a chain is playing', () => {
  render(RequestDialog);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  withRequest('playing');
  render(RequestDialog);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
