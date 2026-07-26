# Monitoring-agent capability contract v1

**Status:** public, versioned compatibility contract. **Transport:** optional
`capability_contract` object on `POST /api/fleet/push`.
The machine-readable schema is
[`monitoring-agent-capability-contract-v1.schema.json`](monitoring-agent-capability-contract-v1.schema.json).

Legacy fleet payloads omit this object and remain valid. A v1 producer may
declare `required` and `optional` capability names. Heimdall replies with its
accepted names; an unsupported required name returns HTTP 422 before any
telemetry is persisted.

```json
{
  "hostname": "node-a",
  "capability_contract": {
    "version": 1,
    "required": ["node-capability-freshness"],
    "optional": ["lifecycle-result"],
    "evidence": {
      "node-capability-freshness": { "observed_at": "2026-07-26T00:00:00Z", "status": "fresh" },
      "lifecycle-result": { "observed_at": "2026-07-26T00:01:00Z", "result": "completed" }
    }
  }
}
```

Supported v1 capabilities are `node-capability-freshness` and
`lifecycle-result`. Evidence is retained as bounded monitoring telemetry and
identified in the response as `authority: "observation_only"`.

This contract does not publish authentication details, live endpoints, node
topology, workload assignment, or private locations. Those belong in the
deployment overlay. Brokkr remains the authority for node capabilities,
lifecycle decisions, topology, and workloads; Heimdall only observes reported
evidence.

Error response for an unsupported requirement:

```json
{
  "error": "unsupported required capabilities",
  "capability_contract": {
    "version": 1,
    "unsupported_required": ["example-capability"],
    "diagnostic": "Heimdall records monitoring observations; it is not topology or workload authority."
  }
}
```
