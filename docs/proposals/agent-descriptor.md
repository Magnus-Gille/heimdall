# Proposal: Agent-facing capability contract

**Status:** experimental / strawman · **Date:** 2026-06-28

> This is a design strawman, not a committed spec. This document is the durable
> design artifact; any implementation work should be tracked in current public
> issues.

## Summary

Promote Grimnir's existing self-description pattern into a first-class
**agent-facing capability contract**: extend each service's `heimdall.json`
descriptor with an `agent` block (mirrored at `/.well-known/agent.json`) that
declares *what an agent can do with this service and how* — affordances **with
semantics** (effects, auth, cost, idempotency, side-effects), a *when-to-use /
when-not* note, a pointer to the service's MCP (if any), and a **feedback
channel** so usage surfaces papercuts back into the system.

Heimdall already discovers descriptors (`src/discovery.js`) and renders
generically — so it becomes the **agent registry for the estate for free**.

## Motivation

We already run this pattern in two disconnected halves:

- **State/identity contract** — `heimdall.json` (`buildSelfDescriptor` in
  `src/render/service-page.js`): status, version, metrics, `alerts.rules`,
  panels, links. Consumed by Heimdall via tiered discovery (descriptor →
  `/health` → config). Describes *what a service is*, for rendering.
- **Capability contract** — MCP, where it exists (munin-memory, hugin, m5,
  microsoft). Describes *what you can do*, for agents.

The gap: `heimdall.json` describes **state**, not **affordances**. An HTTP
service like Heimdall (with `DELETE /api/alerts/:id`, `POST /api/alerts`,
`GET /api/status`, …) has no machine-readable, agent-facing statement of what
those endpoints do, what they cost, whether they're destructive, or what auth
they need. The platform move is to **unify both halves under one discoverable
manifest, pointed at agents** — not just at Heimdall's renderer.

**The hard part is semantics, not schema.** A signature list is trivial; what
prevents agent footguns is the metadata *around* each affordance (effect /
idempotent / auth / cost / rate-limit / side-effects / when-not-to-use /
see-also). That is where the value and the work both are.

### Closing the papercut loop

"More integration → we discover features & papercuts" is only a mechanism if
friction is **instrumented**. We own the pieces (`report_friction`, Munin, the
alert bus). So the publish-the-contract work and the friction-telemetry work are
the *same* project: a service publishes both *how to use me* and *where to report
that using me was harder than it should be*. (Concrete precedent: the alerts-UX
papercut fixed in #64 was found by a human eyeballing it — an agent consuming
that alert surface would have hit the identical wall and, with this channel,
reported it.)

## Strawman schema

Extend `heimdall.json` with an `agent` key (alias the whole doc at
`/.well-known/agent.json` for non-Grimnir agents). Heimdall's own block,
generated from its real route table:

```jsonc
{
  // ...existing heimdall.json fields (service, kind, status, version, metrics, alerts, panels, links, ui)...
  "agent": {
    "summary": "Infra dashboard + alert surface for the Grimnir estate.",
    "when_to_use": "Read estate health, fleet/service status, active alerts, deploy drift.",
    "when_not_to_use": "Not a metrics store (use Munin) or a task dispatcher (use Hugin).",

    // If the service has an MCP server, point to it — do NOT re-declare its tools here.
    // MCP stays the single source of truth for tools; `actions` is for HTTP-only services.
    "mcp": null,

    "actions": [
      {
        "id": "list_alerts",
        "method": "GET", "path": "/api/alerts",
        "summary": "All active alerts as JSON.",
        "effect": "read-only",          // read-only | mutating | destructive
        "idempotent": true,
        "auth": "localhost",            // none | localhost | bearer:<scope> | tailnet
        "cost": "free",
        "rate_limit": null,
        "returns": "Array<Alert>",
        "see_also": ["dismiss_alert"]
      },
      {
        "id": "dismiss_alert",
        "method": "DELETE", "path": "/api/alerts/{id}",
        "summary": "Acknowledge an active alert.",
        "params": { "id": { "in": "path", "type": "integer", "required": true } },
        "effect": "mutating",
        "idempotent": true,
        "auth": "none",
        "side_effects": "Sets acknowledged=1; hides from the Alerts tab + nav badge but NOT from overall status. A re-firing condition stays hidden; a genuine resolve-then-recur resurfaces it.",
        "errors": [{ "code": 400, "when": "id is not all-digits" }],
        "deprecated": false
      },
      {
        "id": "push_alert",
        "method": "POST", "path": "/api/alerts",
        "summary": "Ingest an alert (dedup by dedup_key).",
        "effect": "mutating", "idempotent": true,
        "auth": "bearer:alert-ingest",
        "body_schema": "AlertIngest"
      }
    ],

    "feedback": {
      "friction": "report_friction",
      "issues": "https://github.com/Magnus-Gille/heimdall/issues"
    },

    "contract": { "version": "1.0", "stability": "experimental", "generated": true }
  }
}
```

## Design principles

1. **Extend, don't fork.** Lives inside `heimdall.json` under `agent`; reuse the
   existing discovery plumbing. `/.well-known/agent.json` is an alias for agents
   that don't know the Grimnir convention.
2. **Affordances carry semantics.** `effect`, `idempotent`, `auth`, `cost`,
   `rate_limit`, `side_effects`, `errors`, `deprecated`, `see_also`, plus
   service-level `when_to_use` / `when_not_to_use`. This is the anti-footgun layer.
3. **MCP-first where it exists.** If a service has an MCP server, the block
   *points* to it; it does not re-declare tools. One source of truth.
4. **The contract must not lie.** `actions` are **generated from / validated
   against** the real route table by a contract test in each service's suite.
   Carries a `version` + `stability`. (Self-descriptions drift — the architecture
   doc drifted in the very session that spawned this proposal.)
5. **Feedback is part of the contract.** `feedback.friction` closes the
   discover-papercuts loop.
6. **Registry for free.** Heimdall already discovers descriptors → add
   `GET /api/agents` aggregating every reachable service's `agent` block into one
   estate-wide index agents can read.

## Open questions

- **`actions` shape:** bespoke thin schema (above) vs reuse OpenAPI. OpenAPI is
  verbose and lacks the agent semantics (`when_to_use`, `cost`, `effect`); lean
  bespoke, with a documented mapping to OpenAPI later.
- **MCP vs HTTP precedence** when a service has both — proposed: MCP is
  authoritative for tools, descriptor points to it.
- **Auth model for cross-service agent calls** — bearer scopes vs tailnet-only.
  Needs a decision before any *mutating* action is advertised to external agents.
- **Validation mechanism** — how each service proves "generated from reality"
  (shared contract-test helper?).
- **Single canonical doc vs two files** — extend `heimdall.json` and alias, or
  maintain a separate `agent.json`.

## Proposed phasing

- **P1** — Schema + Heimdall self-emits its own `agent` block (it knows its own
  routes), with a contract test asserting it against the route table.
- **P2** — `GET /api/agents` estate index in Heimdall (aggregate discovered
  descriptors' `agent` blocks).
- **P3** — One real agent→service integration, instrumented with
  `report_friction`; measure the first papercuts and iterate the schema.

Keep it a **thin convention**, not a framework — ~6 services, one operator.
Resist the spec.
