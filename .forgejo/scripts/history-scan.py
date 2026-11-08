"""Nothing secret anywhere in this repository's history.

Scans every blob reachable from any ref, every commit message and every tag
message, and prints locations and pattern names, never a matched value.

    python3 .forgejo/scripts/history-scan.py [--ci] <repo> [extra-patterns.tsv]

--ci is the release check: the list is $PRIVATE_IDENTIFIERS and nothing else
(no file, no default directory, no allow file, no environment budget), and no
list is a refusal rather than a skip.

`secret-scan.sh` asks the same question of the tree; this asks it of every
commit behind it, because removing a secret from the tree does not remove it
from history. The extra patterns file is for strings that must not be public
and must not be listed publicly either, such as a maintainer's own paths: the
release step passes one from outside the repository.

Synthetic fixtures that match are excused by blob id in
.forgejo/history-scan-allow.txt, which can only ever excuse those exact bytes.

The maintainer's private identifiers are checked by privacy_scan.py beside this
file, which is the same scanner as the maintainer's pre-push gate, so the two
cannot disagree about what was checked. The list (tools/privateIdentifiers.ts
describes the format) comes from, first that is set: the second argument,
$PRIVATE_IDENTIFIERS (the content itself, a CI secret),
$PRIVATE_IDENTIFIERS_FILE, or ~/.config/private-identifiers/identifiers.txt with
allow.txt and identity.txt beside it. With a list, the whole history is read
the way the gate reads a push: every blob, archives unpacked with their
metadata (nested, against a size budget, too deep refused), every entry name of
every tree (so a rename is seen), commit and tag text including merged tags,
and who wrote, committed and tagged. Nothing is excused by the fixture marker or
a blob id, because a real identifier is not a fixture. A path, tree entry or tag
name that carries one is printed as an object id instead.

Wherever the list is configured, two policies run with it, because the list is
what marks a run as the maintainer's own release check (the publish step, or
the maintainer's machine) rather than a contributor's:

  ai-attribution     a Co-authored-by, Helped-by or similar trailer naming an AI
                     tool or a bot, or a tool's "Generated with" footer
  foreign-identity   an author, committer or tagger other than the `identity`
                     lines of the list (or identity.txt); skipped, and said so,
                     when the list names none

They are not run for everybody because the history a contributor clones may
predate the rewrite that enforces them, and a check that fails on every fork is
one that gets deleted. The maintainer's pre-push gate enforces both on every
push from the machine that publishes.

None configured is said out loud. A broken list, or git failing to hand over
every object, stops the scan with exit 2: a scan that did not run proves nothing.
"""
import importlib.util
import os
import re
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
patterns = [
    ("openai-key", r"sk-[A-Za-z0-9]{32,}"),
    ("anthropic-key", r"sk-ant-[A-Za-z0-9_-]{20,}"),
    ("github-token", r"gh[pousr]_[A-Za-z0-9]{30,}"),
    ("gitlab-token", r"glpat-[A-Za-z0-9_-]{20,}"),
    ("aws-key", r"AKIA[0-9A-Z]{16}"),
    ("private-key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("x-session", r"auth_token[\" ]*[:=][\" ]*[a-f0-9]{30,}"),
    ("telegram-bot", r"\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}"),
    ("private-plugin", "AI17Z-PRIVATE" + "-PLUGIN"),
]
compiled = [(n, re.compile(p.encode())) for n, p in patterns]
FIXTURE = b"@release-check-fixtures"


class Stop(Exception):
    """The scan could not run; exit 2."""


def load_privacy_scan():
    # By path, not import: `python3 -I` does not put this directory on sys.path.
    # No __pycache__ beside it: a stray directory in .forgejo/scripts is
    # something every workflow test then has to explain.
    sys.dont_write_bytecode = True
    spec =importlib.util.spec_from_file_location("privacy_scan", os.path.join(HERE, "privacy_scan.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(repo, *args):
    p = subprocess.run(["git", "-C", repo, *args], capture_output=True)
    if p.returncode != 0:
        raise Stop(f"git {args[0]} failed (exit {p.returncode})")
    return p.stdout


def builtin_scan(repo, findings, safe):
    """The secret shapes above, over every blob and message, as before.

    safe(path, oid) is how a path is printed: as itself, or as an object id when
    the maintainer's list says the path carries an identifier.
    """
    allow = set()
    allow_file = os.path.join(repo, ".forgejo", "history-scan-allow.txt")
    if os.path.exists(allow_file):
        for line in open(allow_file, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#"):
                allow.add(line.split()[0].encode())
    paths = {}
    for line in git(repo, "rev-list", "--all", "--objects").splitlines():
        parts = line.split(b" ", 1)
        if len(parts) == 2 and parts[0] not in paths:
            paths[parts[0]] = safe(parts[1], parts[0])
    if not paths:
        return 0
    ids = b"\n".join(paths.keys()) + b"\n"
    proc = subprocess.Popen(["git", "-C", repo, "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def feed():
        # From a thread: written all at once before reading, git fills the output
        # pipe and both sides wait for ever.
        proc.stdin.write(ids)
        proc.stdin.close()

    threading.Thread(target=feed, daemon=True).start()
    out = proc.stdout
    blobs = seen = 0
    while True:
        header = out.readline()
        if not header:
            break
        parts = header.split()
        if len(parts) != 3:
            raise Stop("git cat-file reported a missing object")
        oid, kind, size = parts
        body = out.read(int(size))
        out.read(1)
        seen += 1
        if kind != b"blob":
            continue
        blobs += 1
        if FIXTURE in body or oid in allow:
            continue
        for name, rx in compiled:
            if rx.search(body):
                findings.append(f"  {name} in {paths.get(oid, '?')} ({oid.decode()[:10]})")
    # Every object accounted for, and git itself content: anything less is a
    # scan that stopped early and would otherwise read as clean.
    if proc.wait() != 0 or seen != len(paths):
        raise Stop("git cat-file did not hand over every object")
    # A tag is named by its object id here, never by its name: a tag name is
    # chosen by whoever made it and can be exactly what must not be printed.
    messages = git(repo, "log", "--all", "--format=%H%n%B%n%x00") + git(
        repo, "for-each-ref", "refs/tags", "--format=tag %(objectname)%n%(contents)%n%00"
    )
    for chunk in messages.split(b"\x00"):
        head = chunk.strip().split(b"\n", 1)[0].decode("utf-8", "replace")
        for name, rx in compiled:
            if rx.search(chunk):
                findings.append(f"  {name} in message of {head[:40]}")
    return blobs


def load_list(ci, extra):
    """(scanner module, Scanner, status line), or (module, None, SKIPPED line) when no list is configured."""
    ps = load_privacy_scan()
    ps.CI_MODE = ci
    opts = {"patterns": extra} if extra else {}
    if ci:
        # The release check: $PRIVATE_IDENTIFIERS and nothing else, and no list
        # is a refusal, not a skip.
        source = "from $PRIVATE_IDENTIFIERS only (--ci)"
        try:
            rules, allow, identities = ps.resolve({})
        except ps.ScanError as e:
            raise Stop(f"private identifiers: {e}")
        status = f"private identifiers: {len(rules)} rules {source}; policy: ai-attribution"
        status += ", foreign-identity" if identities else "\n  foreign-identity: SKIPPED, the list names no identity"
        return ps, ps.Scanner(rules, allow, identities, {"identifiers", "policy"}), status
    if extra:
        source = "from the file given"
    elif os.environ.get("PRIVATE_IDENTIFIERS", "").strip():
        source = "from $PRIVATE_IDENTIFIERS"
    elif os.environ.get("PRIVATE_IDENTIFIERS_FILE"):
        source = "from $PRIVATE_IDENTIFIERS_FILE"
    else:
        source = "from ~/.config/private-identifiers"
    try:
        rules, allow, identities = ps.resolve(opts)
    except ps.ScanError as e:
        if "no identifiers list found" in str(e):
            return ps, None, "private identifiers: SKIPPED, none configured (PRIVATE_IDENTIFIERS, PRIVATE_IDENTIFIERS_FILE or ~/.config/private-identifiers)"
        raise Stop(f"private identifiers: {e}")
    status = f"private identifiers: {len(rules)} rules {source}; policy: ai-attribution"
    status += ", foreign-identity" if identities else "\n  foreign-identity: SKIPPED, the list names no identity"
    return ps, ps.Scanner(rules, allow, identities, {"identifiers", "policy"}), status


def private_scan(ps, sc, repo, findings):
    """The maintainer's list, through the gate's own scanner."""
    try:
        ps.scan_objects(sc, repo, ["--all"])
        # Every ref name is published with the repository.
        for i, ref in enumerate(git(repo, "for-each-ref", "--format=%(refname)").splitlines(), 1):
            sc.names(ref, f"ref #{i}")
    except ps.ScanError as e:
        raise Stop(f"private identifiers: {e}")
    findings.extend(f"  {f}" for f in sorted(sc.findings))


def main():
    args = sys.argv[1:]
    ci = bool(args) and args[0] == "--ci"
    if ci:
        args = args[1:]
        if len(args) != 1:
            raise Stop("--ci takes the repository and nothing else")
    if not args:
        raise Stop("usage: history-scan.py [--ci] <repo> [extra-patterns.tsv]")
    repo = args[0]
    # Objects as they are stored and sent, never as a replacement shows them.
    os.environ["GIT_NO_REPLACE_OBJECTS"] = "1"
    os.environ.pop("GIT_REPLACE_REF_BASE", None)
    os.environ.pop("GIT_GRAFT_FILE", None)
    findings = []
    ps, sc, status = load_list(ci, args[1] if len(args) > 1 else None)

    def safe(path, oid):
        if sc is None:
            return path.decode("utf-8", "replace")
        return sc.label_for(path, f"object {oid.decode()[:10]}")

    blobs = builtin_scan(repo, findings, safe)
    if sc is not None:
        private_scan(ps, sc, repo, findings)
    commits = len(git(repo, "rev-list", "--all").splitlines())
    print(f"blobs scanned: {blobs}, commits: {commits}, patterns: {len(patterns)}")
    print(status)
    for f in sorted(set(findings)):
        print(f)
    print(f"findings: {len(set(findings))}")
    return 1 if findings else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Stop as e:
        print(f"{e}; refusing to report clean")
        sys.exit(2)
    except Exception as e:  # anything unexpected is a scan that did not run, never a pass
        print(f"history scan failed ({e.__class__.__name__}); refusing to report clean")
        sys.exit(2)
