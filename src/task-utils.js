'use strict';

/**
 * Shared extraction of the meaningful output from a Hugin task result string.
 * Used by both the web UI (html.js) and task notifications (notify.js).
 *
 * Strategy:
 *  1. Try extracting from a ```### Output``` code block
 *  2. Fallback: everything from the first ### heading onwards (inclusive)
 *  3. Final fallback: full result text
 */
function extractResultOutput(result) {
  if (!result) return '';

  // Primary: extract from ### Output code block
  const outputMatch = result.match(/### Output\n```[\s\S]*?\n([\s\S]*?)```/);
  if (outputMatch) return outputMatch[1].trim();

  // Fallback: everything from first ### heading onwards (keep heading)
  const lines = result.split('\n');
  const metaEnd = lines.findIndex((l, i) => i > 0 && l.startsWith('### '));
  if (metaEnd > 0) {
    return lines.slice(metaEnd).join('\n').trim();
  }

  // Final fallback: full result text
  return result.trim();
}

module.exports = { extractResultOutput };
