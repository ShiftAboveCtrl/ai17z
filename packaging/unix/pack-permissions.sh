#!/usr/bin/env bash
#
# What a file in a package is allowed to do, decided by what it is.
#
# Sourced by both Unix build scripts. A build host cannot be trusted for this:
# everything on a Windows filesystem reads as executable, so a package built
# from a mounted checkout ships an executable LICENSE and an executable PNG.
# The answer is not to trust the host, and it is also not to guess -- it is to
# look at each file.
#
# The rule that was missing, and that cost a package where nothing could run:
#
#   A native binary is executable because it is a binary, not because it has a
#   shebang. `grep -I` skips binary files by design, so a rule written as "give
#   anything with a #! line the executable bit" silently leaves every compiled
#   executable at 0644 -- including `@esbuild/<platform>/bin/esbuild`, which is
#   what every `tsx` process an installed copy runs shells out to. The package
#   installs, and then the migration on first start dies with EACCES on a file
#   that is right there.
#
# So: directories traversable, regular files plain data, then the executable bit
# restored to the things that are actually programs.

# Is this file a compiled executable?
#
# By its first four bytes rather than by `file`, which is not installed
# everywhere a build runs, and not by extension, which native binaries do not
# have. ELF for Linux; the Mach-O forms and the universal-binary wrapper for
# macOS.
ai17z_is_native_executable() { # path
  magic="$(od -An -tx1 -N4 "$1" 2>/dev/null | tr -d ' \n')"
  case "$magic" in
    7f454c46)                     return 0 ;;  # ELF
    cffaedfe|cefaedfe)            return 0 ;;  # Mach-O 64/32, little-endian
    feedfacf|feedface)            return 0 ;;  # Mach-O 64/32, big-endian
    cafebabe|bebafeca)            return 0 ;;  # universal binary
    *)                            return 1 ;;
  esac
}

# Set every mode under a directory from what each file is.
ai17z_fix_permissions() { # root
  root="$1"

  find "$root" -type d -exec chmod 0755 {} +
  find "$root" -type f -exec chmod 0644 {} +

  # Named for what they are.
  find "$root" -type f \( -name '*.sh' -o -name 'ai17z' \) -exec chmod 0755 {} +

  # Meant to be run, whatever they are called. `grep -I` skips binaries, which
  # is why the next rule exists rather than this one covering everything.
  grep -rlI --include='*' -m1 '^#!' "$root" 2>/dev/null | while IFS= read -r script; do
    chmod 0755 "$script"
  done

  # Programs. The rule that was missing.
  find "$root" -type f -size +0 -print | while IFS= read -r candidate; do
    if ai17z_is_native_executable "$candidate"; then chmod 0755 "$candidate"; fi
  done

  # Except the ones that are data despite starting with a shebang.
  find "$root" -type f \( -name '*.md' -o -name '*.json' -o -name '*.png' \
    -o -name '*.ttf' -o -name '*.otf' -o -name 'LICENSE' \) -exec chmod 0644 {} +
}

# Every program in a tree can actually be run.
#
# Asserted rather than assumed, in the build that produced the tree, because the
# failure it catches is invisible until somebody's first start: a file listing
# shows the binary present and correct, and only its mode says otherwise.
ai17z_assert_executables_runnable() { # root
  local missing=0 candidate
  # Process substitution rather than a pipeline: a `while` on the right of a
  # pipe runs in a subshell, and a count incremented there is a count the
  # caller never sees. That is the shape of a check that always passes.
  while IFS= read -r candidate; do
    if ai17z_is_native_executable "$candidate" && [ ! -x "$candidate" ]; then
      printf '  not executable: %s\n' "$candidate" >&2
      missing=$((missing + 1))
    fi
  done < <(find "$1" -type f -size +0 -print)

  if [ "$missing" -gt 0 ]; then
    printf '  %s native executable(s) in the package cannot be run.\n' "$missing" >&2
    printf '  Every tsx process an installed copy runs shells out to one of these.\n' >&2
    return 1
  fi
  printf '  every native executable in the package can be run\n'
  return 0
}
