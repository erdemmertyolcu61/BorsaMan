// ESLint 9 flat config — a REAL gate, not a style police.
// Focus: bugs that ship (undefined vars, reassigned consts, dup keys, bad hooks,
// unreachable code). Stylistic/opinionated rules are off so the gate stays
// signal-heavy on a large codebase with a few god-files.

import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'graphify-out/**', '.claude/**'] },

  // ── Source (browser React) ──
  {
    files: ['src/**/*.{js,jsx}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2023 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: '18' } },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,

      // Vite's automatic JSX runtime — no React import needed, no prop-types here.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unknown-property': 'off',
      'react/display-name': 'off',
      'react/no-unescaped-entities': 'off',

      // Real bugs → error
      'react-hooks/rules-of-hooks': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-func-assign': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'valid-typeof': 'error',
      'use-isnan': 'error',
      'no-self-assign': 'error',
      'no-unsafe-negation': 'error',

      // Noisy-but-useful → warn (don't block, but surface)
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'react-hooks/exhaustive-deps': 'warn',
      'react/jsx-key': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],

      // Off — intentional in this codebase / too noisy to be signal
      'no-control-regex': 'off',
      'react/no-children-prop': 'off',
    },
  },

  // ── Dual browser+Node module (env-detection via typeof process/require) ──
  {
    files: ['src/utils/DatabaseManager.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  // ── Test files (Vitest globals) ──
  {
    files: ['src/**/*.{test,spec}.{js,jsx}', 'src/**/__tests__/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node,
        describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly', beforeAll: 'readonly', afterAll: 'readonly',
        vi: 'readonly' },
    },
    rules: { 'no-unused-vars': 'off' },
  },
];
