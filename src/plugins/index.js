'use strict';

/**
 * plugins/index.js — the panel-plugin registry.
 *
 * Descriptor panels declare `plugin: "<name>"`; the generic service page resolves
 * the name here to render a live HTMX fragment (and to inject the plugin's CSS).
 * A plugin is `{ name, css?, renderPanel(panel, deps) -> Promise<string> }`.
 * New domain views register by adding their module here — the renderer core stays
 * generic and plugin-agnostic.
 */

const { plugin: inference } = require('./inference');
const { plugin: hugin } = require('./hugin');
const { plugin: skuld } = require('./skuld');

const REGISTRY = Object.create(null);
for (const p of [inference, hugin, skuld]) REGISTRY[p.name] = p;

/** @returns {object|null} the registered plugin, or null if unknown. */
function getPlugin(name) {
  return (name && typeof name === 'string' && REGISTRY[name]) || null;
}

/** @returns {object[]} all registered plugins. */
function listPlugins() {
  return Object.values(REGISTRY);
}

module.exports = { getPlugin, listPlugins, REGISTRY };
