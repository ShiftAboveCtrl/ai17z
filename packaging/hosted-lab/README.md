# The hosted lab

Everything here exists to answer questions that cannot be answered by reading
code: does a tenant runtime actually boot, does the egress policy actually hold,
can two tenants reach each other, does a tenant survive being killed, and what
does one cost.

It runs against a real kernel. On Windows that is WSL, reached the same way
`tools/hosted-egress-proof.mts` reaches it. It needs root, and everything it
changes that outlives a run is in
[PRIVILEGED_CHANGES.md](PRIVILEGED_CHANGES.md) with the commands to undo it.

**Nothing here is protection from the host operator.** These are Firecracker
microVMs on an ordinary machine, so the host's root can read a guest's memory
and the key on its disk. That gap is what
[CONFIDENTIAL_COMPUTE.md](../../docs/architecture/CONFIDENTIAL_COMPUTE.md)
exists for, and no result from this lab may be cited as though it closed it.

## The one rule worth knowing first

**AI17Z renders what the lab runs.** The scripts place files and run an
argument vector; they decide nothing. The plan comes from
`npm run tenant:vm-plan`, the egress ruleset from `npm run tenant:ruleset`, and
`npm run guest:check` grades what the host reports back against what it was
asked to run.

That was not always true, and making it true found two faults in the first
minute: the boot configuration named the kernel by its path on the host, which
does not exist inside a jail, and both tenants ran as the same uid, which
`plansShareAnything` had always refused. A lab that writes its own
configuration proves that Firecracker works and nothing about what this
repository would do.

## Building the pieces

```bash
# Firecracker, the jailer, a kernel and an Ubuntu rootfs. Checksums verified.
sudo packaging/hosted-lab/bin/boot-lab-vm.sh

# The AI17Z guest image: the pinned Node, Postgres 16 and this repository.
# Takes a while, and publishes dl/image.json, which is the measurement
# everything else compares against.
sudo packaging/hosted-lab/bin/build-ai17z-guest.sh /path/to/this/repo 8
```

`build-ai17z-guest.sh` runs `npm ci` inside the chroot rather than copying a
`node_modules` in, because esbuild ships its binary as one platform package out
of an optional set and a Windows tree carries the wrong one.

## Running one tenant

```bash
npm run tenant:vm-plan -- --id lab-one --image /opt/ai17z-lab/dl/image.json \
  > /opt/ai17z-lab/lab-one.plan.json
npm run tenant:ruleset -- --tap "$(jq -r .tap /opt/ai17z-lab/lab-one.plan.json)" \
  > /opt/ai17z-lab/lab-one.nft
sudo /opt/ai17z-lab/bin/boot-ai17z-guest.sh lab-one /opt/ai17z-lab/lab-one.plan.json
```

The guest reports what it did: Postgres started, the tenant database created,
migrations applied, the api answering its own health endpoint, the worker ready,
and the memory it used. Sixteen seconds, measured, from launch to ready on an
empty disk.

## The proofs

| Harness | The question |
| --- | --- |
| `npm run hosted:egress-proof -- --netns <ns> --tap <tap>` | does a kernel accept the rendered ruleset, and does the guard notice a denial removed |
| `probe-egress.sh`, `guest-egress-test.sh` | does a guest actually fail to reach each denied range, and reach each permitted one |
| `two-tenant-proof.sh` | two tenants at once: different keys, different databases, different disks, different users, and neither able to reach the other while it is answering |
| `kill-tenant-proof.sh` | does a tenant killed as hard as a power cut come back with what it had |
| `npm run hosted:provision` | the whole provision, driven by AI17Z's own step machine, which stops at the step this hardware cannot perform |
| `npm run guest:check -- --plan <p> --report <r>` | did the host run what it was asked to run |
| `npm run hosted:provision-db` | the tenant database statements, against a real Postgres, on the right connections |
| `npm run hosted:measure` | what AI17Z costs on this machine, for comparison with what it costs in a guest |

Two of these harnesses had the same fault in their first draft and it is worth
knowing about: **they read a previous run's console log and graded it**. The
boot script empties that log before anything else now, and the harnesses delete
it themselves and refuse one older than their own start. A harness that can
grade the last run can report a pass for a run that never happened.

## Measuring rather than guessing

`npm run hosted:provision -- --lab` ends with a running tenant, and these are
the figures taken from one:

| | |
| --- | --- |
| Inside the guest | 410 MB used of its sized 863 MB |
| On the host | 461 MB resident for that guest |
| Database | 14 MB after 106 migrations |
| Launch to ready | 16 seconds, including `initdb` and every migration |
| Under 135 requests a second | moved 2 MB and stayed there |

`MEASURED_TENANT_FOOTPRINT` in `packages/runtime/src/tenantFootprint.ts` is
where the figure a plan uses lives, with its date and what it did not measure:
no browser, nothing generating, and not on confidential hardware.
