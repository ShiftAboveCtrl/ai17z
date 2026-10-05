#!/bin/bash
# Boots one tenant's AI17Z runtime from the plan AI17Z rendered for it.
#
#   boot-ai17z-guest.sh <id> <plan.json>
#
# Nothing here decides anything. The plan comes from `npm run tenant:vm-plan`,
# which builds a MicroVmPlan, refuses it if `microVmPlanProblems` finds a
# fault, and prints the jailer argument vector, the boot configuration, the
# uid, the namespace, the tap, and which host file belongs at which name inside
# the jail. This script places those files, loads the tenant's egress ruleset,
# and runs the argument vector it was given.
#
# It used to decide all of it, from a configuration written in this file, and
# that was worth less than it looked: it proved Firecracker works and said
# nothing about what this repository would do. Pointing it at the plan found
# two faults in the plan immediately, which is the argument for doing it this
# way rather than the other.
#
# What the guest prints is what it did: Postgres started inside the boundary,
# migrations applied, the api answering its own health endpoint, the worker
# reporting ready, and the memory that actually cost.
#
# Environment:
#   AI17Z_PEER   another tenant's guest address, which this guest will try to
#                reach and report on
#   AI17Z_HOLD   1 to leave the guest running after it has finished, so
#                something outside it can probe it
set -euo pipefail

ID="${1:?usage: boot-ai17z-guest.sh <id> <plan.json>}"
PLAN="${2:?usage: boot-ai17z-guest.sh <id> <plan.json>}"

LAB=/opt/ai17z-lab
LOG="$LAB/$ID.console.log"
PEER="${AI17Z_PEER:-}"
HOLD="${AI17Z_HOLD:-0}"

say() { printf '  %s\n' "$*"; }

# Emptied first, before the namespace, the ruleset and the uplink, because
# those take long enough for something watching this file to read the whole of
# the previous run and conclude that this one had already finished.
: > "$LOG"

[ -f "$PLAN" ] || { echo "no plan at $PLAN; render one with npm run tenant:vm-plan" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is needed to read the plan" >&2; exit 2; }

p() { jq -r "$1" < "$PLAN"; }

UID_N="$(p .uid)"
GID_N="$(p .gid)"
NS="$(p .netnsName)"
TAP="$(p .tap)"
CHROOT_BASE="$(p .chrootBaseDir)"
DATA_DISK="$(p .dataDiskPath)"
DATA_GB="$(p .dataDiskGb)"
CONFIG_NAME="$(p .configName)"
KERNEL_SHA="$(p .measurement.kernelSha256)"
ROOTFS_SHA="$(p .measurement.rootfsSha256)"
KERNEL_NAME="$(p '.resources[0].nameInJail')"
ROOTFS_NAME="$(p '.resources[1].nameInJail')"

# A /30 per tenant rather than one shared by all of them. Two guests both at
# 172.31.0.2 cannot be told apart by an address, so nothing outside them could
# ask whether one can reach the other, which is the question.
OCTET=$(( 0x$(printf %s "$ID" | sha256sum | cut -c3-4) % 64 ))
HOST_IP="172.31.$OCTET.1"
GUEST_IP="172.31.$OCTET.2"

say "plan: uid $UID_N, $NS, $TAP, data $DATA_GB GB"

# Stop anything from a previous run: a guest still up holds its tap.
for pid in $(pgrep -f firecracker 2>/dev/null || true); do
  if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q -- "--id $ID"; then kill -TERM "$pid" 2>/dev/null || true; fi
done
sleep 1

ip netns del "$NS" 2>/dev/null || true
ip netns add "$NS"
ip netns exec "$NS" ip link set lo up
ip netns exec "$NS" ip tuntap add dev "$TAP" mode tap
ip netns exec "$NS" ip addr add "$HOST_IP/30" dev "$TAP"
ip netns exec "$NS" ip link set "$TAP" up

# The tenant egress policy, loaded before the guest can send a packet, and
# rendered by AI17Z: see tools/tenant-ruleset.mts.
if [ -f "$LAB/$ID.nft" ] && grep -q "$TAP" "$LAB/$ID.nft"; then
  ip netns exec "$NS" nft -f "$LAB/$ID.nft"
  say "tenant egress policy loaded ($(grep -c iifname "$LAB/$ID.nft") rules naming $TAP)"
else
  echo "no ruleset at $LAB/$ID.nft naming $TAP. Render one: npm run tenant:ruleset -- --tap $TAP" >&2
  exit 2
fi

# An uplink, so the guest can reach the open web the way a real tenant's
# research would. The tenant policy still decides what leaves.
if [ -x "$LAB/bin/uplink.sh" ]; then
  "$LAB/bin/uplink.sh" "$NS" "$TAP" >/dev/null 2>&1 || say "the uplink reported a problem"
fi

# This tenant's own user. A uid shared between two guests is one guest able to
# signal and inspect the other on the host, which is why plansShareAnything
# refuses it and why this comes from the plan rather than from here.
getent group "ai17z$GID_N" >/dev/null || groupadd -r -g "$GID_N" "ai17z$GID_N"
id -u "ai17z$UID_N" >/dev/null 2>&1 ||
  useradd -r -u "$UID_N" -g "$GID_N" -s /usr/sbin/nologin -M "ai17z$UID_N" 2>/dev/null

# The one writable image, made once and kept. Everything the tenant has is on
# it, so recreating it on every boot would be wiping the tenant.
mkdir -p "$(dirname "$DATA_DISK")"
if [ ! -f "$DATA_DISK" ]; then
  truncate -s "${DATA_GB}G" "$DATA_DISK"
  mkfs.ext4 -q -F "$DATA_DISK"
  say "a ${DATA_GB} GB data disk was created for this tenant"
else
  say "the tenant's existing data disk is being reused"
fi

rm -rf "$CHROOT_BASE"
JAIL="$CHROOT_BASE/firecracker/$ID/root"
mkdir -p "$JAIL"

# Each file at the name the plan says it answers to inside the jail. The
# read-only images are copied; the data disk is hard-linked, so what the tenant
# writes is on the tenant's own disk rather than on a copy of it thrown away
# with the jail.
while read -r resource; do
  FROM=$(printf '%s' "$resource" | jq -r .from)
  NAME=$(printf '%s' "$resource" | jq -r .nameInJail)
  WRITABLE=$(printf '%s' "$resource" | jq -r .writable)
  if [ "$WRITABLE" = "true" ]; then
    ln -f "$FROM" "$JAIL/$NAME"
  else
    cp --reflink=auto "$FROM" "$JAIL/$NAME"
  fi
done < <(jq -c '.resources[]' < "$PLAN")

# `root=/dev/vda ro` because the plan mounts the shared image read-only: a
# tenant that can write to it can change what the next one boots. Everything
# the tenant writes is on /dev/vdb, which the guest mounts itself.
BOOT_ARGS="console=ttyS0 reboot=k panic=1 pci=off ip=${GUEST_IP}::${HOST_IP}:255.255.255.252::eth0:off root=/dev/vda ro init=/ai17z-guest-init.sh ai17z.tenant=${ID} ai17z.peer=${PEER} ai17z.hold=${HOLD}"
jq --arg args "$BOOT_ARGS" '.config | .["boot-source"].boot_args = $args' < "$PLAN" > "$JAIL/$CONFIG_NAME"

chown -R "$UID_N:$GID_N" "$CHROOT_BASE"

# The argument vector as rendered, word for word. Read into an array rather
# than expanded unquoted, because a plan is data and word splitting is not a
# way to read data.
mapfile -t ARGV < <(jq -r '.argv[]' < "$PLAN")
setsid env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  "${ARGV[@]}" > "$LOG" 2>&1 < /dev/null &

say "booting as uid $UID_N under the jailer in $NS"
say "its address is $GUEST_IP${PEER:+, and it will try to reach $PEER}"

# AI17Z starting is a matter of minutes rather than seconds: initdb,
# migrations and two processes. Waited on rather than slept through.
for _ in $(seq 1 900); do
  grep -q 'AI17Z-GUEST done' "$LOG" 2>/dev/null && break
  sleep 1
done

printf '\n'
if grep -q 'AI17Z-GUEST' "$LOG" 2>/dev/null; then
  grep 'AI17Z-GUEST' "$LOG" | sed 's/AI17Z-GUEST /  /'
else
  say 'the guest said nothing. last of its console:'
  tail -8 "$LOG" | tr -d '\000' | sed 's/^/    /'
fi

# What the host says it actually ran, for AI17Z to compare against what it
# asked for. Two independent signals rather than one: the plan is what the
# control plane chose, and this is what the machine did. The measurements are
# taken from the files in the jail rather than copied out of the plan, or the
# comparison would be a number against itself.
FC_PID="$(pgrep -f "firecracker --id $ID" | head -1 || true)"
REPORT="$LAB/$ID.report.json"
jailed=false
seccomp=false
reported_uid=-1
if [ -n "$FC_PID" ]; then
  tr '\0' ' ' < "/proc/$FC_PID/cmdline" 2>/dev/null | grep -q -- "--id $ID" && jailed=true
  [ "$(awk '/^Seccomp:/{print $2}' "/proc/$FC_PID/status" 2>/dev/null)" = "2" ] && seccomp=true
  reported_uid="$(stat -c %u "/proc/$FC_PID" 2>/dev/null || echo -1)"
fi
jq -n \
  --arg id "$ID" \
  --arg kernel "$(sha256sum "$JAIL/$KERNEL_NAME" | cut -d' ' -f1)" \
  --arg rootfs "$(sha256sum "$JAIL/$ROOTFS_NAME" | cut -d' ' -f1)" \
  --argjson jailed "$jailed" \
  --argjson seccomp "$seccomp" \
  --argjson uid "$reported_uid" \
  --arg netns "/var/run/netns/$NS" \
  '{runtimeId:$id,kernelSha256:$kernel,rootfsSha256:$rootfs,jailed:$jailed,seccomp:$seccomp,uid:$uid,netns:$netns}' \
  > "$REPORT"
say "what the host ran is recorded in $REPORT"
[ "$(jq -r .kernelSha256 "$REPORT")" = "$KERNEL_SHA" ] || say "the kernel in the jail is not the one the plan named"
[ "$(jq -r .rootfsSha256 "$REPORT")" = "$ROOTFS_SHA" ] || say "the root filesystem in the jail is not the one the plan named"

FAILED=$(grep -c 'AI17Z-GUEST FAIL' "$LOG" 2>/dev/null || true)
printf '\n'
if [ "${FAILED:-1}" = "0" ] && grep -q 'AI17Z-GUEST done' "$LOG" 2>/dev/null; then
  say 'The canonical AI17Z ran inside the guest.'
  exit 0
fi
say "${FAILED:-?} step(s) failed inside the guest. Its own logs are in the jail at $JAIL."
exit 1
