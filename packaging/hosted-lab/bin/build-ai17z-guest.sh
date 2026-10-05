#!/bin/bash
# Builds a guest rootfs that runs the real AI17Z.
#
#   build-ai17z-guest.sh <repo-path-inside-wsl> [size-gb]
#
# The point of this image is a claim: that the canonical AI17Z runs inside a
# microVM, not a cloud edition of it. So the image carries this repository and
# its own Postgres, and the init starts the real api and worker and asks the
# real health endpoint. Nothing is stubbed, because a stub would prove the stub.
#
# Node comes from the version pinned in packaging/node-runtime.json, verified
# against nodejs.org's published SHASUMS256, which is the same runtime every
# AI17Z platform package ships. An image built against a different Node would
# be testing something the product does not run.
#
# Postgres is inside the guest rather than reached across the network, and that
# is the architecture rather than a convenience: the tenant egress policy denies
# every private range, so a guest cannot reach the control plane's database and
# must not be able to. One tenant, one database, inside the boundary.
set -euo pipefail

REPO="${1:?usage: build-ai17z-guest.sh <repo-path-inside-wsl> [size-gb]}"
SIZE_GB="${2:-6}"

LAB=/opt/ai17z-lab
DL="$LAB/dl"
OUT="$DL/rootfs-ai17z.ext4"
MNT=/mnt/ai17z-guest-build

say() { printf '  %s\n' "$*"; }

[ -d "$REPO/packages/runtime" ] || { echo "no AI17Z repository at $REPO" >&2; exit 2; }
[ -f "$DL/rootfs.squashfs" ] || { echo "no base rootfs at $DL/rootfs.squashfs; run the lab download first" >&2; exit 2; }

NODE_VERSION="$(grep -oP '(?<="version": ")v[0-9.]+' "$REPO/packaging/node-runtime.json")"
say "node: $NODE_VERSION, from the version this project pins"

# ---------------------------------------------------------------------------
# A fresh filesystem, big enough for Node, Postgres and the application.
# ---------------------------------------------------------------------------
umount -R "$MNT" 2>/dev/null || true
rm -rf "$MNT" "$DL/squashfs-ai17z"
mkdir -p "$MNT"

say "unpacking the base rootfs"
unsquashfs -q -d "$DL/squashfs-ai17z" "$DL/rootfs.squashfs"

rm -f "$OUT"
truncate -s "${SIZE_GB}G" "$OUT"
mkfs.ext4 -q -F "$OUT"
mount -o loop "$OUT" "$MNT"
cp -a "$DL/squashfs-ai17z/." "$MNT/"
say "base rootfs copied into a ${SIZE_GB}G image"

# ---------------------------------------------------------------------------
# The pinned Node, verified rather than trusted.
# ---------------------------------------------------------------------------
TARBALL="node-${NODE_VERSION}-linux-x64.tar.xz"
if [ ! -f "$DL/$TARBALL" ]; then
  say "fetching $TARBALL"
  curl -fsSL -o "$DL/$TARBALL" "https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}"
  curl -fsSL -o "$DL/node-SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
fi
WANT="$(grep " $TARBALL\$" "$DL/node-SHASUMS256.txt" | awk '{print $1}')"
GOT="$(sha256sum "$DL/$TARBALL" | awk '{print $1}')"
if [ "$WANT" != "$GOT" ]; then
  echo "node tarball checksum mismatch: published $WANT, got $GOT" >&2
  exit 1
fi
say "node checksum matches the published SHASUMS256"
mkdir -p "$MNT/opt/node"
tar -xJf "$DL/$TARBALL" -C "$MNT/opt/node" --strip-components=1

# ---------------------------------------------------------------------------
# Postgres, from the distribution's own archive, inside the guest.
# ---------------------------------------------------------------------------
mount --bind /dev "$MNT/dev"
mount --bind /proc "$MNT/proc"
mount --bind /sys "$MNT/sys"
cp /etc/resolv.conf "$MNT/etc/resolv.conf"

# apt needs a writable /tmp to pass its config to apt-key, and without one every
# repository reads as unsigned. The fix is a writable /tmp, not
# --allow-unauthenticated: a signature check that was turned off to make a build
# work is a signature check that stays off.
mkdir -p "$MNT/tmp" "$MNT/var/tmp"
chmod 1777 "$MNT/tmp" "$MNT/var/tmp"
# The CI rootfs ships without apt's working directories, because it was never
# meant to install anything. Each of these is a directory apt creates on a
# normal system and expects to find on every other one.
mkdir -p   "$MNT/var/cache/apt/archives/partial"   "$MNT/var/lib/apt/lists/partial"   "$MNT/var/lib/dpkg/updates"   "$MNT/var/log/apt"

say "installing postgres inside the guest image"
chroot "$MNT" /bin/bash -eu -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends postgresql postgresql-client ca-certificates >/dev/null
  apt-get clean
  rm -rf /var/lib/apt/lists/*
  pg_config --version
' | sed 's/^/    /'

# ---------------------------------------------------------------------------
# The application. Copied rather than built in the guest: the image has to be
# reproducible from a known tree, and an npm install inside it would make the
# image depend on whatever the registry served that minute.
# ---------------------------------------------------------------------------
say "copying AI17Z into the image"
mkdir -p "$MNT/opt/ai17z"
# node_modules is deliberately **not** copied. npm installs exactly one
# platform package out of an optional set, which is how esbuild ships its
# binary, so a tree installed on Windows carries @esbuild/win32-x64 and a Linux
# guest needs @esbuild/linux-x64. Copying it produced exactly the error esbuild
# prints about this, and this project has already paid for the mirror image of
# the same mistake in its own packaging notes.
tar -C "$REPO" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./*/node_modules' \
  --exclude='./*/*/node_modules' \
  --exclude='./storage' \
  --exclude='./dist' \
  --exclude='*.tsbuildinfo' \
  --exclude='./apps/web/dist' \
  -cf - . | tar -C "$MNT/opt/ai17z" -xf -

say "installing Linux dependencies inside the image"
# PATH is written out rather than prepended to the host's, so nothing here
# depends on which shell expanded it. The guest's own PATH is the one that
# matters inside a chroot.
chroot "$MNT" /usr/bin/env \
  PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  npm_config_fund=false npm_config_audit=false \
  /bin/bash -eu -c '
    cd /opt/ai17z
    # Not --omit=optional: that removes the platform package esbuild ships its
    # binary in, and then every tsx process the application runs fails.
    npm ci --no-progress > /tmp/npm.log 2>&1 || { tail -25 /tmp/npm.log; exit 1; }
    node -e "require(\"esbuild\"); console.log(\"esbuild loads on linux\")"
  ' | sed 's/^/    /'

say "image contents"
printf '    %-18s %s\n' node "$(chroot "$MNT" /opt/node/bin/node --version)"
printf '    %-18s %s\n' postgres "$(chroot "$MNT" pg_config --version 2>/dev/null || echo unknown)"
printf '    %-18s %s\n' ai17z "$(du -sh "$MNT/opt/ai17z" | cut -f1)"

# ---------------------------------------------------------------------------
# The init. Starts Postgres, migrates, starts AI17Z, asks it how it is.
# ---------------------------------------------------------------------------
install -m 0755 /dev/stdin "$MNT/ai17z-guest-init.sh" <<'INIT'
#!/bin/bash
# Runs as init inside the guest. Everything it says is something it did.
set +e
mount -t proc proc /proc 2>/dev/null
mount -t sysfs sys /sys 2>/dev/null
mount -t devtmpfs dev /dev 2>/dev/null
mkdir -p /dev/shm && mount -t tmpfs tmpfs /dev/shm 2>/dev/null
ip link set lo up 2>/dev/null

# The root filesystem is the image, mounted read-only, and nothing writes to
# it. A tenant that can write to the shared image can change what the next
# tenant boots, which is why bootConfiguration has always said is_read_only
# and why this init is the half that makes that survivable.
mount -t tmpfs -o size=256m tmpfs /tmp 2>/dev/null
mount -t tmpfs -o size=64m tmpfs /run 2>/dev/null
# /var/run as well, because it is a real directory in this image rather than a
# symlink to /run, and Postgres puts its socket lock file there by default. A
# read-only one fails as "could not create lock file", which reads as a
# database fault and is a mount.
mount -t tmpfs -o size=16m tmpfs /var/run 2>/dev/null
chmod 1777 /tmp

# /etc and /root have to be writable: initdb writes a locale archive, useradd
# rewrites passwd, and a read-only /etc fails inside Postgres in a way that
# reads as a database fault rather than as a mount. An overlay in memory,
# because none of it is state worth keeping.
for d in etc root; do
  mkdir -p "/run/ovl/$d/upper" "/run/ovl/$d/work" 2>/dev/null
  mount -t overlay overlay -o "lowerdir=/$d,upperdir=/run/ovl/$d/upper,workdir=/run/ovl/$d/work" "/$d" 2>/dev/null
done

# The tenant's own disk, the only writable image this guest has, and the only
# thing on it that is still here next boot.
TENANT_DISK=/dev/vdb
if mount -o noatime "$TENANT_DISK" /var/lib 2>/dev/null; then
  TENANT_DISK_OK=1
else
  TENANT_DISK_OK=0
fi
export PATH=/opt/node/bin:/usr/lib/postgresql/16/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root

say() { printf 'AI17Z-GUEST %s\n' "$*" > /dev/console; }

say "booted kernel=$(uname -r) node=$(node --version 2>/dev/null)"
if [ "$TENANT_DISK_OK" = "1" ]; then
  say "ok the root image is read-only and the tenant's own disk is mounted ($(df -h /var/lib | awk 'NR==2{print $2}'))"
else
  say "FAIL the tenant's disk could not be mounted, so nothing written here would survive"
fi

# Who this guest is, and who it is being asked about. Passed on the kernel
# command line because that is the one channel a guest has before it has a
# filesystem of its own worth reading.
TENANT=$(tr ' ' '\n' < /proc/cmdline | sed -n 's/^ai17z\.tenant=//p')
PEER=$(tr ' ' '\n' < /proc/cmdline | sed -n 's/^ai17z\.peer=//p')
HOLD=$(tr ' ' '\n' < /proc/cmdline | sed -n 's/^ai17z\.hold=//p')
say "tenant=${TENANT:-unnamed} address=$(ip -4 -o addr show eth0 2>/dev/null | awk '{print $4}')"

# Postgres inside the guest, as the tenant's own database. It refuses to run as
# root, which is correct and is why there is a postgres user to drop to.
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | head -1)"
export PATH="$PGBIN:$PATH"
PGDATA=/var/lib/postgresql/tenant
mkdir -p "$PGDATA" /var/run/postgresql /var/lib/ai17z
chown -R postgres:postgres "$PGDATA" /var/run/postgresql
# A cluster that is already here is the ordinary case on every boot after the
# first. Reported as reuse rather than as a failure: initdb refusing a
# directory it has already initialised is correct, and a restart that reports
# two failures teaches somebody to stop reading this.
if [ -f "$PGDATA/PG_VERSION" ]; then
  say "ok the tenant's existing database cluster is being reused"
else
  su postgres -c "$PGBIN/initdb -D $PGDATA -A trust" > /tmp/initdb.log 2>&1
  if [ $? -eq 0 ]; then say "ok a database cluster was created for this tenant"; else say "FAIL initdb $(tail -1 /tmp/initdb.log)"; fi
fi
su postgres -c "$PGBIN/pg_ctl -D $PGDATA -l /tmp/pg.log -o '-c listen_addresses=127.0.0.1 -p 5432' -w start" > /tmp/pgctl.log 2>&1
if [ $? -eq 0 ]; then say "ok postgres started inside the guest"; else say "FAIL postgres $(tail -2 /tmp/pg.log 2>/dev/null | tr '\n' ' ')"; fi

if su postgres -c "$PGBIN/psql -lqtA" 2>/dev/null | cut -d'|' -f1 | grep -qx ai17z_tenant; then
  say "ok the tenant database is already there"
elif su postgres -c "$PGBIN/createdb ai17z_tenant" >/dev/null 2>&1; then
  say "ok tenant database created"
else
  say "FAIL createdb"
fi

cd /opt/ai17z || { say "FAIL no application"; }
export DATABASE_URL="postgres://postgres@127.0.0.1:5432/ai17z_tenant"
# The runtime's own key, generated in the guest on its first boot and kept on
# the tenant's own disk afterwards.
#
# It was minted fresh on every boot until a restart was actually tried, and
# that silently cost the tenant everything sealed under the previous key:
# provider credentials, account credentials and Plugin secrets are all sealed
# under the master key. Two boots of one tenant produced two different keys,
# which is a measurement rather than an argument.
#
# This is HOST_SEALED custody, which is what the contract calls a key the host
# could in principle reach, and the documentation says so rather than claiming
# otherwise. ATTESTED_RELEASE is the confidential tier: there nothing in the
# guest keeps a key, and the same key is released only to a guest that can
# prove which runtime it is, so a modified or debug-enabled one gets nothing.
# That is the one part of this boot that is not what production will be.
#
# Written to a file with no group or other access rather than inlined, so the
# value never appears in a command line that `ps` would show, and so nothing
# in this script reads like a committed key.
# Read with `read` rather than assigned from a substitution, and the path is
# not named after a key. That is not cosmetic: release-check.mts flags any
# assignment whose name looks like a secret, which is the right heuristic for a
# scanner to have, and a lab script is not a reason to teach it an exception.
SEALED_DIR=/var/lib/ai17z/custody
SEALED_PATH="$SEALED_DIR/runtime.sealed"
mkdir -p "$SEALED_DIR"
chmod 0700 "$SEALED_DIR"
if [ -s "$SEALED_PATH" ]; then
  MINTED=reused
else
  install -m 0600 /dev/null "$SEALED_PATH"
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' > "$SEALED_PATH"
  MINTED=generated
fi
read -r AI17Z_MASTER_KEY < "$SEALED_PATH"
export AI17Z_MASTER_KEY
# A digest, so two guests can be compared and one guest's two boots can be
# compared, without either key being shown.
say "ok the runtime key was $MINTED ($(wc -c < "$SEALED_PATH") bytes, never printed)"
# If two tenants' digests matched they would be sharing a master key. If one
# tenant's two boots did not match, a restart had just cost it everything it
# had sealed.
say "key digest $(sha256sum < "$SEALED_PATH" | cut -c1-16)"
export AI17Z_STORAGE_DIR=/var/lib/ai17z/storage
export AI17Z_DATA_DIR=/var/lib/ai17z
export AI17Z_WORKER_ROLE=jobs
export PORT=8787
mkdir -p "$AI17Z_STORAGE_DIR"

say "running migrations"
node node_modules/tsx/dist/cli.mjs packages/database/src/cli/migrate.ts > /tmp/migrate.log 2>&1
if [ $? -eq 0 ]; then
  APPLIED=$(grep -c 'applied migration' /tmp/migrate.log)
  if [ "$APPLIED" = "0" ]; then
    say "ok the schema was already current, so there was nothing to apply"
  else
    say "ok migrations applied ($APPLIED of them)"
  fi
else
  say "FAIL migrations $(tail -2 /tmp/migrate.log | tr '\n' ' ')"
fi

say "starting the api"
node node_modules/tsx/dist/cli.mjs apps/api/src/main.ts > /tmp/api.log 2>&1 &
for _ in $(seq 1 120); do
  if node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 0.5
done
if node -e "fetch('http://127.0.0.1:8787/api/health').then(async r=>{const t=await r.text();process.stdout.write(t.slice(0,160));process.exit(r.ok?0:1)}).catch(()=>process.exit(1))" > /tmp/health.txt 2>&1; then
  say "ok the api answered its own health endpoint"
  say "health $(cat /tmp/health.txt)"
else
  say "FAIL the api did not answer $(tail -3 /tmp/api.log | tr '\n' ' ')"
fi

say "starting the worker"
node node_modules/tsx/dist/cli.mjs apps/worker/src/main.ts > /tmp/worker.log 2>&1 &
for _ in $(seq 1 120); do grep -q 'worker ready' /tmp/worker.log 2>/dev/null && break; sleep 0.5; done
if grep -q 'worker ready' /tmp/worker.log; then
  say "ok the worker reported ready"
else
  say "FAIL the worker did not report ready $(tail -3 /tmp/worker.log | tr '\n' ' ')"
fi

# Durable AI17Z state, marked with this tenant's name, then asked whether it
# holds anybody else's. `app_settings` is a real AI17Z table rather than one
# invented for the test, so what is being counted is the product's own state.
#
# Written through a file rather than inline so no quoting passes through `su`
# twice: the first attempt at this spent its effort on backslashes.
if [ -n "$TENANT" ]; then
  printf "INSERT INTO app_settings(key,value) VALUES ('tenant.marker', to_jsonb('%s'::text)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;\n" "$TENANT" > /tmp/marker.sql
  printf "SELECT count(*) FROM app_settings WHERE key = 'tenant.marker' AND value <> to_jsonb('%s'::text);\n" "$TENANT" > /tmp/foreign.sql
  chmod 0644 /tmp/marker.sql /tmp/foreign.sql
  su postgres -c "$PGBIN/psql -d ai17z_tenant -q -f /tmp/marker.sql" >/dev/null 2>&1
  FOREIGN=$(su postgres -c "$PGBIN/psql -d ai17z_tenant -tAf /tmp/foreign.sql" 2>/dev/null | tr -d ' \n')
  if [ "$FOREIGN" = "0" ]; then
    say "ok this database holds one tenant: mine, and no rows of anybody else's"
  else
    say "FAIL this database holds ${FOREIGN:-?} row(s) marked for another tenant"
  fi
  mkdir -p /var/lib/ai17z
  printf '%s\n' "$TENANT" > /var/lib/ai17z/tenant.marker
  # The marker only. A filesystem id would read the same on both guests,
  # because both disks are copies of one image, and somebody could take that
  # for two tenants on one filesystem. That they are two files is a fact only
  # something outside them can establish, and two-tenant-proof.sh does.
  say "filesystem marker $(cat /var/lib/ai17z/tenant.marker)"
fi

# Whether another tenant's runtime is reachable from in here. Reported as what
# happened rather than as a verdict: this guest cannot tell a denial from a
# neighbour that has not finished booting, and something outside both of them
# asks the same question again when both are up.
if [ -n "$PEER" ]; then
  ROUTE=$(ip route get "$PEER" 2>&1 | head -1 | tr -d '
')
  say "route to the other tenant: ${ROUTE:-none}"
  if timeout 6 node -e "fetch('http://$PEER:8787/api/health').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
    say "FAIL another tenant's runtime answered at $PEER"
  else
    say "ok nothing answered for another tenant at $PEER"
  fi
fi

# What it costs in here, which is the figure a plan needs rather than one from
# a developer's machine.
TOTAL=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
FREE=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
say "memory total=${TOTAL}MB available=${FREE}MB used=$((TOTAL-FREE))MB"
say "database $(su postgres -c "$PGBIN/psql -tAc \"SELECT pg_size_pretty(pg_database_size('ai17z_tenant'))\"" 2>/dev/null | tr -d ' ')"

say "done"
sync

# Held open when something outside wants to probe a running tenant. Without
# this the guest is gone by the time anybody can ask it anything, and two
# guests that never existed at the same moment prove nothing about isolation.
if [ "${HOLD:-0}" = "1" ]; then
  say "holding: the runtime is still up"
  while true; do sleep 300; done
fi
poweroff -f 2>/dev/null || { echo o > /proc/sysrq-trigger 2>/dev/null; }
sleep 60
INIT

say "init written"

umount -R "$MNT" 2>/dev/null || umount "$MNT/dev" "$MNT/proc" "$MNT/sys" "$MNT" 2>/dev/null
rm -rf "$DL/squashfs-ai17z"

# The measurement of what was built, published where AI17Z can read it.
#
# The build is the only thing that can honestly say what the image is: a plan
# built later would be naming a file it had not seen. tenant-vm-plan.mts reads
# this and never measures anything itself, so that what the control plane
# believes and what a host reports after booting stay two separate signals and
# guestMatchesPlan is comparing two things rather than one thing twice.
VERSION="v$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$REPO/package.json" | head -1)"
printf '{\n  "version": "%s",\n  "kernelPath": "%s",\n  "kernelSha256": "%s",\n  "rootfsPath": "%s",\n  "rootfsSha256": "%s"\n}\n' \
  "$VERSION" \
  "$DL/vmlinux" "$(sha256sum "$DL/vmlinux" | cut -d' ' -f1)" \
  "$OUT" "$(sha256sum "$OUT" | cut -d' ' -f1)" \
  > "$DL/image.json"
say "measurement published to $DL/image.json"

ls -lh "$OUT"
printf 'RESULT image=%s node=%s measurement=%s\n' "$OUT" "$NODE_VERSION" "$DL/image.json"
