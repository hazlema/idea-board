import { expect, test } from 'vitest';
import { proxiedOrigin } from '../devProxy';

test('the dev page is passed on as the board server, so its requests are accepted', () => {
  expect(proxiedOrigin('http://localhost:5173', 'localhost:5173')).toBe('http://127.0.0.1:4777');
  expect(proxiedOrigin('http://127.0.0.1:5173', '127.0.0.1:5173')).toBe('http://127.0.0.1:4777');
  expect(proxiedOrigin('http://[::1]:5174', '[::1]:5174')).toBe('http://127.0.0.1:4777');
});

test('any other website keeps its own Origin, so the board server still rejects it', () => {
  expect(proxiedOrigin('https://evil.example', 'localhost:5173')).toBe('https://evil.example');
  expect(proxiedOrigin('http://localhost:3000', 'localhost:5173')).toBe('http://localhost:3000');
  // A rebound name pointing at this machine is not the dev page.
  expect(proxiedOrigin('http://evil.example:5173', 'evil.example:5173')).toBe('http://evil.example:5173');
  expect(proxiedOrigin('null', 'localhost:5173')).toBe('null');
});

test('a request without an Origin header is left without one', () => {
  expect(proxiedOrigin(undefined, 'localhost:5173')).toBeUndefined();
});
