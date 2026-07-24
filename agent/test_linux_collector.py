"""
Tests for collectors.linux thermal-zone discovery (issue #5).

Zone index (thermal_zone0, thermal_zone1, ...) is boot-order assignment, not a
stable identifier -- it can change across reboots, kernel updates, or hardware
revisions. Selection must key on each zone's declared `type` file instead.
These tests build fixture sysfs trees under tmp_path for representative
layouts (Pi single-zone, x86 multi-zone, reordered zones, a missing tree, and
an unreadable/malformed zone) rather than mocking the filesystem, since
_list_thermal_zones/_read_cpu_temp take an injectable root.

Run from the agent/ directory:  python3 -m pytest test_linux_collector.py
"""

import os

import pytest

from collectors.linux import _list_thermal_zones, _read_cpu_temp, _select_cpu_temp
from collectors.thermal_zone_types import CPU_TEMP_ZONE_TYPES


def _write_zone(root, index, zone_type=None, temp=None, unreadable=False):
    zone_dir = root / f"thermal_zone{index}"
    zone_dir.mkdir(parents=True, exist_ok=True)
    if zone_type is not None:
        (zone_dir / "type").write_text(f"{zone_type}\n")
    if temp is not None:
        temp_path = zone_dir / "temp"
        temp_path.write_text(f"{temp}\n")
        if unreadable:
            os.chmod(temp_path, 0o000)


class TestRepresentativeLayouts:
    def test_pi_style_single_cpu_thermal_zone(self, tmp_path):
        _write_zone(tmp_path, 0, "cpu-thermal", 45678)
        assert _read_cpu_temp(str(tmp_path)) == 45.7

    def test_x86_style_multi_zone_picks_configured_package_sensor(self, tmp_path):
        _write_zone(tmp_path, 0, "acpitz", 27000)
        _write_zone(tmp_path, 1, "x86_pkg_temp", 52300)
        _write_zone(tmp_path, 2, "iwlwifi_1", 40000)
        assert _read_cpu_temp(str(tmp_path)) == 52.3

    def test_reordered_zones_same_types_different_indices_select_same_reading(self, tmp_path):
        root_a = tmp_path / "boot_a"
        root_b = tmp_path / "boot_b"
        _write_zone(root_a, 0, "cpu-thermal", 50000)
        _write_zone(root_a, 1, "gpu-thermal", 41000)
        # Same two zones, boot-reassigned to opposite indices (e.g. after a reboot).
        _write_zone(root_b, 0, "gpu-thermal", 41000)
        _write_zone(root_b, 1, "cpu-thermal", 50000)

        assert _read_cpu_temp(str(root_a)) == 50.0
        assert _read_cpu_temp(str(root_a)) == _read_cpu_temp(str(root_b))

    def test_missing_sysfs_tree_returns_none_not_a_crash_or_zero(self, tmp_path):
        missing_root = str(tmp_path / "does-not-exist")
        assert _read_cpu_temp(missing_root) is None

    def test_unreadable_zone_returns_none_not_a_healthy_zero(self, tmp_path):
        _write_zone(tmp_path, 0, "cpu-thermal", 45000, unreadable=True)
        try:
            assert _read_cpu_temp(str(tmp_path)) is None
        finally:
            os.chmod(tmp_path / "thermal_zone0" / "temp", 0o600)

    def test_malformed_temp_value_returns_none_not_a_crash(self, tmp_path):
        zone_dir = tmp_path / "thermal_zone0"
        zone_dir.mkdir()
        (zone_dir / "type").write_text("cpu-thermal\n")
        (zone_dir / "temp").write_text("not-a-number\n")
        assert _read_cpu_temp(str(tmp_path)) is None

    def test_no_zone_matches_any_configured_type_returns_none(self, tmp_path):
        _write_zone(tmp_path, 0, "some-unrelated-sensor", 12345)
        assert _read_cpu_temp(str(tmp_path)) is None

    def test_empty_thermal_directory_returns_none(self, tmp_path):
        # Tree exists but has zero thermal_zone* entries.
        assert _read_cpu_temp(str(tmp_path)) is None


class TestSelectCpuTemp:
    def test_unreadable_matched_zone_does_not_fall_through_to_a_different_sensor(self):
        zones = [
            {"type": "cpu-thermal", "temp_c": None},  # matched type, but unreadable/malformed
            {"type": "x86_pkg_temp", "temp_c": 52.3},
        ]
        # cpu-thermal outranks x86_pkg_temp in the default priority list, and
        # is present (just broken) -- must not silently substitute the other zone.
        assert _select_cpu_temp(zones) is None

    def test_configurable_priority_list_can_prefer_a_type_not_in_the_default(self):
        zones = [{"type": "my-custom-soc-sensor", "temp_c": 55.0}]
        assert _select_cpu_temp(zones) is None  # not in the default list
        assert _select_cpu_temp(zones, ["my-custom-soc-sensor", *CPU_TEMP_ZONE_TYPES]) == 55.0


class TestListThermalZones:
    def test_returns_empty_list_for_missing_root(self, tmp_path):
        assert _list_thermal_zones(str(tmp_path / "nope")) == []

    def test_ignores_non_zone_entries(self, tmp_path):
        _write_zone(tmp_path, 0, "cpu-thermal", 40000)
        (tmp_path / "cooling_device0").mkdir()
        zones = _list_thermal_zones(str(tmp_path))
        assert len(zones) == 1
        assert zones[0]["type"] == "cpu-thermal"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
