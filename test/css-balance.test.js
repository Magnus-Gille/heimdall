'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Guards against truncated/unbalanced stylesheets — e.g. a CSS block copied
// without its closing brace, which browsers silently recover from but tooling
// rejects and which makes later-appended rules apply to the wrong scope.
const CSS_DIR = path.join(__dirname, '..', 'public', 'css');

describe('public/css/*.css brace balance', () => {
  const files = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'));

  for (const f of files) {
    it(`${f} has balanced braces`, () => {
      const src = fs.readFileSync(path.join(CSS_DIR, f), 'utf8');
      const open = (src.match(/{/g) || []).length;
      const close = (src.match(/}/g) || []).length;
      assert.equal(open, close, `${f}: ${open} '{' vs ${close} '}'`);
    });
  }
});
