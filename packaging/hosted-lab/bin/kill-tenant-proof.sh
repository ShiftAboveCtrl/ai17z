#!/bin/bash
# What a tenant survives when its runtime is killed as hard as a power cut.
#
#   kill-tenant-proof.sh <id> <plan.json>
#
# A product selling somebody's agent state is making a durability claim, and
# nothing had tested it. Two kills, each at a moment that matters, and then the
# question that decides it: does the tenant come back with what it had.
#
# ## Measured by mounting, never by e2fsck -fn
#
# `e2fsck -fn` cannot replay a journal. With -n it opens the image read-only
# and reports the filesystem as it stands before replay, so an interrupted
# tenant reads as having lost everything: 11 files where a healthy one has
# 2,058. It had lost nothing. A durable system measured as lost is the wrong
# way round for a mistake about durability to go, so this mounts the disk,
# which replays, and counts what is actually there.
#
# ## What it does not test
#
# The host crashing. A guest killed with SIGKILL leaves its writes in the
# host's page cache, and the host writes them out; a host that loses power
# does not. That case is what the tenant disk's `cache_type` governs, which
# `microVm.ts` sets to Writeback for exactly this reason, and testing it needs
# a machine somebody is willing to cut the power to.
set -uo pipefail

ID="${1:?usage: kill-tenant-proof.sh <id> <plan.json>}"
PLAN="${2:?usage: kill-tenant-proof.sh <id> <plan.json>}"

LAB=/opt/ai17z-lab
MOUNT=/mnt/ai17z-inspect
DISK="$(jq -r .dataDiskPath "$PLAN")"
LOG="$LAB/$ID.console.log"

say() { printf '%s\n' "$*"; }
ok() { printf '  PASS  %s\n' "$*"; }
no() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
FAILED=0

stop() { for p in $(pgrep -f "^/firecracker --id $ID" || true); do kill -TERM "$p" 2>/dev/null || true; done; sleep 1; }

# Boots and waits for one of the guest's own lines, then kills without warning.
kill_at() {
  local wanted="$1"
  rm -f "$DISK" "$LOG"
  AI17Z_HOLD=1 "$LAB/bin/boot-ai17z-guest.sh" "$ID" "$PLAN" > /tmp/kill-tenant-boot.log 2>&1 &
  local _
  for _ in $(seq 1 300); do
    grep -q "AI17Z-GUEST $wanted" "$LOG" 2>/dev/null && break
    sleep 0.5
  done
  if ! grep -q "AI17Z-GUEST $wanted" "$LOG" 2>/dev/null; then
    no "the guest never reached \"$wanted\"; its boot said: $(tail -2 /tmp/kill-tenant-boot.log | tr '\n' ' ')"
    return 1
  fi
  kill -KILL "$(pgrep -f "^/firecracker --id $ID" | head -1)" 2>/dev/null
  sleep 2
}

# What is on the disk, after the journal has been replayed by mounting it.
inspect() {
  local label="$1"
  mkdir -p "$MOUNT"
  if ! mount -o loop "$DISK" "$MOUNT" 2>/dev/null; then
    no "$label: the disk would not mount at all"
    return
  fi
  local files cluster wal key
  files=$(find "$MOUNT" -type f 2>/dev/null | wc -l)
  cluster=$([ -f "$MOUNT/postgresql/tenant/PG_VERSION" ] && echo yes || echo no)
  wal=$(find "$MOUNT/postgresql/tenant/pg_wal" -type f 2>/dev/null | wc -l)
  key=$([ -s "$MOUNT/ai17z/custody/runtime.sealed" ] && echo kept || echo gone)
  umount "$MOUNT"

  # A tenant's cluster is a couple of thousand files. A hundred would mean
  # most of it had gone, and the count is here rather than a yes or no so a
  # partial loss is visible rather than rounded to one or the other.
  if [ "$cluster" = yes ] && [ "$files" -gt 1500 ] && [ "$wal" -gt 0 ] && [ "$key" = kept ]; then
    ok "$label: $files files, the cluster, $wal log segment(s), and the key"
  else
    no "$label: $files files, cluster=$cluster, log segments=$wal, key=$key"
  fi
}

say "Killing $ID with SIGKILL, which is as hard as a power cut to the VM."
say ""

stop
if kill_at 'holding'; then
  inspect 'killed after its boot finished'
fi

if kill_at 'ok migrations applied'; then
  inspect 'killed the instant its migrations committed'
fi

say ""
say "Then booting it again, onto the disk it was killed with:"
# Read from the guest's own console log rather than from the boot script's
# output, which has already stripped the AI17Z-GUEST prefix it prints under.
# Grepping its stdout for that prefix finds nothing and, under pipefail, reads
# as the tenant having failed to boot.
AI17Z_HOLD=0 "$LAB/bin/boot-ai17z-guest.sh" "$ID" "$PLAN" > /tmp/kill-tenant-reboot.log 2>&1 || true
grep -E 'AI17Z-GUEST (ok|FAIL)' "$LOG" | sed 's/.*AI17Z-GUEST /    /'
for wanted in \
  'existing database cluster is being reused' \
  'the tenant database is already there' \
  'the runtime key was reused' \
  'the worker reported ready'; do
  if grep -q "$wanted" "$LOG"; then
    ok "it came back: $wanted"
  else
    no "it did not report: $wanted"
  fi
done

say ""
if [ "$FAILED" = "0" ]; then
  say "RESULT a tenant killed without warning comes back with what it had."
else
  say "RESULT $FAILED check(s) failed."
fi
exit "$FAILED"
