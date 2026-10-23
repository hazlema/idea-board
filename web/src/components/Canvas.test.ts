import { expect, test } from 'vitest';
import { createRawSnippet } from 'svelte';
import { fireEvent, render, screen } from '@testing-library/svelte';
import Canvas from './Canvas.svelte';

const children = createRawSnippet(() => ({ render: () => '<div data-nopan><p>Some words in a box</p></div>' }));

function selectStart(target: Element): boolean {
  const event = new Event('selectstart', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

test('dragging the background pans without selecting text; text in a box still selects', async () => {
  render(Canvas, { tab: 'test', view: { x: 0, y: 0, k: 1 }, children });
  const canvas = screen.getByRole('application');

  await fireEvent.pointerDown(canvas, { button: 0, clientX: 10, clientY: 10 });
  expect(selectStart(canvas)).toBe(true);
  await fireEvent.pointerUp(canvas);

  const words = screen.getByText('Some words in a box');
  await fireEvent.pointerDown(words, { button: 0 });
  expect(selectStart(words)).toBe(false);
});
