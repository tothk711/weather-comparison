'use strict';
// Flat ESLint config. v2.0 shipped with NO devDependencies and no lint config
// at all — nothing stood between the codebase and the next 2,000-line file.

const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'public/vendor/**', 'Versions/**'],
  },
  {
    // Backend (CommonJS, Node)
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^next$', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      eqeqeq: ['warn', 'smart'],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-console': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    // Front-end (ES modules, browser). Chart is the vendored global.
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, Chart: 'readonly' },
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-unused-vars': 'off' },
  },
];
