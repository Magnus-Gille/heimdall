'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const DOCS_DIR = path.join(os.homedir(), 'mimir', 'reading');
const EXPORT_DIR = DOCS_DIR;

function deriveTitle(markdown, slug) {
  const h1 = markdown.match(/^#{1,2}\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function deriveExcerpt(markdown) {
  const stripped = markdown
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/^>.*$/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1');
  const paragraphs = stripped.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const first = paragraphs[0] || '';
  if (first.length <= 240) return first;
  return first.slice(0, 237).replace(/\s+\S*$/, '') + '…';
}

async function listArticles({ dir = DOCS_DIR } = {}) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const mdFiles = entries.filter(f => f.endsWith('.md') && /^[a-z0-9]/.test(f));
  const articles = await Promise.all(mdFiles.map(async name => {
    const full = path.join(dir, name);
    const [stat, markdown] = await Promise.all([fs.stat(full), fs.readFile(full, 'utf8')]);
    const slug = name.replace(/\.md$/, '');
    return {
      slug,
      name,
      path: full,
      markdown,
      mtime: stat.mtimeMs,
      mtimeIso: new Date(stat.mtimeMs).toISOString(),
      title: deriveTitle(markdown, slug),
      excerpt: deriveExcerpt(markdown),
      wordCount: (markdown.match(/\S+/g) || []).length,
    };
  }));
  articles.sort((a, b) => b.mtime - a.mtime);
  return articles;
}

async function getArticle(slug, opts = {}) {
  const articles = await listArticles(opts);
  return articles.find(a => a.slug === slug) || null;
}

function isValidSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(slug) && slug.length <= 100;
}

module.exports = {
  DOCS_DIR,
  EXPORT_DIR,
  listArticles,
  getArticle,
  deriveTitle,
  deriveExcerpt,
  isValidSlug,
};
