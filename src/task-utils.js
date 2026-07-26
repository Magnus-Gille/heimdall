'use strict';

/**
 * Shared extraction of the meaningful output from a Hugin task result string.
 * Used by both the web UI (html.js) and task notifications (notify.js).
 *
 * Strategy:
 *  1. Try extracting from a ```### Output``` code block
 *  2. Extract an Ollama-style `### Response` section
 *  3. Fallback: everything after the first ### heading
 *  4. Final fallback: full result text
 */
function extractResultOutput(result) {
  if (!result) return '';

  // Primary: extract from ### Output code block
  const outputMatch = result.match(/### Output\r?\n```[^\r\n]*\r?\n([\s\S]*?)```/);
  if (outputMatch) return outputMatch[1].trim();

  // Ollama returns a plain Response section rather than the shell-runtime
  // Output code fence. Its heading is metadata, not user-visible result text.
  const responseMatch = result.match(/^###[ \t]+Response[ \t]*\r?$/im);
  if (responseMatch && responseMatch.index !== undefined) {
    return result.slice(responseMatch.index + responseMatch[0].length).trim();
  }

  // Fallback: everything after the first result heading, without leaking it.
  const lines = result.split(/\r?\n/);
  const metaEnd = lines.findIndex((l) => l.startsWith('### '));
  if (metaEnd >= 0) {
    return lines.slice(metaEnd + 1).join('\n').trim();
  }

  // Final fallback: full result text
  return result.trim();
}

module.exports = { extractResultOutput };
