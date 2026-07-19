"""
collectors/common.py

Shared psutil-based metric helpers.  All platform-specific collectors call
`base_metrics()` to get the common payload, then augment it.

Requires:  pip install psutil
"""

import time

try:
    import psutil
except ImportError as exc:
    raise ImportError(
        "psutil is required: run `pip install psutil` (or `pip3 install psutil`)"
    ) from exc

# Filesystem types that should be skipped (virtual / pseudo mounts).
_SKIP_FSTYPES = frozenset(
    {
        "tmpfs",
        "devtmpfs",
        "squashfs",
        "overlay",
        "proc",
        "sysfs",
        "devpts",
        "cgroup",
        "cgroup2",
        "pstore",
        "debugfs",
        "securityfs",
        "hugetlbfs",
        "mqueue",
        "fusectl",
        "efivarfs",
        "autofs",
        "binfmt_misc",
        "tracefs",
    }
)


def _mb(bytes_value: int) -> float:
    """Convert bytes to megabytes, rounded to 2 decimal places."""
    return round(bytes_value / (1024 * 1024), 2)


def _disk_list() -> list[dict]:
    """
    Return a list of real (non-virtual) disk partitions with usage stats.
    Each entry: {mount, total_mb, used_mb, used_pct}
    """
    partitions = psutil.disk_partitions(all=False)
    disks = []
    for part in partitions:
        if part.fstype.lower() in _SKIP_FSTYPES:
            continue
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except PermissionError:
            continue
        disks.append(
            {
                "mount": part.mountpoint,
                "total_mb": _mb(usage.total),
                "used_mb": _mb(usage.used),
                "used_pct": round(usage.percent, 1),
            }
        )
    return disks


def base_metrics() -> dict:
    """
    Collect metrics available on all supported platforms via psutil.

    Returns a dict with keys:
      cpu_pct        float   CPU usage % (1-second blocking sample)
      ram_total_mb   float   Total physical RAM in MB
      ram_used_mb    float   Used physical RAM in MB
      ram_used_pct   float   RAM used %
      uptime_s       float   Seconds since last boot
      load_1         float   1-minute load average  (0.0 on Windows)
      load_5         float   5-minute load average
      load_15        float   15-minute load average
      disk           list    One entry per real partition (see _disk_list)
    """
    # CPU — 1-second blocking sample for accuracy
    cpu_pct = psutil.cpu_percent(interval=1.0)

    # RAM
    mem = psutil.virtual_memory()
    ram_total_mb = _mb(mem.total)
    ram_used_mb = _mb(mem.used)
    ram_used_pct = round(mem.percent, 1)

    # Uptime
    uptime_s = round(time.time() - psutil.boot_time(), 1)

    # Load averages (not available on Windows; guard gracefully)
    try:
        load_1, load_5, load_15 = psutil.getloadavg()
    except (AttributeError, OSError):
        load_1 = load_5 = load_15 = 0.0

    # Disks
    disk = _disk_list()

    return {
        "cpu_pct": round(cpu_pct, 1),
        "ram_total_mb": ram_total_mb,
        "ram_used_mb": ram_used_mb,
        "ram_used_pct": ram_used_pct,
        "uptime_s": uptime_s,
        "load_1": round(load_1, 2),
        "load_5": round(load_5, 2),
        "load_15": round(load_15, 2),
        "disk": disk,
    }
