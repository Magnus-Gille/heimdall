#!/bin/bash
# Heimdall NAS metrics probe — CANONICAL SOURCE.
#
# This script runs ON the NAS (nas.local / 192.0.2.20) as the SSH
# forced-command pinned to the heimdall_ed25519 key in the NAS's
# ~/.ssh/authorized_keys:
#
#   command="/home/heimdall/heimdall-collect.sh",no-port-forwarding,... ssh-ed25519 ... heimdall@control-node
#
# Because it is a forced command, the collector's `collectRemoteViaSSH()`
# command string in src/metrics.js is IGNORED in production — this file is
# what actually runs. The two MUST stay in lockstep: the section order and
# probe paths here must match `buildNASProbeCommand()` and `parseSSHOutput()`
# in src/metrics.js. test/nas-collect-script.test.js enforces that.
#
# Deploy with: scripts/deploy-nas-probe.sh   (scp → /home/heimdall/heimdall-collect.sh)
#
# History: the munin backup dir was relocated to the external HDD (2026-04-27)
# and the mimir sync switched to a heartbeat stamp; both probe paths had drifted
# here and produced false critical "Backup stale" alerts until 2026-06-13.

# Section 0: CPU temp
cat /sys/class/thermal/thermal_zone0/temp
echo ---
# Section 1: meminfo
cat /proc/meminfo
echo ---
# Section 2: df
df --output=source,size,used,avail,pcent /dev/mmcblk0p2 /dev/sda1 2>/dev/null || true
echo ---
# Section 3: loadavg
cat /proc/loadavg
echo ---
# Section 4: uptime
cat /proc/uptime
echo ---
# Section 5: TM sparsebundle mtime (epoch)
stat -c "%Y" "/mnt/timemachine/Workstation.sparsebundle/com.apple.TimeMachine.SnapshotHistory.plist" 2>/dev/null || echo ""
echo ---
# Section 6: TM sparsebundle size (bytes)
du -sb "/mnt/timemachine/Workstation.sparsebundle/" 2>/dev/null || echo ""
echo ---
# Section 7: latest munin backup filename (external HDD — relocated 2026-04-27)
ls /mnt/timemachine/backups/munin-memory/ 2>/dev/null | tail -1
echo ---
# Section 8: munin backup count
ls /mnt/timemachine/backups/munin-memory/ 2>/dev/null | wc -l
echo ---
# Section 9: mimir backup log last line
tail -1 /home/heimdall/mimir-server/backup.log 2>/dev/null || echo ""
echo ---
# Section 10: mimir sync freshness — heartbeat stamp (run time) written by the
# laptop sync daemon after each successful push; fall back to newest content mtime.
cat /home/heimdall/mimir-sync.stamp 2>/dev/null || find /home/heimdall/mimir/ -type f -printf "%T@\n" 2>/dev/null | sort -rn | head -1 || echo ""
echo ---
# Section 11: CPU frequency (kHz)
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null || echo ""
echo ---
# Section 12: Throttle status
vcgencmd get_throttled 2>/dev/null || echo ""
echo ---
# Section 13: Under-voltage
cat /sys/class/hwmon/hwmon2/in0_lcrit_alarm 2>/dev/null || echo ""
echo ---
# Section 14: Network stats
cat /proc/net/dev 2>/dev/null
echo ---
# Section 15: Block device stats (SD)
cat /sys/block/mmcblk0/stat 2>/dev/null || echo ""
echo ---
# Section 16: Block device stats (NAS drive)
cat /sys/block/sda/stat 2>/dev/null || echo ""
echo ---
# Section 17: CPU stat line (for iowait)
head -1 /proc/stat 2>/dev/null || echo ""
echo ---
# Section 18: CPU core count
nproc 2>/dev/null || echo ""
