/* app.js — Heimdall v2 shared client script (external; CSP script-src 'self').
   Loaded in <head> so the saved theme applies before first paint (no FOUC).
   Uses event delegation so it works even though it runs before <body> parses. */
(function () {
  'use strict';

  // Apply saved theme immediately (documentElement exists in <head>).
  try {
    var saved = localStorage.getItem('heimdall-theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
    var status = localStorage.getItem('heimdall-status');
    if (status) document.documentElement.setAttribute('data-status', status);
  } catch (e) { /* localStorage unavailable — fall back to system preference */ }

  // Delegated click handler — robust regardless of when the button is parsed
  // or re-rendered by HTMX swaps.
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('.theme-toggle');
    if (!btn) return;
    var root = document.documentElement;
    var current = root.getAttribute('data-theme');
    // If unset, infer from the system preference so the first toggle flips visibly.
    if (!current) {
      current = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light' : 'dark';
    }
    var next = current === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('heimdall-theme', next); } catch (e) { /* ignore */ }
  });

  // Preserve expanded project cards across the /projects HTMX auto-refresh
  // (the project tree reloads every 300s). Re-ported from the v1 dashboard
  // during the v2 cutover (heimdall#54); CSP-safe here instead of inline.
  var PROJ_KEY = 'heimdall-projects-open';
  // Return { set, hasSaved } so we can tell "no preference saved yet" (leave the
  // server's default open/closed markup alone) from "user has a saved set" (apply
  // it fully). Absent key / unavailable storage / corrupt JSON → hasSaved:false.
  function projReadSaved() {
    try {
      var raw = localStorage.getItem(PROJ_KEY);
      if (raw === null) return { set: new Set(), hasSaved: false };
      return { set: new Set(JSON.parse(raw)), hasSaved: true };
    } catch (e) { return { set: new Set(), hasSaved: false }; }
  }
  // Persist the COMPLETE current open-set (snapshot of every rendered proj-card),
  // not an incremental add/delete — so a collapse of a server-default-open card
  // sticks and an untouched open card isn't wrongly dropped.
  function projSnapshotAndSave() {
    var open = new Set();
    document.querySelectorAll('details.proj-card[data-proj-slug]').forEach(function (el) {
      var slug = el.getAttribute('data-proj-slug');
      if (slug && el.open) open.add(slug);
    });
    try { localStorage.setItem(PROJ_KEY, JSON.stringify(Array.from(open))); } catch (e) { /* ignore */ }
  }
  function projRestoreAndBind() {
    var saved = projReadSaved();
    document.querySelectorAll('details.proj-card[data-proj-slug]').forEach(function (el) {
      var slug = el.getAttribute('data-proj-slug');
      if (!slug) return;
      // Only override server defaults once a preference exists; then apply the FULL
      // state so collapses of server-open cards persist across the HTMX refresh.
      if (saved.hasSaved) el.open = saved.set.has(slug);
      if (el.dataset.projBound === '1') return;   // bind each <details> once
      el.dataset.projBound = '1';
      el.addEventListener('toggle', projSnapshotAndSave);
    });
  }
  // Re-run after any HTMX swap (idempotent + cheap; only touches proj-card details,
  // which exist solely on /projects) and once after initial parse.
  document.addEventListener('htmx:afterSwap', projRestoreAndBind);
  document.addEventListener('DOMContentLoaded', projRestoreAndBind);
})();
