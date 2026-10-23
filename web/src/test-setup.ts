import '@testing-library/jest-dom/vitest';

// jsdom has no layout, so nothing ever resizes; Svelte's size bindings only need the observer to exist.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
