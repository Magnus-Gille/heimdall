"""Optional fleet-agent capability negotiation envelope."""

import importlib.util
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("heimdall_agent_core", Path(__file__).parent / "core.py")
core = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(core)


def test_absent_capability_overlay_preserves_legacy_payload():
    payload = {"hostname": "legacy"}
    assert core.attach_capability_contract(payload, None) == {"hostname": "legacy"}


def test_capability_overlay_is_attached_without_topology_fields():
    payload = core.attach_capability_contract(
        {"hostname": "node-a"},
        '{"version":1,"required":["node-capability-freshness"]}',
    )
    assert payload["capability_contract"]["version"] == 1
    assert "topology" not in payload["capability_contract"]


def test_malformed_capability_overlay_fails_locally_with_diagnostic():
    try:
        core.attach_capability_contract({"hostname": "node-a"}, "not json")
    except ValueError as exc:
        assert "CAPABILITY_CONTRACT_JSON" in str(exc)
    else:
        raise AssertionError("expected invalid JSON to fail")
