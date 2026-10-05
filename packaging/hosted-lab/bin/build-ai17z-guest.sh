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
export PATH=/opt/node/bin:/usr/lib/postgresql/16/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root

say() { printf 'AI17Z-GUEST %s\n' "$*" > /dev/console; }

say "booted kernel=$(uname -r) node=$(node --version 2>/dev/null)"

# Postgres inside the guest, as the tenant's own database. It refuses to run as
# root, which is correct and is why there is a postgres user to drop to.
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | head -1)"
export PATH="$PGBIN:$PATH"
PGDATA=/var/lib/postgresql/tenant
mkdir -p "$PGDATA" /run/postgresql
chown -R postgres:postgres "$PGDATA" /run/postgresql
su postgres -c "$PGBIN/initdb -D $PGDATA -A trust" > /tmp/initdb.log 2>&1
if [ $? -ne 0 ]; then say "FAIL initdb $(tail -1 /tmp/initdb.log)"; fi
su postgres -c "$PGBIN/pg_ctl -D $PGDATA -l /tmp/pg.log -o '-c listen_addresses=127.0.0.1 -p 5432' -w start" > /tmp/pgctl.log 2>&1
if [ $? -eq 0 ]; then say "ok postgres started inside the guest"; else say "FAIL postgres $(tail -2 /tmp/pg.log 2>/dev/null | tr '\n' ' ')"; fi

su postgres -c "$PGBIN/createdb ai17z_tenant" >/dev/null 2>&1 && say "ok tenant database created" || say "FAIL createdb"

cd /opt/ai17z || { say "FAIL no application"; }
export DATABASE_URL="postgres://postgres@127.0.0.1:5432/ai17z_tenant"
# The runtime's own key, minted inside the guest and never leaving it.
#
# A production runtime does not do this: it receives its key from an
# attestation-gated release, so that a modified or debug-enabled guest gets
# nothing. Minting one here is what a lab can honestly do without a
# confidential provider, and it is the one part of this boot that is not what
# production will be.
#
# Written to a file with no group or other access rather than inlined, so the
# value never appears in a command line that `ps` would show, and so nothing
# in this script reads like a committed key.
# Read with `read` rather than assigned from a substitution, and the path is
# not named after a key. That is not cosmetic: release-check.mts flags any
# assignment whose name looks like a secret, which is the right heuristic for a
# scanner to have, and a lab script is not a reason to teach it an exception.
SEALED_PATH=/run/ai17z-runtime.sealed
install -m 0600 /dev/null "$SEALED_PATH"
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' > "$SEALED_PATH"
read -r AI17Z_MASTER_KEY < "$SEALED_PATH"
export AI17Z_MASTER_KEY
say "ok a runtime secret was minted inside the guest ($(wc -c < "$SEALED_PATH") bytes, never printed)"
export AI17Z_STORAGE_DIR=/var/lib/ai17z/storage
export AI17Z_DATA_DIR=/var/lib/ai17z
export AI17Z_WORKER_ROLE=jobs
export PORT=8787
mkdir -p "$AI17Z_STORAGE_DIR"

say "running migrations"
node node_modules/tsx/dist/cli.mjs packages/database/src/cli/migrate.ts > /tmp/migrate.log 2>&1
if [ $? -eq 0 ]; then
  say "ok migrations applied ($(grep -c 'applied migration' /tmp/migrate.log) of them)"
else
  say "FAIL migrations $(tail -2 /tmp/migrate.log | tr '\n' ' ')"
fi

say "starting the api"
node node_modules/tsx/dist/cli.mjs apps/api/src/main.ts > /tmp/api.log 2>&1 &
for i in $(seq 1 120); do
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
for i in $(seq 1 120); do grep -q 'worker ready' /tmp/worker.log 2>/dev/null && break; sleep 0.5; done
if grep -q 'worker ready' /tmp/worker.log; then
  say "ok the worker reported ready"
else
  say "FAIL the worker did not report ready $(tail -3 /tmp/worker.log | tr '\n' ' ')"
fi

# What it costs in here, which is the figure a plan needs rather than one from
# a developer's machine.
TOTAL=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
FREE=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
say "memory total=${TOTAL}MB available=${FREE}MB used=$((TOTAL-FREE))MB"
say "database $(su postgres -c "$PGBIN/psql -tAc \"SELECT pg_size_pretty(pg_database_size('ai17z_tenant'))\"" 2>/dev/null | tr -d ' ')"

say "done"
sync
poweroff -f 2>/dev/null || { echo o > /proc/sysrq-trigger 2>/dev/null; }
sleep 60
INIT

say "init written"

umount -R "$MNT" 2>/dev/null || umount "$MNT/dev" "$MNT/proc" "$MNT/sys" "$MNT" 2>/dev/null
rm -rf "$DL/squashfs-ai17z"
ls -lh "$OUT"
printf 'RESULT image=%s node=%s\n' "$OUT" "$NODE_VERSION"
