import js from '@eslint/js';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '.superpowers/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }],
    },
  },
  svelte.configs.recommended,
  {
    // The server, its libraries and its tests are plain Node modules.
    files: ['**/*.mjs', 'eslint.config.js', 'svelte.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/**/*.{ts,svelte}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
);
