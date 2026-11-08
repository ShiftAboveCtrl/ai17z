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
~/.config/private-identifiers/identifiers.txt with allow.txt and identity.txt
beside it. They are never excused by the fixture marker or a blob id, because a
real identifier is not a fixture; only an allow entry for that class whose match
on the same line covers the hit excuses one. They are also checked against path
names, tag names, and who wrote, committed and tagged, and a path or tag name
that carries one is printed as an object id instead. Binary blobs are read again
with their zero bytes removed, which is what text saved as UTF-16 looks like.

Wherever the list is configured, two policies run with it, because the list is
what marks a run as the maintainer's own release check (the publish step, or
the maintainer's machine) rather than a contributor's:

  ai-attribution     a Co-authored-by, Generated-by or similar trailer naming an
                     AI tool or a bot, or a tool's "Generated with" footer
  foreign-identity   an author, committer or tagger other than the `identity`
                     lines of the list (or identity.txt); skipped, and said so,
                     when the list names none

They are not run for everybody because the history a contributor clones may
predate the rewrite that enforces them, and a check that fails on every fork is
one that gets deleted. The maintainer's pre-push gate enforces both on every
push from the machine that publishes.

None configured is said out loud; a broken list stops the scan, because a scan
that did not run proves nothing.
"""
import bisect
import os
import re
import subprocess
import sys
import threading

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

# The same definition as the maintainer's pre-push gate: trailer-shaped lines
# and known footers only, never loose words, so prose that mentions an llm and
# a person whose name contains "bot" are both left alone.
TRAILER_KEYS = re.compile(
    rb"(?i)^[ \t]*(co-?authored-?by|co-?developed-?by|generated-?by|assisted-?by|"
    rb"written-?by|made-?with|signed-?off-?by)[ \t]*:[ \t]*(?P<value>[^\n]*)$"
)
AI_NAME = re.compile(
    rb"(?i)(?<![a-z0-9])(claude|anthropic|openai|codex|chatgpt|gpt-?[0-9][a-z0-9.]*|copilot|gemini|"
    rb"deepseek|t3 ?code|cursor ?agent|devin|aider|windsurf|codeium|tabnine|llm|bot|[a-z0-9-]+\[bot\])(?![a-z0-9])"
)
AI_EMAIL = re.compile(
    rb"(?i)(@anthropic\.com|@openai\.com|\[bot\]@|cursoragent@|@cursor\.(com|sh)|copilot@|"
    rb"t3code@|noreply@google\.com|@deepseek\.com)"
)
AI_FOOTER = re.compile(
    rb"(?im)^[^\n]*(\xf0\x9f\xa4\x96[^\n]*generated|generated (with|by) \[?(claude( code)?|codex|copilot|"
    rb"cursor|chatgpt|gemini|deepseek|aider|devin)(?![a-z0-9])|claude\.com/claude-code|claude\.ai/code|"
    rb"openai\.com/codex)[^\n]*$"
)


def is_attribution(msg):
    for line in msg.split(b"\n"):
        m = TRAILER_KEYS.match(line)
        if m:
            name, _, rest = m.group("value").partition(b"<")
            if AI_NAME.search(name) or AI_EMAIL.search(rest):
                return True
    return bool(AI_FOOTER.search(msg))


private_dir = os.path.join(os.path.expanduser("~"), ".config", "private-identifiers")
private_text, private_source, allow_text, identity_text = None, "none configured", None, None
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
    for name in ("allow.txt", "identity.txt"):
        path = os.path.join(private_dir, name)
        if os.path.isfile(path):
            if name == "allow.txt":
                allow_text = open(path, encoding="utf-8").read()
            else:
                identity_text = open(path, encoding="utf-8").read()

private, private_allow, identities = [], {}, []


def classes_of(text, n):
    classes = [c.strip() for c in text.split(",") if c.strip()]
    if not classes:
        raise ValueError(f"line {n}: an allow entry must name the classes it excuses")
    return classes


try:
    for n, line in enumerate((private_text or "").splitlines(), 1):
        line = line.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" not in line:
            raise ValueError(f"line {n} is not <class><TAB><regex>")
        name, value = line.split("\t", 1)
        name = name.strip()
        if name == "identity":
            identities.append(value.strip().encode())
        elif name == "allow" or name.startswith("allow:"):
            rx = re.compile(value.encode())
            for c in classes_of(name[6:], n):
                private_allow.setdefault(c, []).append(rx)
        else:
            private.append((name, re.compile(value.encode())))
    for n, line in enumerate((allow_text or "").splitlines(), 1):
        line = line.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" not in line:
            raise ValueError(f"allow list line {n} is not <class><TAB><regex>")
        classes, value = line.split("\t", 1)
        rx = re.compile(value.encode())
        for c in classes_of(classes, n):
            private_allow.setdefault(c, []).append(rx)
    identities += [l.strip().encode() for l in (identity_text or "").splitlines() if l.strip() and not l.lstrip().startswith("#")]
except (ValueError, re.error) as e:
    # The reason, never the regex: this output is a CI log.
    reason = str(e) if isinstance(e, ValueError) else "a rule is not a valid regex"
    print(f"private identifiers: {reason}; refusing to report clean")
    sys.exit(2)
if private_text is not None and not private:
    print("private identifiers: the list has no rules; refusing to report clean")
    sys.exit(2)
compiled = [(n, re.compile(p.encode())) for n, p in patterns]


def private_hits(body):
    """Classes of private identifiers in body that no allow entry for the class covers on the same line.

    Linear: newline positions are found once and searched by bisect, and each
    line's allow spans once per class, so a long line with many excused hits
    costs what reading it costs.
    """
    found = []
    newlines = None
    for name, rx in private:
        spans = {}
        for m in rx.finditer(body):
            s, e = m.start(), m.end()
            if e == s:
                continue
            if name in private_allow:
                if newlines is None:
                    newlines = [x.start() for x in re.finditer(b"\n", body)]
                li = bisect.bisect_left(newlines, s)
                ls = newlines[li - 1] + 1 if li > 0 else 0
                le = newlines[li] if li < len(newlines) else len(body)
                if ls not in spans:
                    line = body[ls:le]
                    starts, ends, best = [], [], -1
                    for a, b in sorted((a.start(), a.end()) for rxa in private_allow[name] for a in rxa.finditer(line)):
                        best = max(best, b)
                        starts.append(a)
                        ends.append(best)
                    spans[ls] = (starts, ends)
                starts, ends = spans[ls]
                i = bisect.bisect_right(starts, s - ls) - 1
                if i >= 0 and ends[i] >= e - ls:
                    continue
            found.append(name)
            break
    return found


def private_hits_any_view(body):
    """private_hits, and again with zero bytes removed for a binary blob."""
    found = private_hits(body)
    if private and b"\x00" in body[:8192]:
        found += [n for n in private_hits(body.replace(b"\x00", b"")) if n not in found]
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
        oid = parts[0]
        # A path name is published as surely as the file behind it, and a path
        # that carries an identifier is never printed: its object id is.
        hits = private_hits(parts[1])
        for name in hits:
            findings.append(f"  {name} in a path name ({oid.decode()[:10]})")
        if oid not in paths:
            paths[oid] = f"object {oid.decode()[:10]}" if hits else parts[1].decode("utf-8", "replace")
        elif hits and not paths[oid].startswith("object "):
            paths[oid] = f"object {oid.decode()[:10]}"
ids = b"\n".join(paths.keys()) + b"\n"
proc = subprocess.Popen(["git", "-C", repo, "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)


def feed():
    # From a thread: written all at once before reading, git fills the output
    # pipe and both sides wait for ever.
    proc.stdin.write(ids)
    proc.stdin.close()


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
    where = paths.get(oid, "?")
    # Before the fixture and blob-id excuses, which never apply to these.
    for name in private_hits_any_view(body):
        findings.append(f"  {name} in {where} ({oid.decode()[:10]})")
    if FIXTURE in body or oid in allow:
        continue
    for name, rx in compiled:
        if rx.search(body):
            findings.append(f"  {name} in {where} ({oid.decode()[:10]})")
proc.wait()


def ref_label(head, n):
    """A tag's ref name, unless the name itself is private."""
    hits = private_hits(head.encode("utf-8", "replace"))
    for name in hits:
        findings.append(f"  {name} in a tag name (tag #{n})")
    return f"tag #{n}" if hits else head[:40]


policy = bool(private)
policy_notes = []
if policy and not identities:
    policy_notes.append("foreign-identity: SKIPPED, the list names no identity")

messages = git("log", "--all", "--format=%H%n%B%n%x00") + git("for-each-ref", "refs/tags", "--format=%(refname)%n%(contents)%n%00")
for n, chunk in enumerate(messages.split(b"\x00"), 1):
    head = chunk.strip().split(b"\n", 1)[0].decode("utf-8", "replace")
    if head.startswith("refs/"):
        head = ref_label(head, n)
    for name, rx in compiled:
        if rx.search(chunk):
            findings.append(f"  {name} in message of {head[:40]}")
    for name in private_hits(chunk):
        findings.append(f"  {name} in message of {head[:40]}")
    if policy and chunk.strip() and is_attribution(chunk):
        findings.append(f"  ai-attribution in message of {head[:40]}")

# Who wrote and committed each commit, and who tagged each tag, is published too.
people = git("log", "--all", "--format=%H%n%an <%ae>%n%cn <%ce>%n%x00") + git(
    "for-each-ref", "refs/tags", "--format=%(refname)%n%(taggername) %(taggeremail)%n%00"
)
for n, chunk in enumerate(people.split(b"\x00"), 1):
    lines = chunk.strip().split(b"\n")
    if not lines or not lines[0]:
        continue
    head = lines[0].decode("utf-8", "replace")
    if head.startswith("refs/"):
        head = ref_label(head, n)
    for name in private_hits(b"\n".join(lines[1:])):
        findings.append(f"  {name} in the author or committer of {head[:40]}")
    if policy and identities:
        for person in lines[1:]:
            person = person.strip()
            if person and person != b"<>" and person not in identities:
                findings.append(f"  foreign-identity in the author, committer or tagger of {head[:40]}")
                break

commits = len(git("rev-list", "--all").splitlines())
print(f"blobs scanned: {blobs}, commits: {commits}, patterns: {len(patterns)}")
if private:
    print(f"private identifiers: {len(private)} rules {private_source}; policy: ai-attribution"
          + (", foreign-identity" if identities else ""))
    for note in policy_notes:
        print(f"  {note}")
else:
    print("private identifiers: SKIPPED, none configured (PRIVATE_IDENTIFIERS, PRIVATE_IDENTIFIERS_FILE or ~/.config/private-identifiers)")
for f in sorted(set(findings)):
    print(f)
print(f"findings: {len(set(findings))}")
sys.exit(1 if findings else 0)
