# Authoring Projects for Heimdall's `/projects` Page

This page explains what Heimdall reads from Munin and how to write project
entries so they render well. Source of truth for what the page renders:
`src/munin-projects.js` and `src/html.js` (`projectCard` near line 1228).

## Data flow

1. `munin-projects.js:fetchProjects()` calls `memory_query` for
   `projects/*` state entries with `key: "status"`.
2. For each active project, it fetches the full `status` body via
   `memory_read` to get non-truncated content.
3. It optionally fetches a `key: "synthesis"` entry for AI-generated summary.
4. It parses structured markdown sections (`## Vision`, `## Current Work`,
   `## Blockers`, `## Next Steps`, `## Roadmap`) via `parseStructuredSections`.
5. `html.js:projectCard()` renders one card per project: a compact header
   with the first line of `## Vision` as tagline, and the rest of the sections
   revealed when the card is expanded.

## Sections Heimdall reads

| Section        | Where it shows up                                                 |
|----------------|-------------------------------------------------------------------|
| `## Vision`    | First line becomes the tagline under the project name.            |
| `## Current Work` | Main body when the card is expanded.                           |
| `## Blockers`  | Highlighted callout + red left border + "⚠ blocked" chip.         |
| `## Next Steps`| Collapsible inside the expanded card body.                        |
| `## Roadmap`   | Collapsible inside the expanded card body.                        |

Lifecycle comes from tags: `active`, `maintenance`, `stopped`, `completed`,
`archived`, `needs_attention`. The lifecycle dot color on the compact card
reflects this.

## Write paths

| What you want                    | Use this                                               |
|----------------------------------|--------------------------------------------------------|
| Update Phase / Current Work / Blockers / Next Steps / Notes | `memory_update_status` — preserves tags, updates canonical sections, and (since munin-memory 874ec1a) preserves any non-canonical sections like `## Vision` and `## Roadmap`. |
| Add or remove tags (e.g. lifecycle, `needs_attention`) without touching content | `memory_write` with `patch: { tags_add: [...], tags_remove: [...] }`. |
| Full-body rewrite                | `memory_write` with `content: "..."` and the entire tag set. Use `expected_updated_at` for compare-and-swap. |

### Conventions

- Put the tagline in the first line of `## Vision`.
- Put active work in `## Current Work`.
- Put blockers in `## Blockers` (use `None.` to clear).
- Put upcoming work in `## Next Steps` (bulleted list).
- Put long-form narrative roadmap in `## Roadmap` (prose).

## Tag constraints

Tags are validated server-side with
`TAG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/`.

- Allowed: `active`, `parent:grimnir`, `type:container`, `date:2026-04-15`,
  `client:lofalk`, `topic:memory`.
- **Not allowed:** dots, slashes, spaces, equals signs. So
  `roadmap_url:https://github.com/...` is invalid. Put external URLs in
  content (`## Roadmap` section), not in tags.
- Max 20 tags per entry.

## Expand-state persistence

The projects page (`src/render/projects.js` in the v2 shell) auto-refreshes
every 300 seconds via HTMX, loading the project tree from the
`/api/card/projects-list` fragment (`projectsListCard`).

**Note (v2 cutover):** the v1 dashboard persisted expanded cards across the
refresh via a `htmx:afterSwap` handler that restored open slugs from
`localStorage` (`heimdall-projects-open`). That handler lived in the old
`projectsPage()` in `src/html.js`, which was removed in the cutover and is
**not yet re-ported** into the v2 shell — so expanded cards currently reset
on each refresh. To restore it, add the handler to a CSP-safe external
script (e.g. `public/app.js`), since the v2 shell forbids inline scripts.
