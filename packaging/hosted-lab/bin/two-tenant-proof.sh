#!/bin/bash
# Runs two tenants' AI17Z runtimes at the same time and asks what each one can
# reach of the other.
#
#   two-tenant-proof.sh [idA] [idB]
#
# One guest running proves a runtime boots. The claim the product rests on is
# about two of them: different databases, different master keys, different
# filesystems, and no path from one to the other. None of that can be asked of
# a guest that has already powered off, so both are held open and probed while
# they are up.
#
# What this does not prove: anything about a host administrator. These guests
# are not confidential VMs, and the host root here can read both of their
# memory. That is the gap docs/architecture/CONFIDENTIAL_COMPUTE.md exists for.
set -euo pipefail

A="${1:-tenant-alpha}"
B="${2:-tenant-bravo}"
LAB=/opt/ai17z-lab

say() { printf '%s\n' "$*"; }
ok() { printf '  PASS  %s\n' "$*"; }
no() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
FAILED=0

addr_of() {
  local id="$1" octet
  octet=$(( 0x$(printf %s "$id" | sha256sum | cut -c3-4) % 64 ))
  printf '172.31.%s.2' "$octet"
}
tap_of() { printf 'tap%s' "$(printf %s "$1" | sha256sum | cut -c1-8)"; }

A_IP="$(addr_of "$A")"
B_IP="$(addr_of "$B")"
[ "$A_IP" != "$B_IP" ] || { echo "both tenants hashed to $A_IP; pick different names" >&2; exit 2; }

say "Two tenants: $A at $A_IP, $B at $B_IP"

# Gone before anything boots, and nothing below reads one that predates
# this moment. A harness that can grade the last run is a harness that can
# report a pass for a run that never happened.
STARTED=$(date +%s)
rm -f "$LAB/$A.console.log" "$LAB/$B.console.log"
say ""

# A ruleset each, rendered by AI17Z rather than written here. Rendered by the
# repository's own tooling before this runs, because an npm tree built for one
# platform cannot run on another: esbuild ships its binary as one platform
# package out of an optional set, so the Windows checkout this lab reads has
# the wrong one, and running npm in here would fail on a detail with nothing
# to do with what is being tested.
for id in "$A" "$B"; do
  TAP_ID="$(tap_of "$id")"
  if ! grep -q "$TAP_ID" "$LAB/$id.nft" 2>/dev/null; then
    cat >&2 <<MISSING
No ruleset for $id naming $TAP_ID. Render it with AI17Z, from the checkout:

  npm run tenant:ruleset -- --tap $TAP_ID > $LAB/$id.nft

MISSING
    exit 2
  fi
  if [ ! -f "$LAB/$id.plan.json" ]; then
    cat >&2 <<NOPLAN
No microVM plan for $id. Render it with AI17Z, from the checkout:

  npm run tenant:vm-plan -- --id $id --image $LAB/dl/image.json --against <the other tenant> > $LAB/$id.plan.json

NOPLAN
    exit 2
  fi
  say "  $id: $(grep -c iifname "$LAB/$id.nft") rules naming $TAP_ID, uid $(jq -r .uid "$LAB/$id.plan.json")"
done
say ""

# Booted together rather than one after the other, because concurrency is the
# condition being tested.
AI17Z_PEER="$B_IP" AI17Z_HOLD=1 "$LAB/bin/boot-ai17z-guest.sh" "$A" "$LAB/$A.plan.json" > "$LAB/$A.boot.log" 2>&1 &
PID_A=$!
AI17Z_PEER="$A_IP" AI17Z_HOLD=1 "$LAB/bin/boot-ai17z-guest.sh" "$B" "$LAB/$B.plan.json" > "$LAB/$B.boot.log" 2>&1 &
PID_B=$!
say "both booting; waiting for each to report it is holding"
for _ in $(seq 1 1200); do
  if grep -q 'AI17Z-GUEST holding' "$LAB/$A.console.log" 2>/dev/null &&
     grep -q 'AI17Z-GUEST holding' "$LAB/$B.console.log" 2>/dev/null; then break; fi
  sleep 1
done
say ""

for id in "$A" "$B"; do
  LOGGED=$(stat -c %Y "$LAB/$id.console.log" 2>/dev/null || echo 0)
  if [ "$LOGGED" -lt "$STARTED" ]; then
    echo "$id's console log is older than this run; refusing to grade it" >&2
    exit 3
  fi
done

for id in "$A" "$B"; do
  say "What $id said:"
  grep 'AI17Z-GUEST' "$LAB/$id.console.log" 2>/dev/null | sed 's/.*AI17Z-GUEST /    /' || say "    nothing"
  say ""
done

# ---------------------------------------------------------------------------
# What an outsider can check now that both are up.
# ---------------------------------------------------------------------------
say "Asked from outside, with both runtimes running:"

for id in "$A" "$B"; do
  if grep -q 'AI17Z-GUEST ok the worker reported ready' "$LAB/$id.console.log" 2>/dev/null; then
    ok "$id is a running AI17Z: api answered, worker ready"
  else
    no "$id did not reach a running AI17Z"
  fi
done

DIG_A=$(grep -o 'key digest [0-9a-f]*' "$LAB/$A.console.log" 2>/dev/null | tail -1 | awk '{print $3}')
DIG_B=$(grep -o 'key digest [0-9a-f]*' "$LAB/$B.console.log" 2>/dev/null | tail -1 | awk '{print $3}')
if [ -n "$DIG_A" ] && [ -n "$DIG_B" ] && [ "$DIG_A" != "$DIG_B" ]; then
  ok "two master keys, not one shared one ($DIG_A vs $DIG_B)"
else
  no "could not establish two distinct master keys (got '${DIG_A:-none}' and '${DIG_B:-none}')"
fi

for id in "$A" "$B"; do
  if grep -q "ok this database holds one tenant" "$LAB/$id.console.log" 2>/dev/null; then
    ok "$id's AI17Z database carries its own state and nobody else's"
  else
    no "$id did not establish that its database holds one tenant"
  fi
done

# Reaching a runtime, retried rather than attempted once. Two guests and a
# busy host is enough for a guest to stall: one of them logged a twenty-two
# second soft lockup during a run, and a six-second attempt against it would
# have been recorded as a refusal.
reach() {
  local ns="$1" to="$2" tries="${3:-10}"
  for _ in $(seq 1 "$tries"); do
    if ip netns exec "ai17z-$ns" timeout 6 bash -c "exec 3<>/dev/tcp/$to/8787" 2>/dev/null; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# Each runtime is established as answering first. Until that holds, a refusal
# of the other one says nothing: a neighbour that has not finished starting is
# unreachable for a reason that has nothing to do with isolation.
LIVE=1
for pair in "$A:$A_IP" "$B:$B_IP"; do
  id="${pair%%:*}"; ip="${pair##*:}"
  if reach "$id" "$ip" 20; then
    ok "$id's own runtime answers on $ip"
  else
    no "$id's runtime does not answer on $ip, so nothing about reachability can be proved"
    LIVE=0
  fi
done

# The question neither guest could answer about itself: from inside it, a
# neighbour still booting looks exactly like one it cannot reach. Asked here,
# with both of them answering.
probe() {
  local from="$1" to="$2"
  if reach "$from" "$to" 2; then
    no "$from reached the other tenant's runtime at $to"
  else
    ok "$from cannot reach the other tenant's runtime at $to, which is answering its own tenant"
  fi
}
if [ "$LIVE" = "1" ]; then
  probe "$A" "$B_IP"
  probe "$B" "$A_IP"
else
  no "both runtimes were not answering at once, so the cross-tenant checks were not attempted"
fi

# Separate filesystems, read from the host because that is the only place that
# can see both. The host being able to do this is the point of confidential
# compute, not a defect in the lab.
for id in "$A" "$B"; do
  JAIL="$LAB/jail/$id/firecracker/$id/root"
  if [ -f "$JAIL/rootfs.ext4" ]; then
    SEEN=$(( $(stat -c %i "$JAIL/rootfs.ext4") ))
    ok "$id writes to its own disk image (inode $SEEN)"
  else
    no "$id has no disk image of its own"
  fi
done
if [ -f "$LAB/jail/$A/firecracker/$A/root/rootfs.ext4" ] && [ -f "$LAB/jail/$B/firecracker/$B/root/rootfs.ext4" ]; then
  IA=$(stat -c %i "$LAB/jail/$A/firecracker/$A/root/rootfs.ext4")
  IB=$(stat -c %i "$LAB/jail/$B/firecracker/$B/root/rootfs.ext4")
  if [ "$IA" != "$IB" ]; then ok "the two disks are two files, not one shared one"; else no "both tenants are writing to one file"; fi
fi

# Two processes, two jails, each as the unprivileged uid.
RUNNING=$(pgrep -fc 'firecracker --id' 2>/dev/null || true)
say ""
say "  firecracker processes: ${RUNNING:-0}"
for id in "$A" "$B"; do
  P=$(pgrep -f "firecracker --id $id" | head -1 || true)
  WANT=$(jq -r .uid "$LAB/$id.plan.json")
  if [ -n "$P" ]; then
    U=$(stat -c %u "/proc/$P" 2>/dev/null || echo "?")
    if [ "$U" = "$WANT" ] && [ "$U" != "0" ]; then
      ok "$id runs as the uid its plan named ($U), not root"
    else
      no "$id runs as uid $U and its plan said $WANT"
    fi
  else
    no "$id has no running process"
  fi
done

# Each as its own user. Two guests as one uid is one guest able to signal and
# inspect the other on the host, which is why plansShareAnything refuses it.
# Both ran as 10000 until the lab started booting from the plan.
UID_A=$(jq -r .uid "$LAB/$A.plan.json")
UID_B=$(jq -r .uid "$LAB/$B.plan.json")
if [ "$UID_A" != "$UID_B" ]; then
  ok "the two tenants run as different users ($UID_A and $UID_B)"
else
  no "both tenants run as uid $UID_A, so either could signal the other on the host"
fi

# The shared image, mounted read-only, which is what stops one tenant changing
# what the next one boots. Asserted on the configuration the guest was given.
for id in "$A" "$B"; do
  CFG="$(jq -r .chrootBaseDir "$LAB/$id.plan.json")/firecracker/$id/root/$(jq -r .configName "$LAB/$id.plan.json")"
  if [ "$(jq -r '.drives[] | select(.is_root_device) | .is_read_only' "$CFG" 2>/dev/null)" = "true" ]; then
    ok "$id booted the shared image read-only, so it cannot change what the next tenant boots"
  else
    no "$id booted a writable root image"
  fi
  if [ "$(jq -r '[.drives[] | select(.is_read_only == false)] | length' "$CFG" 2>/dev/null)" = "1" ]; then
    ok "$id has exactly one writable disk, which is its own"
  else
    no "$id does not have exactly one writable disk"
  fi
done

# What the host says it ran. Comparing it with the plan is AI17Z's own
# judgement, guestMatchesPlan, run from the checkout by
# tools/guest-report-check.mts: an npm tree built for one platform cannot run
# on another, so the lab records the evidence and the product grades it. What
# this can establish is that the evidence exists and names this runtime.
for id in "$A" "$B"; do
  R="$LAB/$id.report.json"
  if [ -f "$R" ] && [ "$(jq -r .runtimeId "$R")" = "$id" ]; then
    ok "$id recorded what the host ran: jailed=$(jq -r .jailed "$R") seccomp=$(jq -r .seccomp "$R") uid=$(jq -r .uid "$R")"
  else
    no "$id produced no usable host report, so nothing can be compared with its plan"
  fi
done

say ""
if [ "$FAILED" = "0" ]; then
  say "RESULT two tenants ran at once, isolated on every property this lab can check"
else
  say "RESULT $FAILED check(s) failed"
fi

say ""
say "Leaving both running. To stop them:"
say "  pkill -f 'firecracker --id $A'; pkill -f 'firecracker --id $B'"
wait "$PID_A" "$PID_B" 2>/dev/null || true
exit "$FAILED"
