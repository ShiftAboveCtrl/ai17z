#!/bin/bash
# Boots one lab microVM the way a tenant would run: under the jailer, as an
# unprivileged user, in its own network namespace, with the egress rules loaded
# before the guest can send a packet.
#
#   boot-lab-vm.sh <id> [vcpus] [mem_mib]
#
# Everything it creates is named from <id> so a teardown can find it, and it
# prints a machine-readable summary at the end.
set -euo pipefail

ID="${1:?usage: boot-lab-vm.sh <id> [vcpus] [mem_mib]}"
VCPUS="${2:-1}"
MEM="${3:-512}"

LAB=/opt/ai17z-lab
DL="$LAB/dl"
CHROOT_BASE="$LAB/jail/$ID"
NS="ai17z-$ID"
# Linux caps an interface name at 15 characters, so the tap is named from a
# digest of the id rather than the id: "tap-tenant-alpha" is 16 and the kernel
# simply refuses it.
TAP="tap$(printf %s "$ID" | sha256sum | cut -c1-8)"
# A /30 per guest: two usable addresses, host and guest, and nothing else on it.
HOST_IP="172.31.0.1"
GUEST_IP="172.31.0.2"
MASK="30"

FC_UID=10000
FC_GID=10000

say() { printf '  %s\n' "$*"; }

# ---------------------------------------------------------------------------
# An unprivileged user for the guest. The jailer drops to it, so a guest
# process that escapes Firecracker is not root on the host.
# ---------------------------------------------------------------------------
getent group ai17zvm >/dev/null || groupadd -r -g "$FC_GID" ai17zvm
id -u ai17zvm >/dev/null 2>&1 || useradd -r -u "$FC_UID" -g ai17zvm -s /usr/sbin/nologin -M ai17zvm

# ---------------------------------------------------------------------------
# Its own network namespace. This is where the egress rules attach, so the
# guest cannot reach the host's own networks or the metadata address.
# ---------------------------------------------------------------------------
ip netns del "$NS" 2>/dev/null || true
ip netns add "$NS"
ip netns exec "$NS" ip link set lo up
ip netns exec "$NS" ip tuntap add dev "$TAP" mode tap
ip netns exec "$NS" ip addr add "$HOST_IP/$MASK" dev "$TAP"
ip netns exec "$NS" ip link set "$TAP" up

# Egress policy, loaded now rather than after the guest boots. Firecracker
# filters nothing itself, so without this the guest is unfiltered for however
# long the rules take to appear.
ip netns exec "$NS" iptables -F
ip netns exec "$NS" iptables -P FORWARD DROP
ip netns exec "$NS" iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for cidr in 169.254.169.254/32 169.254.0.0/16 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 0.0.0.0/8 255.255.255.255/32; do
  ip netns exec "$NS" iptables -A FORWARD -i "$TAP" -d "$cidr" -j DROP
done
ip netns exec "$NS" iptables -A FORWARD -i "$TAP" -j ACCEPT

# ---------------------------------------------------------------------------
# The jail. The jailer chroots into it, so the kernel and rootfs have to be
# inside, and it owns them as the unprivileged user.
# ---------------------------------------------------------------------------
rm -rf "$CHROOT_BASE"
JAIL="$CHROOT_BASE/firecracker/$ID/root"
mkdir -p "$JAIL"
cp "$DL/vmlinux" "$JAIL/vmlinux"
cp "$DL/rootfs.ext4" "$JAIL/rootfs.ext4"
chown -R "$FC_UID:$FC_GID" "$CHROOT_BASE"

cat > "$JAIL/config.json" <<JSON
{
  "boot-source": {
    "kernel_image_path": "vmlinux",
    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off ip=${GUEST_IP}::${HOST_IP}:255.255.255.252::eth0:off init=/bin/sh"
  },
  "drives": [
    { "drive_id": "rootfs", "path_on_host": "rootfs.ext4", "is_root_device": true, "is_read_only": false }
  ],
  "machine-config": { "vcpu_count": ${VCPUS}, "mem_size_mib": ${MEM}, "smt": false },
  "network-interfaces": [
    { "iface_id": "eth0", "host_dev_name": "${TAP}" }
  ]
}
JSON
chown "$FC_UID:$FC_GID" "$JAIL/config.json"

say "jail:      $JAIL"
say "namespace: $NS"
say "tap:       $TAP"

# ---------------------------------------------------------------------------
# Launch. The jailer's own arguments, then `--`, then Firecracker's.
# ---------------------------------------------------------------------------
LOG="$LAB/$ID.console.log"
: > "$LOG"
setsid jailer \
  --id "$ID" \
  --exec-file /usr/local/bin/firecracker \
  --uid "$FC_UID" \
  --gid "$FC_GID" \
  --chroot-base-dir "$CHROOT_BASE" \
  --netns "/var/run/netns/$NS" \
  -- \
  --config-file config.json \
  --no-api \
  > "$LOG" 2>&1 < /dev/null &

PID=$!
say "pid:       $PID"

# Wait for the guest to say something rather than sleeping a fixed amount.
for _ in $(seq 1 100); do
  if grep -qE 'Linux version|Run /bin/sh' "$LOG" 2>/dev/null; then break; fi
  sleep 0.2
done

printf 'RESULT id=%s pid=%s netns=%s tap=%s log=%s\n' "$ID" "$PID" "$NS" "$TAP" "$LOG"
