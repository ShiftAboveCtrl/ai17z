#!/bin/bash
# Gives a tenant namespace a real uplink, so the egress policy can be tested
# by trying rather than by reading a rule listing.
#
#   uplink.sh <netns> <tap>
#
# A veth pair joins the namespace to the host, the host masquerades it, and the
# tenant's own forward chain inside the namespace still decides what may leave.
# That is the shape a host would have: the guest's traffic is routed, and the
# filtering is in the namespace rather than in the guest.
set -euo pipefail

NS="${1:?usage: uplink.sh <netns> <tap>}"
TAP="${2:?usage: uplink.sh <netns> <tap>}"

SHORT="$(printf %s "$NS" | sha256sum | cut -c1-6)"
VETH_H="vh$SHORT"
VETH_N="vn$SHORT"
# A /30 per namespace, not a /30 shared by all of them. Two namespaces both
# given 172.30.0.1 put two addresses on the host that route to each other's
# veth, and the second one silently stops working: the namespace could not
# reach anything and nothing said why.
OCTET=$(( 0x$(printf %s "$NS" | sha256sum | cut -c1-2) % 64 ))
HOST_SIDE="172.30.$OCTET.1"
NS_SIDE="172.30.$OCTET.2"
LAB_RANGE="172.30.$OCTET.0/30"

say() { printf '  %s\n' "$*"; }

# Clean any previous attempt so this is repeatable.
ip link del "$VETH_H" 2>/dev/null || true

ip link add "$VETH_H" type veth peer name "$VETH_N"
ip link set "$VETH_N" netns "$NS"
ip addr add "$HOST_SIDE/30" dev "$VETH_H"
ip link set "$VETH_H" up
ip netns exec "$NS" ip addr add "$NS_SIDE/30" dev "$VETH_N"
ip netns exec "$NS" ip link set "$VETH_N" up
ip netns exec "$NS" ip route replace default via "$HOST_SIDE" dev "$VETH_N"

# The guest's /30 is behind the namespace, so the namespace routes and the host
# masquerades. Forwarding is enabled only in the namespace and for this one
# interface pair on the host.
ip netns exec "$NS" sysctl -qw net.ipv4.ip_forward=1
sysctl -qw net.ipv4.ip_forward=1 >/dev/null

UPLINK="$(ip -o route get 1.1.1.1 2>/dev/null | grep -oP '(?<=dev )\S+' | head -1)"
say "host uplink: ${UPLINK:-unknown}"

# Masquerade just this lab range, appended rather than flushing anything the
# machine already has.
iptables -t nat -C POSTROUTING -s "$LAB_RANGE" -j MASQUERADE 2>/dev/null ||
  iptables -t nat -A POSTROUTING -s "$LAB_RANGE" -j MASQUERADE
iptables -C FORWARD -i "$VETH_H" -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -i "$VETH_H" -j ACCEPT
iptables -C FORWARD -o "$VETH_H" -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -o "$VETH_H" -j ACCEPT

# Inside the namespace, traffic leaving the guest is masqueraded onto the veth
# so replies come back. The tenant forward policy still applies first.
ip netns exec "$NS" iptables -t nat -C POSTROUTING -o "$VETH_N" -j MASQUERADE 2>/dev/null ||
  ip netns exec "$NS" iptables -t nat -A POSTROUTING -o "$VETH_N" -j MASQUERADE

say "namespace can resolve and reach out:"
if ip netns exec "$NS" timeout 8 ping -c1 -W3 1.1.1.1 >/dev/null 2>&1; then
  say "  ping 1.1.1.1 from $NS: OK"
else
  say "  ping 1.1.1.1 from $NS: FAILED"
fi
printf 'RESULT netns=%s veth_host=%s veth_ns=%s tap=%s\n' "$NS" "$VETH_H" "$VETH_N" "$TAP"
