#!/bin/bash
# Runs as init inside a lab guest, tries to reach things, and says what
# happened on the console.
#
# This is the half a rule listing cannot give you. The rules are loaded in the
# namespace outside; whether a guest can actually reach the metadata address is
# a question only the guest can answer, and it answers it by trying.
#
# A denial is a DROP rather than a reject, so a blocked attempt hangs until the
# timeout. That is why every probe is bounded and why a timeout counts as
# blocked: a guest that cannot tell the difference between dropped and slow is
# in exactly the position an attacker is.
set +e

mount -t proc proc /proc 2>/dev/null
mount -t sysfs sys /sys 2>/dev/null

say() { printf 'AI17Z-PROOF %s\n' "$*" > /dev/console; }

ip link set lo up 2>/dev/null
ip route show > /tmp/routes 2>/dev/null

say "guest-booted kernel=$(uname -r)"
say "guest-addr $(ip -o -4 addr show eth0 2>/dev/null | awk '{print $4}')"
say "guest-route $(ip -o -4 route show default 2>/dev/null | head -1)"

# Bounded TCP connect. Blocked and unreachable both come back as a failure,
# which is the right answer for both: the test is whether the guest got there.
probe() {
  local label="$1" host="$2" port="$3" want="$4"
  if timeout 4 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null; then
    local got="reached"
  else
    local got="blocked"
  fi
  if [ "$got" = "$want" ]; then
    say "ok $label $host:$port $got"
  else
    say "FAIL $label $host:$port got=$got want=$want"
  fi
}

# The single most valuable address to a compromised guest.
probe metadata 169.254.169.254 80 blocked
# The rest of link-local.
probe link-local 169.254.1.1 80 blocked
# The private ranges: the control plane, other tenants, management networks.
probe private-10 10.0.0.1 80 blocked
probe private-172 172.16.0.1 80 blocked
probe private-192 192.168.1.1 80 blocked
# Carrier-grade NAT, private in practice.
probe cgnat 100.64.0.1 80 blocked
# And the product working: a hosted agent reading the open web.
probe public-dns 1.1.1.1 443 reached
# A second public address, so the permitted half does not rest on one host.
# 93.184.216.34 was example.com and stopped answering, which looked exactly
# like a policy failure: a fixture that goes away is a test that lies.
probe public-dns2 8.8.8.8 53 reached
probe public-tls 9.9.9.9 443 reached

say "done"
sync
# A clean stop, so the lab is not left holding a guest.
poweroff -f 2>/dev/null || { echo o > /proc/sysrq-trigger 2>/dev/null; }
sleep 30
