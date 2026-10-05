# What the hosted lab changed on this machine

Everything in this file is a change the microVM lab made to the Linux side
(WSL) that outlives a single run. It is here because a lab that needs root is a
lab somebody has to be able to undo, and a change nobody recorded is a change
nobody can.

Nothing here touches Windows, the two installed AI17Z instances, their Docker
projects, their volumes or their Chrome profiles. Nothing disables a security
feature: no device was made world-writable, no management port listens on
anything but a namespace or loopback, and no firewall was flushed. The
`iptables` rules below are appended, scoped to this lab's own address range,
and the tenant policy itself is `nftables` inside each tenant's own namespace.

## Packages

Installed from the distribution's own repositories, with its own verification:

| Package | Why |
| --- | --- |
| `nftables` | the tenant egress policy is nftables, which is what `hostEgress.ts` renders |
| `iptables` | the lab's uplink masquerades a veth pair so a guest can reach the open web |
| `e2fsprogs` | making and checking the tenant data disks |
| `jq` | the boot script reads the plan AI17Z renders, which is JSON |
| `shellcheck` | these scripts are checked before they are run |

## Binaries

`/usr/local/bin/firecracker` and `/usr/local/bin/jailer`, from the official
v1.17.0 release, with the published checksum verified before either was
unpacked. Nothing else was placed outside `/opt/ai17z-lab`.

## Users

One unprivileged user per tenant, because `plansShareAnything` refuses two
plans that share a uid: a process can signal and inspect another running as the
same user, so two guests as one uid is one guest able to kill the other.

| User | Where it came from |
| --- | --- |
| `ai17zvm` (10000) | the first lab, before the uid came from the plan |
| `ai17z10517`, `ai17z16373`, `ai17z23515` | derived from the runtime ids `lab-one`, `tenant-bravo`, `tenant-alpha` |

Each is a system account with `/usr/sbin/nologin` and no home directory. A new
tenant id makes a new one, so this list grows with use.

## Kernel settings

`net.ipv4.ip_forward=1`, set on the host and in each tenant namespace, because
the guest's traffic is routed through its namespace and masqueraded. This is
the one global setting the lab changes. It is not persisted to a sysctl file,
so a WSL restart clears it and `uplink.sh` sets it again.

## Firewall

Appended, never flushed:

- `nat POSTROUTING ... -s 172.30.<n>.0/30 -j MASQUERADE`, one per tenant
  namespace, each scoped to that namespace's own veth range.
- `FORWARD -i/-o vh<hash> -j ACCEPT`, one pair per tenant veth.

The tenant's own policy is separate and is the thing that matters: an nftables
ruleset rendered by `tools/tenant-ruleset.mts`, loaded into that tenant's
namespace before the guest can send a packet, with `policy drop` and the
denials `MANDATORY_DENIALS` names.

## Disk

`/opt/ai17z-lab`, about 12 GB:

| | |
| --- | --- |
| `dl/` | the kernel, the guest image, the Firecracker release, and `image.json` |
| `jail/<id>/` | one chroot per tenant, replaced on every boot |
| `data/<id>.data.ext4` | the tenant's own writable disk, 8 GB sparse, **kept between boots** |
| `bin/` | the staged copies of `packaging/hosted-lab/bin` |
| `*.console.log`, `*.plan.json`, `*.nft`, `*.report.json` | what each tenant was given and what it said |

## Undoing all of it

```bash
# Stop every guest.
for p in $(pgrep -f '^/firecracker --id'); do kill -TERM "$p"; done

# Remove every tenant namespace.
for ns in $(ip netns list | awk '/^ai17z-/{print $1}'); do ip netns del "$ns"; done

# Remove the lab's firewall rules.
iptables -t nat -S POSTROUTING | grep -oP '(?<=-A )POSTROUTING -s 172\.30\.\S+ -j MASQUERADE' |
  while read -r rule; do eval "iptables -t nat -D $rule"; done
for v in $(ip -o link show | grep -oP 'vh[0-9a-f]{6}' | sort -u); do
  iptables -D FORWARD -i "$v" -j ACCEPT 2>/dev/null
  iptables -D FORWARD -o "$v" -j ACCEPT 2>/dev/null
  ip link del "$v" 2>/dev/null
done

# The lab itself, including every tenant's data disk.
rm -rf /opt/ai17z-lab

# The per-tenant users.
for u in $(getent passwd | awk -F: '$1 ~ /^ai17z[0-9]+$/ || $1 == "ai17zvm" {print $1}'); do
  userdel "$u" 2>/dev/null
  groupdel "$u" 2>/dev/null
done

# The binaries.
rm -f /usr/local/bin/firecracker /usr/local/bin/jailer
```

The packages are left, because they are ordinary distribution packages that
other things use and removing `iptables` from a machine is not a tidy-up.
`net.ipv4.ip_forward` clears itself on the next restart; set it back to 0 now
with `sysctl -w net.ipv4.ip_forward=0` if nothing else on the machine needs it.
