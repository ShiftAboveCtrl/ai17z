#!/usr/bin/env bash
#
# Everything an extracted macOS package has to be able to do.
#
#   prove-macos-package.sh <tarball> <version> <arch>
#
# Extracts into a path with a space in it -- the real one is "Application
# Support" -- and then runs what came out, on the Mac that built it.
#
# A script rather than a dozen `run:` blocks, for two reasons. A failure inside
# a composite action reaches anybody who cannot read Actions logs as "Process
# completed with exit code 1" and nothing else, and one script can be run under
# `say-on-fail.sh` so its output arrives as an annotation. And a script says in
# one place what "the package works" means, which is worth more than the same
# assertions spread across a YAML file.
set -uo pipefail

TARBALL="${1:?a tarball}"
VERSION="${2:?a version}"
ARCH="${3:?arm64 or x64}"

pass=0; fail=0
# What failed, repeated at the end.
#
# An annotation carries the last forty lines, and a failure forty lines up is a
# failure nobody reading the annotation can see. Keeping the labels and printing
# them last costs nothing and is the difference between a diagnosis and another
# round trip.
failures=""
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); failures="$failures
    $1"; }

ROOM="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/with space/room"
rm -rf "$ROOM"; mkdir -p "$ROOM"
tar -xzf "$TARBALL" -C "$ROOM" || { echo "  the package would not extract" >&2; exit 1; }
HERE="$ROOM/AI17Z"
NODE="$HERE/runtime/node/bin/node"
APP="$HERE/app"
TSX="$APP/node_modules/tsx/dist/cli.mjs"

echo "### what came out of the package"
for wanted in ai17z app runtime VERSION LICENSE; do
  if [ -e "$HERE/$wanted" ]; then ok "$wanted is there"; else bad "$wanted is missing"; fi
done
if [ -x "$HERE/ai17z" ]; then ok "the launcher is executable"; else bad "the launcher is not executable"; fi

echo
echo "### the bundled runtime"
if out="$("$NODE" --version 2>&1)"; then ok "node: $out"; else bad "node will not run: $out"; fi
if out="$("$NODE" -p 'process.arch' 2>&1)"; then
  if [ "$out" = "$ARCH" ]; then ok "node reports $out"; else bad "node reports $out, wanted $ARCH"; fi
else bad "node could not report its architecture"; fi
if out="$("$NODE" -p 'process.platform' 2>&1)"; then
  if [ "$out" = darwin ]; then ok "node is a darwin build"; else bad "node says $out"; fi
fi

echo
echo "### the binaries really are this architecture"
# `file` rather than the runtime's own opinion: a translated x86_64 binary
# reports whatever it is asked about while being the wrong package.
says="$(file -b "$NODE")"
case "$ARCH:$says" in
  arm64:*arm64*|x64:*x86_64*) ok "node is $ARCH -- $says" ;;
  *) bad "node is not $ARCH: $says" ;;
esac

ESBUILD="$(find "$APP/node_modules/@esbuild" -type f -name esbuild -perm -u+x 2>/dev/null | head -1)"
if [ -z "$ESBUILD" ]; then
  bad "no runnable esbuild binary in the package"
  find "$APP/node_modules/@esbuild" -type f -name esbuild 2>/dev/null | while IFS= read -r found; do
    printf '        present but %s: %s\n' "$(stat -f '%A' "$found")" "$found"
  done
else
  says="$(file -b "$ESBUILD")"
  case "$ARCH:$says" in
    arm64:*arm64*|x64:*x86_64*) ok "esbuild is $ARCH" ;;
    *) bad "esbuild is not $ARCH: $says" ;;
  esac
  if out="$("$ESBUILD" --version 2>&1)"; then ok "esbuild runs: $out"; else bad "esbuild will not run: $out"; fi
fi

echo
echo
echo "### the bundled npm can run a script"
# The thing that was missing, and that nothing here ever asked for.
#
# The build prunes node-gyp out of the runtime to save space, and npm resolves
# `node-gyp/bin/node-gyp.js` before running *any* lifecycle script --
# `make-spawn-args.js` does it unconditionally. So a package with no node-gyp
# has an npm that cannot run `npm run` at all, whether or not anything native is
# involved. A Mac found that on first launch:
#
#     Cannot find module 'node-gyp/bin/node-gyp.js'
#
# Every check here ran tsx, which is what the worker needs, and none of them ran
# npm, which is what first-run setup needs. So: a throwaway package, one trivial
# script, and the bundled npm asked to run it.
PROBE_DIR="$(mktemp -d)"
cat > "$PROBE_DIR/package.json" <<'PROBEJSON'
{ "name": "probe", "version": "1.0.0", "private": true,
  "scripts": { "probe": "node -e \"process.stdout.write(String(1+1))\"" } }
PROBEJSON
# `cd` into it rather than `npm --prefix`: --prefix moves where npm *installs*,
# not where it looks for the package.json a script lives in, and the first
# version of this check passed nothing and failed everything.
# With only the bundled runtime on PATH, which is what the launcher gives an
# installed copy. `npm` is a script starting `#!/usr/bin/env node`, so without
# this the runner's own Node interprets the bundled npm -- which still exercises
# the node-gyp resolution that broke, but is not the configuration anybody runs.
if OUT="$( cd "$PROBE_DIR" && PATH="$HERE/runtime/node/bin:$PATH" "$HERE/runtime/node/bin/npm" run --silent probe 2>&1 )" && [ "$OUT" = "2" ]; then
  ok "npm runs a script"
else
  bad "the bundled npm cannot run a script -- node-gyp pruned out of the runtime is what did this before: $(printf '%s' "$OUT" | grep -v '^[[:space:]]*$' | tail -3 | tr '\n' '/')"
fi
rm -rf "$PROBE_DIR"

echo
echo "### TypeScript transforms, which every npm script an installed copy runs needs"
if out="$("$NODE" "$TSX" -e 'const n: number = 1; console.log(`tsx ok ${n}`)' 2>&1)"; then
  ok "tsx: $out"
else
  bad "tsx will not run"
  printf '%s\n' "$out" | sed 's/^/        /' | head -12
fi

echo
echo "### every workspace package loads"
# Static imports, not `await import(...)`: top-level await needs an ES module,
# and `tsx -e` decides which it is from the source it is handed.
if out="$(cd "$APP" && "$NODE" "$TSX" -e '
  import "@xbam/shared";
  import "@xbam/database";
  import "@xbam/jobs";
  import "@xbam/runtime";
  import "@xbam/channels";
  import "@xbam/models";
  import "@xbam/memory";
  import "@xbam/prompts";
  import "@xbam/tools";
  import "@xbam/persona";
  console.log("all of them");
' 2>&1)"; then
  ok "workspace packages: $out"
else
  bad "a workspace package will not load"
  printf '%s\n' "$out" | sed 's/^/        /' | head -20
fi

echo
echo "### what this package says it is"
if out="$("$NODE" -p "require('$APP/BUILD_INFO.json').version" 2>&1)"; then
  if [ "$out" = "$VERSION" ]; then ok "BUILD_INFO says $out"; else bad "BUILD_INFO says $out, wanted $VERSION"; fi
else
  bad "BUILD_INFO could not be read: $out"
fi
if [ "$(cat "$HERE/VERSION" 2>/dev/null)" = "$VERSION" ]; then ok "VERSION agrees"; else bad "VERSION disagrees"; fi

echo
echo "### the launcher, from a path with a space in it"
if out="$("$HERE/ai17z" version 2>&1)"; then
  if [ "$out" = "$VERSION" ]; then ok "version: $out"; else bad "version says '$out'"; fi
else
  bad "the launcher would not run"
  printf '%s\n' "$out" | sed 's/^/        /' | head -12
fi
if out="$("$HERE/ai17z" node -p 'process.arch' 2>&1)"; then
  ok "the launcher's node: $out"
else
  bad "the launcher could not run its node"
  printf '%s\n' "$out" | sed 's/^/        /' | head -8
fi
if "$HERE/ai17z" wibble >/dev/null 2>&1; then
  bad "an unknown command was accepted"
else
  ok "an unknown command is refused"
fi

echo
echo "### app and data are separate, and the data is the owner's"
for dir in data logs browser-profiles; do
  if [ -d "$HERE/$dir" ]; then
    mode="$(stat -f '%A' "$HERE/$dir")"
    if [ "$mode" = 700 ]; then ok "$dir is 700"; else bad "$dir is $mode"; fi
  else
    bad "$dir was not created"
  fi
done
if [ -e "$APP/.env" ]; then bad "an .env was written into app/"; else ok "no .env inside app/"; fi
if [ -d "$APP/storage" ]; then bad "a storage directory is inside app/"; else ok "no storage inside app/"; fi

echo
echo "### doctor reports, from a packaged layout"
# Docker is not running on a hosted Mac, so this is expected to say so rather
# than to succeed. What is under test is that it produces a report at all.
"$HERE/ai17z" doctor > "$ROOM/doctor.txt" 2>&1 || true
sed 's/^/        /' "$ROOM/doctor.txt" | head -30
if grep -qi 'ai17z' "$ROOM/doctor.txt"; then ok "doctor produced a report"; else bad "doctor produced nothing recognisable"; fi

echo
echo "### the compatibility gate answers, both ways"
cat > "$ROOM/manifest.json" <<JSON
{"schemaVersion":1,"version":"9.9.9","tag":"v9.9.9",
 "commit":"0000000000000000000000000000000000000000",
 "builtAt":"2026-01-01T00:00:00.000Z",
 "signed":{"windows":false,"macos":false,"ubuntu":false},
 "minimumUpdaterSchema":1,"installLayoutSchema":3,
 "platforms":{"macos":{"supported":true,"architectures":["x64","arm64"],
   "methods":["MACOS_PKG"],
   "requirements":{"minimumDocker":"26.0.0","minimumChromeMajor":120,
     "bundledNode":"v22.23.2","os":{"minimumMajor":13}}}},
 "artifacts":[],"migrations":{"latest":"probe","count":0}}
JSON
ask() { (cd "$APP" && "$NODE" "$TSX" packaging/preflight.mts "$ROOM/manifest.json" macos "$ARCH" "$@" 2>&1); }

said="$(ask "$(sw_vers -productVersion)" 27.0.0 130)"
if [ "${said%%$'\n'*}" = OK ]; then ok "this Mac is accepted"; else bad "this Mac was refused: $said"; fi
said="$(ask 12.7 27.0.0 130)"
if [ "${said%%$'\n'*}" = NO ]; then ok "a Mac too old is refused"; else bad "an old macOS was accepted"; fi
said="$(ask "$(sw_vers -productVersion)" '' '')"
if [ "${said%%$'\n'*}" = NO ]; then ok "no Docker is refused"; else bad "no Docker was accepted"; fi
said="$(ask "$(sw_vers -productVersion)" 27.0.0 '')"
if [ "${said%%$'\n'*}" = OK ]; then ok "no Chrome is a note, not a refusal"; else bad "no Chrome was treated as a refusal"; fi

echo
echo "### what silence means depends on how old this installation is"
decide() { (cd "$APP" && "$NODE" "$TSX" packaging/preflight.mts --decide "$1" "$2" 2>&1); }
said="$(decide 2 no-manifest)"
if [ "${said%%$'\n'*}" = GO ]; then ok "an installation from before the gate carries on"; else bad "a legacy installation was refused: $said"; fi
said="$(decide 3 no-manifest)"
if [ "${said%%$'\n'*}" = NO ]; then ok "a current installation refuses"; else bad "a current installation carried on"; fi
said="$(decide 3 crashed)"
if [ "${said%%$'\n'*}" = NO ]; then ok "a crashed gate refuses"; else bad "a crashed gate carried on"; fi

echo
[ "$fail" -eq 0 ] || printf '\n  what failed:%b\n' "$failures"
echo "  package: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
