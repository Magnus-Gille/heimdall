'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractResultOutput } = require('../src/task-utils');

describe('extractResultOutput', () => {
  it('strips a generic first-line result heading but preserves text without headings', () => {
    assert.equal(extractResultOutput('### Result\nUseful body.'), 'Useful body.');
    assert.equal(extractResultOutput('Useful body without a heading.'), 'Useful body without a heading.');
  });

  it('extracts Output and Response sections when Hugin uses CRLF line endings', () => {
    assert.equal(
      extractResultOutput('metadata\r\n### Output\r\n```\r\nfirst\r\nsecond\r\n```'),
      'first\r\nsecond',
    );
    assert.equal(extractResultOutput('### Response\r\nUseful body.'), 'Useful body.');
  });
});
