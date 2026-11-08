"""Nothing secret anywhere in this repository's history.

Scans every blob reachable from any ref, every commit message and every tag
message, and prints locations and pattern names, never a matched value.

    python3 .forgejo/scripts/history-scan.py <repo> [extra-patterns.tsv]

`secret-scan.sh` asks the same question of the tree; this asks it of every
commit behind it, because removing a secret from the tree does not remove it
from history. The extra patterns file is for strings that must not be public
and must not be listed publicly either, such as a maintainer's own paths: the
release step passes one from outside the repository.

Synthetic fixtures that match are excused by blob id in
.forgejo/history-scan-allow.txt, which can only ever excuse those exact bytes.

The maintainer's private identifiers (tools/privateIdentifiers.ts describes the
format) come from, first that is set: the second argument, $PRIVATE_IDENTIFIERS
(the content itself, a CI secret), $PRIVATE_IDENTIFIERS_FILE, or
~/.config/private-identifiers/identifiers.txt with allow.txt beside it. They are
never excused by the fixture marker or a blob id, because a real identifier is
not a fixture; only an `allow` rule whose match on the same line covers the hit
excuses one. They are also checked against path names and against who wrote,
committed and tagged. None configured is said out loud; a broken list stops the
scan, because a scan that did not run proves nothing.
"""
import re
import subprocess
import sys

repo = sys.argv[1]
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
import os  # noqa: E402

private_dir = os.path.join(os.path.expanduser("~"), ".config", "private-identifiers")
private_text, private_source, allow_text = None, "none configured", None
if len(sys.argv) > 2:
    private_text, private_source = open(sys.argv[2], encoding="utf-8").read(), "from the file given"
elif os.environ.get("PRIVATE_IDENTIFIERS", "").strip():
    private_text, private_source = os.environ["PRIVATE_IDENTIFIERS"], "from $PRIVATE_IDENTIFIERS"
elif os.environ.get("PRIVATE_IDENTIFIERS_FILE"):
    private_text = open(os.environ["PRIVATE_IDENTIFIERS_FILE"], encoding="utf-8").read()
    private_source = "from $PRIVATE_IDENTIFIERS_FILE"
elif os.path.isfile(os.path.join(private_dir, "identifiers.txt")):
    private_text = open(os.path.join(private_dir, "identifiers.txt"), encoding="utf-8").read()
    private_source = "from ~/.config/private-identifiers"
    if os.path.isfile(os.path.join(private_dir, "allow.txt")):
        allow_text = open(os.path.join(private_dir, "allow.txt"), encoding="utf-8").read()

private, private_allow = [], []
try:
    for n, line in enumerate((private_text or "").splitlines(), 1):
        line = line.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" not in line:
            raise ValueError(f"line {n} is not <class><TAB><regex>")
        name, rx = line.split("\t", 1)
        (private_allow if name.strip() == "allow" else private).append((name.strip(), re.compile(rx.encode())))
    for line in (allow_text or "").splitlines():
        line = line.rstrip("\r")
        if line.strip() and not line.lstrip().startswith("#"):
            private_allow.append(("allow", re.compile(line.encode())))
except (ValueError, re.error) as e:
    # The reason, never the regex: this output is a CI log.
    reason = str(e) if isinstance(e, ValueError) else "a rule is not a valid regex"
    print(f"private identifiers: {reason}; refusing to report clean")
    sys.exit(2)
if private_text is not None and not private:
    print("private identifiers: the list has no rules; refusing to report clean")
    sys.exit(2)
private_allow = [rx for _, rx in private_allow]
compiled = [(n, re.compile(p.encode())) for n, p in patterns]


def private_hits(body):
    """Classes of private identifiers in body that no allow rule covers on the same line."""
    found = []
    for name, rx in private:
        for m in rx.finditer(body):
            if m.end() == m.start():
                continue
            ls = body.rfind(b"\n", 0, m.start()) + 1
            le = body.find(b"\n", m.end())
            line = body[ls:] if le < 0 else body[ls:le]
            s, e = m.start() - ls, m.end() - ls
            if any(a.start() <= s and a.end() >= e for rxa in private_allow for a in rxa.finditer(line)):
                continue
            found.append(name)
            break
    return found


FIXTURE = b"@release-check-fixtures"
allow = set()
allow_file = os.path.join(repo, ".forgejo", "history-scan-allow.txt")
if os.path.exists(allow_file):
    for line in open(allow_file, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#"):
            allow.add(line.split()[0].encode())


def git(*args, **kw):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, check=True, **kw).stdout


findings = []
paths = {}
for line in git("rev-list", "--all", "--objects").splitlines():
    parts = line.split(b" ", 1)
    if len(parts) == 2:
        # A path name is published as surely as the file behind it.
        for name in private_hits(parts[1]):
            findings.append(f"  {name} in a path name ({parts[0].decode()[:10]})")
        if parts[0] not in paths:
            paths[parts[0]] = parts[1].decode("utf-8", "replace")
ids = b"\n".join(paths.keys()) + b"\n"
proc = subprocess.Popen(["git", "-C", repo, "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)


def feed():
    # From a thread: written all at once before reading, git fills the output
    # pipe and both sides wait for ever.
    proc.stdin.write(ids)
    proc.stdin.close()


import threading  # noqa: E402

threading.Thread(target=feed, daemon=True).start()
out = proc.stdout
blobs = 0
while True:
    header = out.readline()
    if not header:
        break
    oid, kind, size = header.split()
    body = out.read(int(size))
    out.read(1)
    if kind != b"blob":
        continue
    blobs += 1
    # Before the fixture and blob-id excuses, which never apply to these.
    for name in private_hits(body):
        findings.append(f"  {name} in {paths.get(oid, '?')} ({oid.decode()[:10]})")
    if FIXTURE in body or oid in allow:
        continue
    for name, rx in compiled:
        if rx.search(body):
            findings.append(f"  {name} in {paths.get(oid, '?')} ({oid.decode()[:10]})")
proc.wait()

messages = git("log", "--all", "--format=%H%n%B%n%x00") + git("for-each-ref", "refs/tags", "--format=%(refname)%n%(contents)%n%00")
for chunk in messages.split(b"\x00"):
    head = chunk.strip().split(b"\n", 1)[0].decode("utf-8", "replace")
    for name, rx in compiled:
        if rx.search(chunk):
            findings.append(f"  {name} in message of {head[:40]}")
    for name in private_hits(chunk):
        findings.append(f"  {name} in message of {head[:40]}")

# Who wrote and committed each commit, and who tagged each tag, is published too.
people = git("log", "--all", "--format=%H%n%an <%ae>%n%cn <%ce>%n%x00") + git(
    "for-each-ref", "refs/tags", "--format=%(refname)%n%(taggername) %(taggeremail)%n%00"
)
for chunk in people.split(b"\x00"):
    head = chunk.strip().split(b"\n", 1)[0].decode("utf-8", "replace")
    for name in private_hits(chunk.strip().split(b"\n", 1)[-1]):
        findings.append(f"  {name} in the author or committer of {head[:40]}")

commits = len(git("rev-list", "--all").splitlines())
print(f"blobs scanned: {blobs}, commits: {commits}, patterns: {len(patterns)}")
if private:
    print(f"private identifiers: {len(private)} rules {private_source}")
else:
    print("private identifiers: SKIPPED, none configured (PRIVATE_IDENTIFIERS, PRIVATE_IDENTIFIERS_FILE or ~/.config/private-identifiers)")
for f in sorted(set(findings)):
    print(f)
print(f"findings: {len(set(findings))}")
sys.exit(1 if findings else 0)
