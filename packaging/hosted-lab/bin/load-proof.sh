#!/bin/bash
# How many tenants this machine actually carries, measured one at a time.
#
#   load-proof.sh <count> [id-prefix]
#
# `capacityFrom` computes a slot count from measured memory, and until now
# nothing had checked that number against a machine actually holding that many
# tenants. This boots them one at a time, measures after each, and stops the
# moment a guest fails to come up or the host crosses a floor it should not.
#
# ## Bounded on purpose
#
# It refuses to start without enough free memory for every tenant it was asked
# for, and it stops rather than continuing once the host drops below
# MIN_FREE_MB. Finding the limit by hitting it is how somebody loses the work
# they had open, and a load test that takes the machine down has measured
# nothing except its own recklessness.
#
# ## What it measures
#
# Per tenant: resident memory on the host, the guest's own reading, and whether
# its api still answers. After each one, every earlier tenant is asked again,
# because the question is not whether the newest one started but whether the
# older ones are still there.
set -uo pipefail

COUNT="${1:?usage: load-proof.sh <count> [id-prefix]}"
PREFIX="${2:-load}"
LAB=/opt/ai17z-lab

# Per tenant, from the measurement: a sized guest at 863 MB costs about 518 MB
# resident. Rounded up, because a load test that under-budgets is the thing
# this file exists to avoid.
PER_TENANT_MB=700
# The floor. Below this the host has no room to recover anything, which is the
# same reasoning as the scheduler's own headroom.
MIN_FREE_MB=4096

say() { printf '%s\n' "$*"; }
ok() { printf '  PASS  %s\n' "$*"; }
no() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
FAILED=0

freeMb() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
addrOf() { printf '172.31.%s.2' "$(( 0x$(printf %s "$1" | sha256sum | cut -c3-4) % 64 ))"; }
rssOf() {
  local pid
  pid=$(pgrep -f "^/firecracker --id $1" | head -1)
  [ -n "$pid" ] && echo $(( $(awk '/^VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0) / 1024 )) || echo 0
}
answers() {
  ip netns exec "ai17z-$1" timeout 8 bash -c "exec 3<>/dev/tcp/$(addrOf "$1")/8787" 2>/dev/null
}

started=()

say "Staging up to $COUNT tenants, one at a time."
BEFORE=$(freeMb)
say "  host memory available before anything: ${BEFORE} MB"
NEEDED=$(( COUNT * PER_TENANT_MB + MIN_FREE_MB ))
if [ "$BEFORE" -lt "$NEEDED" ]; then
  say ""
  say "Refusing: ${COUNT} tenants need about ${NEEDED} MB including the ${MIN_FREE_MB} MB floor, and ${BEFORE} MB is available."
  say "Finding the limit by hitting it is how somebody loses the work they had open."
  exit 2
fi
say ""

for n in $(seq 1 "$COUNT"); do
  id="$PREFIX-$n"
  if [ ! -f "$LAB/$id.plan.json" ] || [ ! -f "$LAB/$id.nft" ]; then
    say "  no plan or ruleset for $id. Render them from the checkout:"
    say "    npm run tenant:vm-plan -- --id $id --image $LAB/dl/image.json > $LAB/$id.plan.json"
    say "    npm run tenant:ruleset -- --tap \$(jq -r .tap $LAB/$id.plan.json) > $LAB/$id.nft"
    break
  fi

  rm -f "$LAB/$id.console.log"
  AI17Z_HOLD=1 "$LAB/bin/boot-ai17z-guest.sh" "$id" "$LAB/$id.plan.json" > "/tmp/load-$id.log" 2>&1
  if ! grep -q 'AI17Z-GUEST holding' "$LAB/$id.console.log" 2>/dev/null; then
    no "$id did not come up, so $(( n - 1 )) is what this machine carried"
    tail -3 "/tmp/load-$id.log" | sed 's/^/        /'
    break
  fi
  started+=("$id")

  guestUsed=$(grep -oE 'used=[0-9]+MB' "$LAB/$id.console.log" | tail -1 | tr -dc '0-9')
  now=$(freeMb)
  printf '  %-10s up. host rss %4s MB, guest used %4s MB, host free %6s MB\n' "$id" "$(rssOf "$id")" "${guestUsed:-?}" "$now"

  # The question is not whether the newest one started. It is whether the ones
  # that were already running are still answering.
  stillThere=0
  for earlier in "${started[@]}"; do
    answers "$earlier" && stillThere=$((stillThere+1))
  done
  if [ "$stillThere" -eq "${#started[@]}" ]; then
    ok "all ${#started[@]} tenant(s) answering"
  else
    no "only $stillThere of ${#started[@]} answering, so ${#started[@]} is past what this machine carries"
    break
  fi

  if [ "$now" -lt "$MIN_FREE_MB" ]; then
    say "  stopping: ${now} MB free is below the ${MIN_FREE_MB} MB floor, and a host with no room cannot recover anything."
    break
  fi
done

AFTER=$(freeMb)
say ""
say "Carried ${#started[@]} tenant(s) at once."
if [ "${#started[@]}" -gt 0 ]; then
  say "  host memory: ${BEFORE} MB before, ${AFTER} MB after, so about $(( (BEFORE - AFTER) / ${#started[@]} )) MB a tenant"
fi
say ""
say "Stopping them all."
for id in "${started[@]}"; do
  for p in $(pgrep -f "^/firecracker --id $id" || true); do kill -TERM "$p" 2>/dev/null || true; done
done
sleep 3
say "  host memory available again: $(freeMb) MB"

say ""
if [ "$FAILED" = "0" ]; then
  say "RESULT ${#started[@]} tenants ran at once, every one of them still answering."
else
  say "RESULT stopped at ${#started[@]} tenants: $FAILED check(s) failed, which is the measurement rather than a fault."
fi
exit 0
