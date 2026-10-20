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
if len(sys.argv) > 2:
    for line in open(sys.argv[2], encoding="utf-8"):
        line = line.rstrip("\n")
        if line and not line.startswith("#"):
            name, rx = line.split("\t", 1)
            patterns.append((name, rx))
compiled = [(n, re.compile(p.encode())) for n, p in patterns]
FIXTURE = b"@release-check-fixtures"
import os
allow = set()
allow_file = os.path.join(repo, ".forgejo", "history-scan-allow.txt")
if os.path.exists(allow_file):
    for line in open(allow_file, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#"):
            allow.add(line.split()[0].encode())


def git(*args, **kw):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, check=True, **kw).stdout


paths = {}
for line in git("rev-list", "--all", "--objects").splitlines():
    parts = line.split(b" ", 1)
    if len(parts) == 2 and parts[0] not in paths:
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
findings = []
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

commits = len(git("rev-list", "--all").splitlines())
print(f"blobs scanned: {blobs}, commits: {commits}, patterns: {len(patterns)}")
for f in sorted(set(findings)):
    print(f)
print(f"findings: {len(set(findings))}")
sys.exit(1 if findings else 0)
