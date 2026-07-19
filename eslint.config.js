'use strict';

const js = require('@eslint/js');

const nodeGlobals = {
  process: 'readonly',
  require: 'readonly',
  module: 'readonly',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  global: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Chart: 'readonly',
  htmx: 'readonly',
};

module.exports = [
  js.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      'agent/**',
      'public/*.min.js',
      'public/chartjs-adapter-date-fns.bundle.min.js',
      'public/chart.umd.min.js',
      'public/htmx.min.js',
      'data/**',
    ],
  },
  {
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
      // Pre-existing patterns as of the CI-bootstrap PR (#104); downgraded rather
      // than hand-edited to avoid risky behavioral changes (e.g. null vs undefined
      // in a sqlite bind param). Revisit in a follow-up cleanup.
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
    },
  },
  {
    files: ['public/app.js', 'public/charts-client.js', 'public/reader.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: browserGlobals,
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
      'no-useless-assignment': 'warn',
    },
  },
];
