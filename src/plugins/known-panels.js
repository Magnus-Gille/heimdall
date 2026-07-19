'use strict';

/**
 * plugins/known-panels.js — static fallback panel sets for well-known services.
 *
 * When a service reaches only Tier 2 (/health) or Tier 3 (config-only) during
 * discovery — i.e. it does NOT serve /heimdall.json — Heimdall can still inject
 * a useful panel set for services it knows about by name.
 *
 * Tier-1 self-describing services own their own panels; this module is never
 * consulted for them (see discovery.js).
 */

const KNOWN = {
  hugin: [
    { id: 'hugin-tasks', plugin: 'hugin', view: 'tasks', label: 'Tasks', refresh: 60, fullWidth: true },
    { id: 'hugin-history', plugin: 'hugin', view: 'history', label: 'Task history', refresh: 120, fullWidth: true },
  ],
  skuld: [
    { id: 'skuld-briefing', plugin: 'skuld', view: 'briefing', label: 'Daily Briefing', refresh: 300, fullWidth: true },
  ],
};

/** Return a copy of the known panel set for `name`, or [] if unknown. */
function knownPanelsFor(name) {
  return KNOWN[name] ? KNOWN[name].map((p) => ({ ...p })) : [];
}

/**
 * Panel service aliases (#102): panels pushed to POST /api/panels under a
 * producer-chosen service id that belongs on another service's page. The M5
 * box pushes as `m5-inference` (the id the ingest schema example suggests),
 * but the operator-facing M5 page is the synthetic `m5-gateway` service.
 * Key: pushed producer id → owning page id.
 */
const PANEL_ALIAS_OWNER = {
  'm5-inference': 'm5-gateway',
};

/** Owning page id for a pushed producer id, or null if not aliased. */
function panelAliasOwnerOf(name) {
  return (name && Object.prototype.hasOwnProperty.call(PANEL_ALIAS_OWNER, name))
    ? PANEL_ALIAS_OWNER[name]
    : null;
}

/** All panel service ids rendered on `name`'s page: itself + producer ids it owns. */
function panelServiceIdsFor(name) {
  const aliased = Object.keys(PANEL_ALIAS_OWNER).filter((k) => PANEL_ALIAS_OWNER[k] === name);
  return [name, ...aliased];
}

module.exports = {
  knownPanelsFor, KNOWN,
  PANEL_ALIAS_OWNER, panelAliasOwnerOf, panelServiceIdsFor,
};
