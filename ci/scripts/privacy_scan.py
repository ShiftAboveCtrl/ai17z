"""privacy-scan core. Run through scripts/privacy-scan (bash) or privacy-scan.ps1.

Finds personal identifiers, AI attribution and foreign commit identities before
they leave this PC. Prints where and the rule CLASS only, never the pattern and
never the matched text, so its own output can be pasted anywhere. A path, tree
entry, ref or archive member whose name itself contains an identifier is never
printed either: it is replaced by an object id, "file #n", "ref #n" or "#n".

Modes
  range   <repo> <rev-list args...>   new objects only: blobs (archives
                                      unpacked), every entry name of every new
                                      tree, symlink targets, commit and tag text
                                      (mergetag included), author/committer/tagger
  history <repo>                      everything reachable from every ref
  tree    <repo> [rev]                files tracked at rev (default HEAD)
  path    <file|dir|archive>...       files on disk, symlinks not followed
                                      (their targets are scanned)
  strip-msg <file>                    remove AI attribution trailers and footers
                                      from a commit message in place
  export-secret                       identifiers + allow + identity as one
                                      value on stdout, for a CI secret

Archives are recognised by their bytes, not their names: zip (also docx, xlsx,
jar, vsix, apk), gzip, bzip2, xz, zstd, tar and ar (.deb), nested up to 4 deep;
deeper is a finding (archive-too-deep), never a pass. Their metadata is read
too (tar uname, gname, pax headers and link targets, zip comments and extra
fields, ar names), and so are the raw container bytes, which is where data
after a tar's end blocks or a gzip's original name sits. Decompression is
streamed against one budget (2 GiB, or less via PRIVACY_SCAN_MAX_UNPACKED), so
a bomb is refused as archive-too-large rather than inflated.

Options (before the mode)
  --checks identifiers,policy   identifiers = the private list; policy = AI
                                attribution and the one allowed commit identity
  --patterns FILE  --allow FILE  --identity FILE
  --ref NAME                    (repeatable) a ref name being published
  --lenient DIR=CLASS[,CLASS]   (repeatable) under a path segment DIR (e.g.
                                node_modules), do not apply those classes;
                                for third-party trees and generic rules only
  --ci                          the list is $PRIVATE_IDENTIFIERS and nothing
                                else: every other variable, file and default
                                directory is ignored (release checks)
  --prove-npm LOCKFILE          a hit inside a file whose bytes are identical to
                                the same path in an npm tarball whose sha512
                                LOCKFILE (package-lock.json, v2 or v3) records
                                is listed as exempt instead of refusing
  --prove-node RUNTIME_JSON     the same for a file under runtime/node/, against
                                the official Node.js tarball for the version
                                RUNTIME_JSON pins, checked against nodejs.org's
                                SHASUMS256.txt
  --proof-cache DIR             where verified tarballs are kept between runs;
                                a cached file counts only if its hash matches
  --node-dist DIR               (not with --ci) read SHASUMS256.txt and Node
                                tarballs from DIR instead of nodejs.org

Proven upstream bytes. An exemption needs the exact bytes: a file one byte
different from upstream, a file at a path upstream does not have, a file whose
path itself carries an identifier, and every file outside node_modules and
runtime/node still refuses. Only identifier classes are exempted, never a
finding that says the scan could not read something, and every exemption is
printed with the package, version and proof. Inside an archive the proven
member's bytes are also left out of the archive's own raw pass; every other
byte of the archive is still read there.

Refused outright as unusual shapes, never read and judged: a commit or tag
header git does not write itself (unusual-header), a message encoding other
than UTF-8 (non-utf8-encoding). Every git call runs with replacement objects
off (GIT_NO_REPLACE_OBJECTS=1, GIT_REPLACE_REF_BASE and GIT_GRAFT_FILE unset).
Every text is read twice: as it is, and after NFKC with invisible characters
removed. Encodings of an identifier (base64, hex, split across lines) are out
of scope.

List format (identifiers.txt):  <class><TAB><regex>
  allow:<class>[,<class>...]<TAB><regex>   excuse hits of those classes only
  identity<TAB>Name <email>                the allowed commit identity
For merges made on github.com, two more are accepted and nothing else: the
committer GitHub writes at its noreply address, and an author with an allowed
identity's email under another display name (never one naming a tool or bot).
A tagger must match an identity line exactly.
allow.txt: <class>[,<class>...]<TAB><regex>. An allow match excuses a hit only
when it covers the hit on the same line.

Pattern source, first that exists: --patterns, $PRIVATE_IDENTIFIERS (content),
$PRIVATE_IDENTIFIERS_FILE, ~/.config/private-identifiers/identifiers.txt,
<this script>/../ai/private/identifiers.txt. The pre-push gate passes its own
files and clears those variables. Missing patterns is an error, not a pass.

Exit: 0 clean, 1 findings, 2 the scan itself could not run (callers must treat
2 as a refusal: a scan that did not run proves nothing).
"""
import base64
import bisect
import bz2
import hashlib
import io
import json
import lzma
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
PRIVATE_DIRS = [
    os.path.join(os.path.expanduser("~"), ".config", "private-identifiers"),
    os.path.normpath(os.path.join(HERE, "..", "ai", "private")),
]
MAX_PER_CLASS_PER_FILE = 5
MAX_ARCHIVE_DEPTH = 4
CHUNK = 1024 * 1024


# --ci: the list comes from $PRIVATE_IDENTIFIERS and nothing else. No file, no
# default directory (in a repository the script-relative one is a path any pull
# request could add), no allow file and no budget from the environment.
CI_MODE = False


def git_env():
    """The environment every git call runs in.

    Replacement refs change what a reader sees and not what a push sends, so a
    replaced commit read the replacement while the original went out. They are
    switched off, along with the variable that moves where they are looked for.
    """
    env = dict(os.environ, GIT_NO_REPLACE_OBJECTS="1")
    env.pop("GIT_REPLACE_REF_BASE", None)
    env.pop("GIT_GRAFT_FILE", None)
    return env


# Characters that render as nothing (zero-width, joiners, bidi controls, soft
# hyphen, variation selectors). Removed, after NFKC folds fullwidth and other
# compatibility forms, for a second read of every text.
_INVISIBLE_RANGES = [
    (0x00AD, 0x00AD), (0x034F, 0x034F), (0x061C, 0x061C), (0x115F, 0x1160), (0x17B4, 0x17B5),
    (0x180B, 0x180F), (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x2064), (0x2066, 0x206F),
    (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0),
]
# Built from code points so this file stays ASCII and nothing in it is invisible.
INVISIBLE = re.compile("[" + "".join(re.escape(chr(a)) + "-" + re.escape(chr(b)) for a, b in _INVISIBLE_RANGES) + "]")


def normalised(body):
    """body as NFKC with invisible characters removed, or None if that changes nothing."""
    import unicodedata
    text = body.decode("utf-8", "ignore")
    folded = INVISIBLE.sub("", unicodedata.normalize("NFKC", text)).encode("utf-8")
    return None if folded == body else folded


def max_unpacked():
    """2 GiB, or a smaller budget from the environment (a larger one is ignored)."""
    default = 2 * 1024 * 1024 * 1024
    if CI_MODE:
        return default
    try:
        asked = int(os.environ.get("PRIVACY_SCAN_MAX_UNPACKED", "") or default)
    except ValueError:
        asked = default
    return max(0, min(default, asked))


# One definition of "AI attribution", used by the gate and by strip-msg.
#
# Only trailer-shaped lines ("Key: value") and known tool footers. A whole-line
# match on loose words erased ordinary prose ("output generated by the llm
# router") and refused people whose names merely contain one ("Talbot").
TRAILER_KEYS = re.compile(
    rb"(?i)^[ \t]*(co-?authored-?by|co-?developed-?by|generated-?by|assisted-?by|helped-?by|"
    rb"suggested-?by|reviewed-?by|written-?by|made-?with|signed-?off-?by)[ \t]*:[ \t]*(?P<value>[^\n]*)$"
)
# Names that are only ever a tool or a bot.
AI_NAME = re.compile(
    rb"(?i)(?<![a-z0-9])(claude|anthropic|openai|codex|chatgpt|gpt-?[0-9][a-z0-9.]*|copilot|"
    rb"deepseek|t3 ?code|cursor ?agent|windsurf|codeium|tabnine|llm|bot|[a-z0-9-]+\[bot\])(?![a-z0-9])"
)
# Names that are also people's names: AI only with a tool's or a bot's address.
AI_NAME_WEAK = re.compile(rb"(?i)(?<![a-z0-9])(devin|gemini|aider|cursor)(?![a-z0-9])")
AI_EMAIL = re.compile(
    rb"(?i)(@anthropic\.com|@openai\.com|\[bot\]@|cursoragent@|@cursor\.(com|sh)|copilot@|"
    rb"t3code@|noreply@google\.com|@deepseek\.com|@aider\.chat|@cognition)"
)
BOT_EMAIL = re.compile(rb"(?i)(no-?reply|\bbot\b|-bot@|bot@|\[bot\])")
AI_FOOTER = re.compile(
    rb"(?im)^[^\n]*(\xf0\x9f\xa4\x96[^\n]*generated|generated (with|by) \[?(claude( code)?|codex|copilot|"
    rb"cursor|chatgpt|gemini|deepseek|aider|devin)(?![a-z0-9])|claude\.com/claude-code|claude\.ai/code|"
    rb"openai\.com/codex)[^\n]*$"
)


# The committer GitHub writes on a merge made on github.com: a squash, a rebase
# or "update branch". The owner merges there (decided 2026-11-09), so this one
# committer is accepted. It vouches for nothing else: the author of the same
# commit is judged on its own, so a bot's pull request squashed by GitHub is
# still refused for its author.
# Assembled, so the release check does not read it as somebody's address.
GITHUB_MERGE_COMMITTER = b"GitHub <" + b"@".join([b"noreply", b"github.com"]) + b">"


def email_of(ident):
    """The address inside "Name <address>", or None when there is none."""
    name, sep, rest = ident.rpartition(b"<")
    if not sep or not rest.endswith(b">") or len(rest) < 3:
        return None
    return rest[:-1]


def is_ai_trailer_value(value):
    name, _, rest = value.partition(b"<")
    local = rest.split(b"@", 1)[0]
    # The address's local part counts as a name: "<claude@...>" with no name.
    if AI_NAME.search(name) or AI_NAME.search(local) or AI_EMAIL.search(rest):
        return True
    return bool(AI_NAME_WEAK.search(name + b" " + local) and BOT_EMAIL.search(rest))


def attribution_lines(msg):
    """Spans (start, end) of every line in msg that is AI attribution.

    A trailer folds: a line starting with whitespace continues the one above,
    exactly as `git interpret-trailers` reads it, so the key and the name may sit
    on different lines. The whole folded trailer is one span.
    """
    spans = []
    lines = msg.split(b"\n")
    starts, pos = [], 0
    for line in lines:
        starts.append(pos)
        pos += len(line) + 1
    i = 0
    while i < len(lines):
        m = TRAILER_KEYS.match(lines[i])
        if not m:
            i += 1
            continue
        j = i + 1
        value = m.group("value")
        while j < len(lines) and lines[j][:1] in (b" ", b"\t") and lines[j].strip():
            value += b" " + lines[j].strip()
            j += 1
        if is_ai_trailer_value(value):
            spans.append((starts[i], starts[j - 1] + len(lines[j - 1])))
        i = j
    for m in AI_FOOTER.finditer(msg):
        spans.append((m.start(), m.end()))
    return sorted(set(spans))


def git_trailer_attribution(msg):
    """True if `git interpret-trailers --parse` finds an AI trailer in msg.

    The second opinion, from git itself, over whatever it counts as a trailer
    block (folding, separators, case). Only asked when the message could hold a
    folded line, because it costs a process per commit.
    """
    if not re.search(rb"(?m)^[ \t]+\S", msg):
        return False
    p = subprocess.run(["git", "interpret-trailers", "--parse"], input=msg, capture_output=True, env=git_env())
    if p.returncode != 0:
        raise ScanError("git interpret-trailers failed")
    for line in p.stdout.split(b"\n"):
        m = TRAILER_KEYS.match(line)
        if m and is_ai_trailer_value(m.group("value")):
            return True
    return False


class ScanError(Exception):
    pass


def first_existing(*candidates):
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def compile_rx(rx, where):
    try:
        return re.compile(rx.encode())
    except re.error:
        # Never the regex itself: the message may land in a public log.
        raise ScanError(f"{where}: not a valid regex")


def parse_list(text, source):
    """identifiers.txt grammar: rules, scoped allow lines and identity lines."""
    rules, allow, identities = [], [], []
    for n, line in enumerate(text.splitlines(), 1):
        line = line.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" not in line:
            raise ScanError(f"{source} line {n}: expected <class><TAB><regex>")
        name, value = line.split("\t", 1)
        name = name.strip()
        if name == "identity":
            identities.append(value.strip().encode())
        elif name == "allow" or name.startswith("allow:"):
            classes = set(c.strip() for c in name[6:].split(",") if c.strip())
            if not classes:
                raise ScanError(f"{source} line {n}: an allow line must name the classes it excuses (allow:<class>)")
            allow.append((classes, compile_rx(value, f"{source} line {n}")))
        else:
            rules.append((name, compile_rx(value, f"{source} line {n}")))
    return rules, allow, identities


def parse_allow_file(text, source):
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        line = line.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" not in line:
            raise ScanError(f"{source} line {n}: expected <class>[,<class>]<TAB><regex>")
        classes, rx = line.split("\t", 1)
        classes = set(c.strip() for c in classes.split(",") if c.strip())
        if not classes:
            raise ScanError(f"{source} line {n}: no class named")
        out.append((classes, compile_rx(rx, f"{source} line {n}")))
    return out


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def resolve(opts):
    if CI_MODE:
        # Only the secret: no file, no default directory, no allow file.
        text = os.environ.get("PRIVATE_IDENTIFIERS", "")
        if not text.strip():
            raise ScanError("no identifiers list found: --ci reads $PRIVATE_IDENTIFIERS and nothing else")
        rules, allow, identities = parse_list(text, "$PRIVATE_IDENTIFIERS")
        if not rules:
            raise ScanError("$PRIVATE_IDENTIFIERS: no identifier rules")
        return rules, allow, identities
    pfile = opts.get("patterns")
    if pfile:
        if not os.path.isfile(pfile):
            raise ScanError("patterns file not found")
        text, label = read(pfile), "patterns"
    elif os.environ.get("PRIVATE_IDENTIFIERS", "").strip():
        text, label = os.environ["PRIVATE_IDENTIFIERS"], "$PRIVATE_IDENTIFIERS"
    else:
        pfile = first_existing(os.environ.get("PRIVATE_IDENTIFIERS_FILE"),
                               *[os.path.join(d, "identifiers.txt") for d in PRIVATE_DIRS])
        if not pfile:
            raise ScanError("no identifiers list found (see --help); refusing to report clean")
        text, label = read(pfile), "identifiers"
    rules, allow, identities = parse_list(text, label)
    if not rules:
        raise ScanError(f"{label}: no identifier rules")
    afile = opts.get("allow") or first_existing(os.environ.get("PRIVATE_IDENTIFIERS_ALLOW_FILE"),
                                               *[os.path.join(d, "allow.txt") for d in PRIVATE_DIRS])
    if afile:
        allow += parse_allow_file(read(afile), "allow list")
    ifile = opts.get("identity") or (None if identities else
                                     first_existing(*[os.path.join(d, "identity.txt") for d in PRIVATE_DIRS]))
    if ifile:
        identities += [line.strip().encode() for line in read(ifile).splitlines()
                       if line.strip() and not line.lstrip().startswith("#")]
    return rules, allow, identities


def segments(label):
    return set(re.split(r"[/\\!]", label))


# ---- proven upstream bytes ---------------------------------------------------
#
# Third-party files carry other people's hostnames, addresses and names: a
# server's example config, a test fixture, a wordlist, the Node binary itself.
# They are excused one way only: by proving the exact bytes came from upstream,
# never by where they sit. A file under node_modules is proven when it is
# identical to the same path inside the registry tarball whose sha512
# package-lock.json records; a file under runtime/node is proven when it is
# identical to the same path inside the official Node.js tarball whose sha256
# nodejs.org's SHASUMS256.txt publishes. Editing such a file changes its bytes,
# and then it is ours and is judged like everything else.

# Classes that say the scan could not finish reading something. Never exempted,
# whatever the bytes: a proof is about content, and these are not findings
# about content.
UNREAD_CLASSES = {"archive-too-large", "archive-too-deep", "unreadable-archive"}
NPM_HOSTS = {"registry.npmjs.org"}
NODE_HOSTS = {"nodejs.org"}
MAX_UPSTREAM = 512 * 1024 * 1024


class ProofUnavailable(Exception):
    """A proof could not be made. The finding stands, with this as the reason."""


def fetch(url, hosts):
    """GET over https from one of hosts, refusing a redirect anywhere else."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in hosts:
        raise ProofUnavailable("its source is not an allowed https host")
    request = urllib.request.Request(url, headers={"User-Agent": "ai17z-release-scan"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            final = urllib.parse.urlsplit(response.geturl())
            if final.scheme != "https" or final.hostname not in hosts:
                raise ProofUnavailable("its source redirected to a host that is not allowed")
            body = response.read(MAX_UPSTREAM + 1)
    except (OSError, urllib.error.URLError, ValueError) as e:
        raise ProofUnavailable(f"could not download it ({e.__class__.__name__})")
    if len(body) > MAX_UPSTREAM:
        raise ProofUnavailable("its upstream archive is too large to check")
    return body


def tar_digests(body):
    """{path below the top directory: sha256 hex} for every regular file in a tarball.

    Both npm and Node put everything under one top directory (package/,
    node-vX-platform/), so that first component is dropped. A later entry for
    the same path wins, as it does when the tarball is unpacked.
    """
    out = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(body), mode="r:*") as t:
            for m in t:
                if not m.isfile():
                    continue
                parts = m.name.replace("\\", "/").lstrip("/").split("/", 1)
                if len(parts) != 2 or not parts[1]:
                    continue
                f = t.extractfile(m)
                out[parts[1]] = hashlib.sha256(f.read() if f else b"").hexdigest()
    except (tarfile.TarError, OSError, EOFError, lzma.LZMAError, zlib.error) as e:
        raise ProofUnavailable(f"its upstream archive could not be read ({e.__class__.__name__})")
    return out


class NpmProof:
    """Files identical to the same path in a tarball package-lock.json pins by sha512."""

    def __init__(self, lockfile, cache):
        try:
            with open(lockfile, encoding="utf-8") as f:
                lock = json.load(f)
        except (OSError, ValueError):
            raise ScanError("--prove-npm: the lockfile could not be read")
        if not isinstance(lock, dict) or lock.get("lockfileVersion", 0) < 2 or not isinstance(lock.get("packages"), dict):
            raise ScanError("--prove-npm: needs a package-lock.json with lockfileVersion 2 or 3")
        self.packages = lock["packages"]
        self.cache = cache
        self.digests = {}

    def locate(self, segs):
        """(lockfile key, path inside the package) for the package a file belongs to, or None.

        The earliest place a lockfile key starts, then the deepest key from
        there, so apps/api/node_modules/x is not mistaken for node_modules/x and
        a/node_modules/b is not mistaken for a.
        """
        for i in range(len(segs)):
            for j in range(len(segs) - 1, i, -1):
                key = "/".join(segs[i:j])
                if "node_modules" in segs[i:j] and key in self.packages:
                    return key, "/".join(segs[j:])
        return None

    def tarball(self, entry):
        integrity = entry.get("integrity") or ""
        wanted = []
        for item in integrity.split():
            if item.startswith("sha512-"):
                try:
                    wanted.append(base64.b64decode(item[7:], validate=True))
                except ValueError:
                    pass  # a malformed hash proves nothing; the others may still
        if not wanted:
            raise ProofUnavailable("package-lock.json records no sha512 for it")
        cached = os.path.join(self.cache, f"npm-{wanted[0].hex()}.tgz") if self.cache else None
        if cached and os.path.isfile(cached):
            with open(cached, "rb") as f:
                body = f.read()
            if hashlib.sha512(body).digest() in wanted:
                return body
        resolved = entry.get("resolved") or ""
        body = fetch(resolved, NPM_HOSTS)
        if hashlib.sha512(body).digest() not in wanted:
            raise ProofUnavailable("the registry tarball does not match the sha512 package-lock.json records")
        if cached:
            os.makedirs(self.cache, exist_ok=True)
            with open(cached, "wb") as f:
                f.write(body)
        return body

    def prove(self, segs, digest, data):
        found = self.locate(segs)
        if not found:
            return None
        key, rel = found
        entry = self.packages[key]
        name = entry.get("name") or key.rsplit("node_modules/", 1)[-1]
        version = entry.get("version") or "?"
        if entry.get("link") or not entry.get("resolved") or not entry.get("integrity"):
            raise ProofUnavailable(f"{name} is not a registry package with a recorded integrity")
        if key not in self.digests:
            try:
                self.digests[key] = tar_digests(self.tarball(entry))
            except ProofUnavailable as e:
                self.digests[key] = e
        held = self.digests[key]
        if isinstance(held, ProofUnavailable):
            raise held
        if rel not in held:
            raise ProofUnavailable(f"{name}@{version} has no file at that path")
        if held[rel] != digest:
            raise ProofUnavailable(f"differs from {name}@{version}")
        return f"{name}@{version}, identical to {rel} in its registry tarball, whose sha512 package-lock.json records"


class NodeProof:
    """Files under runtime/node/ identical to the official tarball for the pinned version."""

    PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"]

    def __init__(self, runtime_json, cache, dist):
        try:
            with open(runtime_json, encoding="utf-8") as f:
                version = json.load(f).get("version", "")
        except (OSError, ValueError, AttributeError):
            raise ScanError("--prove-node: the runtime pin could not be read")
        if not re.fullmatch(r"v\d+\.\d+\.\d+", version or ""):
            raise ScanError("--prove-node: the runtime pin names no version")
        self.version = version
        self.cache = cache
        self.dist = dist
        self.sums = None
        self.digests = {}

    def get(self, name, hosts=NODE_HOSTS):
        if self.dist:
            path = os.path.join(self.dist, name)
            if not os.path.isfile(path):
                raise ProofUnavailable(f"{name} is not in the local Node distribution")
            with open(path, "rb") as f:
                return f.read()
        return fetch(f"https://nodejs.org/dist/{self.version}/{name}", hosts)

    def checksums(self):
        # Never from the cache: this is what every other check here rests on.
        if self.sums is None:
            sums = {}
            for line in self.get("SHASUMS256.txt").decode("utf-8", "replace").splitlines():
                parts = line.split()
                if len(parts) == 2 and re.fullmatch(r"[0-9a-f]{64}", parts[0]):
                    sums[parts[1]] = parts[0]
            self.sums = sums
        return self.sums

    def index(self, platform):
        if platform in self.digests:
            held = self.digests[platform]
            if isinstance(held, ProofUnavailable):
                raise held
            return held
        try:
            sums = self.checksums()
            name = next((n for n in (f"node-{self.version}-{platform}.tar.xz", f"node-{self.version}-{platform}.tar.gz")
                         if n in sums), None)
            if not name:
                raise ProofUnavailable(f"nodejs.org publishes no {platform} tarball for {self.version}")
            cached = os.path.join(self.cache, f"node-{sums[name]}") if self.cache else None
            body = None
            if cached and os.path.isfile(cached):
                with open(cached, "rb") as f:
                    body = f.read()
                if hashlib.sha256(body).hexdigest() != sums[name]:
                    body = None
            if body is None:
                body = self.get(name)
                if hashlib.sha256(body).hexdigest() != sums[name]:
                    raise ProofUnavailable(f"{name} does not match SHASUMS256.txt")
                if cached:
                    os.makedirs(self.cache, exist_ok=True)
                    with open(cached, "wb") as f:
                        f.write(body)
            self.digests[platform] = (name, tar_digests(body))
        except ProofUnavailable as e:
            self.digests[platform] = e
            raise
        return self.digests[platform]

    @staticmethod
    def sniff(data):
        """The platform an executable was built for, from its header, or None."""
        if data[:4] == b"\x7fELF" and len(data) > 20:
            return {0x3E: "linux-x64", 0xB7: "linux-arm64"}.get(int.from_bytes(data[18:20], "little"))
        if data[:4] == b"\xcf\xfa\xed\xfe" and len(data) > 8:
            return {0x01000007: "darwin-x64", 0x0100000C: "darwin-arm64"}.get(int.from_bytes(data[4:8], "little"))
        return None

    def prove(self, segs, digest, data):
        at = next((i for i in range(len(segs) - 2) if segs[i] == "runtime" and segs[i + 1] == "node"), None)
        if at is None:
            return None
        rel = "/".join(segs[at + 2:])
        first = self.sniff(data)
        order = ([first] if first else []) + [p for p in self.PLATFORMS if p in self.digests and p != first] \
            + [p for p in self.PLATFORMS if p not in self.digests and p != first]
        reasons = []
        for platform in order:
            try:
                name, held = self.index(platform)
            except ProofUnavailable as e:
                reasons.append(str(e))
                continue
            if held.get(rel) == digest:
                return (f"Node.js {self.version} {platform}, identical to {rel} in {name}, "
                        "whose sha256 nodejs.org's SHASUMS256.txt publishes")
            if first:
                # An executable is proved against its own platform or not at all.
                break
        raise ProofUnavailable(reasons[0] if reasons else f"differs from every Node.js {self.version} tarball tried")


class Provenance:
    """Asks each proof in turn whether a blob's exact bytes came from upstream."""

    def __init__(self, npm=None, node=None):
        self.provers = [p for p in (node, npm) if p]
        self.unproven = set()

    def prove(self, label, data):
        path = label.rsplit("!", 1)[-1].replace("\\", "/")
        while path.startswith("./"):
            path = path[2:]
        segs = [s for s in path.split("/") if s]
        digest = hashlib.sha256(data).hexdigest()
        reasons = []
        for prover in self.provers:
            try:
                proof = prover.prove(segs, digest, data)
            except ProofUnavailable as e:
                reasons.append(str(e))
                continue
            if proof:
                return proof
        if reasons:
            self.unproven.add(f"{label}: {reasons[0]}")
        return None


class Scanner:
    def __init__(self, rules, allow, identities, checks, lenient=None, provenance=None):
        self.provenance = provenance
        # (finding, proof) for every hit excused because its bytes are upstream's.
        self.exempted = set()
        # Findings in the order they were made, so a blob can tell which are its own.
        self.log = []
        self.rules = rules
        self.allow = {}
        for classes, rx in allow:
            for c in classes:
                self.allow.setdefault(c, []).append(rx)
        self.identities = identities
        self.identity_emails = {e for e in (email_of(i) for i in identities) if e}
        self.checks = checks
        self.lenient = lenient or {}
        self.skip = set()
        self.findings = set()
        self.items = 0
        self.unpacked = 0
        self.budget = max_unpacked()

    def add(self, where, cls):
        finding = f"{where}: {cls}"
        if finding not in self.findings:
            self.findings.add(finding)
            self.log.append(finding)

    def find(self, body, limit=MAX_PER_CLASS_PER_FILE):
        """[(class, line number)] of hits no allow rule covers, in linear time.

        Newline positions are found once and searched with bisect, and each
        line's allow spans are computed once per class and searched the same
        way, so a long line with many hits costs what reading it costs.
        """
        out = []
        newlines = None
        spans = {}
        for cls, rx in self.rules:
            if cls in self.skip:
                continue
            seen = set()
            for m in rx.finditer(body):
                s, e = m.start(), m.end()
                if e == s:
                    continue
                if newlines is None:
                    newlines = [x.start() for x in re.finditer(b"\n", body)]
                li = bisect.bisect_left(newlines, s)
                ls = newlines[li - 1] + 1 if li > 0 else 0
                le = newlines[li] if li < len(newlines) else len(body)
                if self.allow.get(cls):
                    key = (cls, ls)
                    if key not in spans:
                        line = body[ls:le]
                        found = sorted((a.start(), a.end()) for rxa in self.allow[cls] for a in rxa.finditer(line))
                        starts, ends, best = [], [], -1
                        for a, b in found:
                            best = max(best, b)
                            starts.append(a)
                            ends.append(best)
                        spans[key] = (starts, ends)
                    starts, ends = spans[key]
                    i = bisect.bisect_right(starts, s - ls) - 1
                    if i >= 0 and ends[i] >= e - ls:
                        continue
                if li + 1 in seen:
                    continue
                if len(seen) >= limit:
                    out.append((cls, None))
                    break
                seen.add(li + 1)
                out.append((cls, li + 1))
        return out

    def names(self, raw, label):
        """A name that is published (a ref, a tree entry): record each class it carries under label."""
        if "identifiers" not in self.checks:
            return False
        if isinstance(raw, str):
            raw = raw.encode("utf-8", "surrogateescape")
        hits = self.find(raw)
        folded = normalised(raw)
        if folded is not None:
            hits += self.find(folded)
        for cls, _ in hits:
            self.add(label, cls)
        return bool(hits)

    def label_for(self, name, fallback):
        """name if it carries no identifier; otherwise record that and return fallback."""
        if "identifiers" not in self.checks:
            return fallback
        raw = name.encode("utf-8", "surrogateescape") if isinstance(name, str) else name
        if self.names(raw, f"{fallback} (its path)"):
            return fallback
        return raw.decode("utf-8", "replace")

    def member(self, parent, name, i):
        """Label for member i of an archive: parent!name, or parent!#i if name is private."""
        fallback = f"{parent}!#{i}"
        safe = self.label_for(name, fallback)
        return fallback if safe == fallback else f"{parent}!{safe}"

    def set_skip(self, label):
        self.skip = set()
        segs = segments(label)
        for d, classes in self.lenient.items():
            if d in segs:
                self.skip |= classes

    def text(self, label, body, line_numbers=True):
        """Identifier rules over one piece of text. label must already be safe to print."""
        if "identifiers" not in self.checks:
            return
        self.items += 1
        views = [body]
        if body[:2] in (b"\xff\xfe", b"\xfe\xff"):
            try:
                views = [body.decode("utf-16").encode("utf-8")]
            except UnicodeDecodeError:
                pass
        # Anywhere in the blob, not only the first 8 KB: a text header in front
        # of UTF-16 or binary data used to hide everything behind it.
        binary = b"\x00" in body
        if binary:
            # UTF-16 without a BOM, and strings inside a binary, read as text
            # once the zero bytes between their characters are gone.
            views.append(body.replace(b"\x00", b""))
        # Every view again after NFKC with invisible characters removed, so a
        # fullwidth or zero-width-split identifier reads as itself. The whole
        # blob, not a prefix.
        views += [f for f in (normalised(v) for v in list(views)) if f is not None]
        for view in views:
            for cls, ln in self.find(view):
                if binary or not line_numbers:
                    self.add(f"{label}{' (binary)' if binary else ''}", cls)
                elif ln is None:
                    self.add(f"{label}: more lines", cls)
                else:
                    self.add(f"{label}:{ln}", cls)

    # The headers git itself writes. Anything else is refused rather than read:
    # the gate cannot promise to understand a shape it has not seen.
    COMMIT_HEADERS = {b"tree", b"parent", b"author", b"committer", b"gpgsig", b"gpgsig-sha256", b"mergetag", b"encoding"}
    TAG_HEADERS = {b"object", b"type", b"tag", b"tagger", b"gpgsig", b"gpgsig-sha256"}

    def identity_allowed(self, role, ident):
        """Whether one author, committer or tagger is the maintainer's.

        An exact identity line always is. Beyond that, exactly two widenings,
        both for merges made on github.com: GitHub's own committer, and an
        author carrying an allowed identity's address under another display
        name, because GitHub writes the account's profile name rather than
        the one git was configured with. A tagger gets neither, and a name
        that is a tool or a bot is refused whatever address it carries.
        """
        if ident in self.identities:
            return True
        if role == b"committer":
            return ident == GITHUB_MERGE_COMMITTER
        if role == b"author":
            return email_of(ident) in self.identity_emails and not is_ai_trailer_value(ident)
        return False

    def git_object(self, kind, oid, raw, label):
        """A commit or tag: shape, identity, attribution, and identifiers in every byte."""
        head, _, msg = raw.partition(b"\n\n")
        fields = []
        for line in head.split(b"\n"):
            if line.startswith(b" ") and fields:
                fields[-1] = (fields[-1][0], fields[-1][1] + b"\n" + line[1:])
            else:
                key, _, value = line.partition(b" ")
                fields.append((key, value))
        allowed = self.COMMIT_HEADERS if kind == b"commit" else self.TAG_HEADERS
        # Shape first, whatever the checks: an unusual object is refused outright.
        if any(k not in allowed for k, _ in fields):
            self.add(f"{label}", "unusual-header")
        for k, v in fields:
            # A message in another encoding (IBM037, UTF-16) reads as noise here
            # and as words to anybody whose git decodes it.
            if k == b"encoding" and v.strip().lower() not in (b"utf-8", b"utf8"):
                self.add(f"{label}", "non-utf8-encoding")
        people = [(k, v) for k, v in fields if k in (b"author", b"committer", b"tagger")]
        if "policy" in self.checks:
            for role, rest in people:
                ident = rest.rsplit(b" ", 2)[0] if rest.count(b" ") >= 2 else rest
                if self.identities and not self.identity_allowed(role, ident.strip()):
                    self.add(f"{label} {role.decode()}", "foreign-identity")
            if attribution_lines(msg) or git_trailer_attribution(msg):
                self.add(f"{label} message", "ai-attribution")
        if "identifiers" in self.checks:
            # Every byte of the object as it is sent: header keys and values,
            # gpgsig and mergetag blocks, and a signature inside the message.
            # Nothing is stripped first, because a signature block is exactly
            # where a stripped region could hide a name.
            self.text(f"{label} raw", raw, line_numbers=False)
            self.text(f"{label} people", b"\n".join(k + b" " + v for k, v in people), line_numbers=False)
            self.text(f"{label} message", msg)
            for k, v in fields:
                if k == b"tag":
                    # A tag's own name is published with it.
                    self.names(v, f"{label} name")
        # A merged signed tag travels inside the commit, tagger and message
        # included, and is judged exactly like a tag.
        for i, (k, v) in enumerate((f for f in fields if f[0] == b"mergetag"), 1):
            self.git_object(b"tag", oid, v, f"{label} mergetag #{i}")

    # ---- archives -------------------------------------------------------

    def charge(self, n, label):
        self.unpacked += n
        if self.unpacked > self.budget:
            self.add(label, "archive-too-large")
            return False
        return True

    def inflate(self, kind, data, label):
        """Decompress a gzip/bz2/xz/zstd stream without ever holding more than the budget."""
        room = self.budget - self.unpacked
        if kind == "zstd":
            return self.inflate_zstd(data, label, room)
        make = {
            "gzip": lambda: zlib.decompressobj(16 + zlib.MAX_WBITS),
            "bz2": bz2.BZ2Decompressor,
            "xz": lzma.LZMADecompressor,
        }[kind]
        out, total = [], 0
        d, buf = make(), data
        while True:
            want = min(CHUNK, room - total + 1)
            if kind == "gzip":
                chunk = d.decompress(buf, want)
                buf = d.unconsumed_tail
            else:
                chunk = d.decompress(buf, max_length=want)
                buf = b""
            total += len(chunk)
            if total > room:
                self.add(label, "archive-too-large")
                return None
            out.append(chunk)
            if d.eof:
                rest = d.unused_data
                if rest.strip(b"\0"):
                    # Another member (concatenated gzip, multi-stream xz).
                    d, buf = make(), rest
                    continue
                break
            if not chunk:
                more = buf if kind == "gzip" else (not d.needs_input)
                if not more:
                    raise ValueError("truncated stream")
        self.unpacked += total
        return b"".join(out)

    def inflate_zstd(self, data, label, room):
        try:
            from compression import zstd as _z  # Python 3.14+
            stream = _z.ZstdFile(io.BytesIO(data))
        except ImportError:
            try:
                import zstandard  # type: ignore
                stream = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(data))
            except ImportError:
                stream = None
        if stream is None:
            exe = shutil.which("zstd")
            if not exe:
                raise NotImplementedError("no zstd decoder")
            proc = subprocess.Popen([exe, "-dcq"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

            def feed():
                try:
                    proc.stdin.write(data)
                except OSError:
                    pass  # stopped reading on purpose: the budget ran out
                finally:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass  # already closed by the kill below

            threading.Thread(target=feed, daemon=True).start()
            stream = proc.stdout
        else:
            proc = None
        out, total = [], 0
        while True:
            chunk = stream.read(CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > room:
                if proc:
                    proc.kill()
                self.add(label, "archive-too-large")
                return None
            out.append(chunk)
        if proc and proc.wait() != 0:
            raise ValueError("zstd failed")
        self.unpacked += total
        return b"".join(out)

    def blob(self, label, data, depth=0):
        """Text, or an archive by its bytes, unpacked and scanned member by member.

        Returns True when this blob's identifier hits were exempted because its
        exact bytes are proven upstream (see Provenance), so a containing
        archive can leave those same bytes out of its own raw pass.
        """
        mark = len(self.log)
        self.scan_blob(label, data, depth)
        if not self.provenance:
            return False
        mine = [f for f in self.log[mark:] if f in self.findings and f.rsplit(": ", 1)[1] not in UNREAD_CLASSES]
        if not mine:
            return False
        proof = self.provenance.prove(label, data)
        if not proof:
            return False
        for f in mine:
            self.findings.discard(f)
            self.exempted.add((f, proof))
        return True

    def raw(self, label, data, proven):
        """The container's own bytes: tar headers (uname, gname, pax), data after
        a tar's end blocks, zip comments, a gzip's original name, ar headers.
        Members stored uncompressed show up here too, whatever directory they
        sit in, so the lenient (generic) classes are not applied to this pass.

        proven: (start, end) spans of member bytes proven upstream. Those bytes
        are replaced with newlines for this pass, and only those: every header,
        every unproven member and anything between them is read as it is.
        """
        if proven:
            masked = bytearray(data)
            for start, end in proven:
                masked[start:end] = b"\n" * (end - start)
            data = bytes(masked)
        held = self.skip
        self.skip = held | set().union(*self.lenient.values()) if self.lenient else held
        self.text(f"{label} (archive bytes)", data, line_numbers=False)
        self.skip = held

    def scan_blob(self, label, data, depth):
        self.set_skip(label)
        kind = archive_kind(data)
        if not kind:
            self.text(label, data)
            return
        proven = []
        if depth >= MAX_ARCHIVE_DEPTH:
            self.raw(label, data, proven)
            # Too deep to open is not clean: it is a finding, and it refuses.
            self.add(label, "archive-too-deep")
            return
        try:
            if kind == "zip":
                self.zip(label, data, depth, proven)
            elif kind == "tar":
                self.tar(label, data, depth, proven)
            elif kind == "ar":
                self.ar(label, data, depth, proven)
            else:
                inner = self.inflate(kind, data, label)
                if inner is not None:
                    self.blob(f"{label}!", inner, depth + 1)
        except (zipfile.BadZipFile, zipfile.LargeZipFile, tarfile.TarError, OSError, EOFError, lzma.LZMAError,
                zlib.error, ValueError, RuntimeError, NotImplementedError):
            # Unreadable is not clean. The raw bytes are scanned below; say the
            # rest could not be read.
            self.add(label, "unreadable-archive")
        # After the members, so it knows which of them were proven.
        self.set_skip(label)
        self.raw(label, data, proven)

    def zip(self, label, data, depth, proven):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if z.comment:
                self.text(f"{label} (comment)", z.comment, line_numbers=False)
            for i, info in enumerate(z.infolist(), 1):
                inner = self.member(label, info.filename, i)
                if info.comment:
                    self.text(f"{inner} (comment)", info.comment, line_numbers=False)
                if info.extra:
                    self.text(f"{inner} (extra field)", info.extra, line_numbers=False)
                if info.is_dir():
                    continue
                # Read in chunks against the budget: the sizes in a zip header
                # are the zip's own claim, not a fact.
                parts = []
                with z.open(info) as f:
                    while True:
                        chunk = f.read(CHUNK)
                        if not chunk:
                            break
                        if not self.charge(len(chunk), inner):
                            return
                        parts.append(chunk)
                content = b"".join(parts)
                if self.blob(inner, content, depth + 1):
                    span = zip_member_span(data, info, content)
                    if span:
                        proven.append(span)
                self.set_skip(label)

    def tar(self, label, data, depth, proven):
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as t:
            for i, m in enumerate(t, 1):
                inner = self.member(label, m.name, i)
                meta = [m.uname or "", m.gname or ""] + [f"{k}={v}" for k, v in (m.pax_headers or {}).items()]
                self.text(f"{inner} (owner and headers)", "\n".join(meta).encode("utf-8", "surrogateescape"),
                          line_numbers=False)
                if m.issym() or m.islnk():
                    self.text(f"{inner} (link target)", m.linkname.encode("utf-8", "surrogateescape"), line_numbers=False)
                    continue
                if not m.isfile():
                    continue
                f = t.extractfile(m)
                # Already inside bytes that were charged when they were unpacked.
                if self.blob(inner, f.read() if f else b"", depth + 1) and not m.issparse():
                    proven.append((m.offset_data, m.offset_data + m.size))
                self.set_skip(label)

    def ar(self, label, data, depth, proven):
        """The ar container a .deb is: control.tar.* and data.tar.* inside."""
        pos, i = 8, 0
        while pos + 60 <= len(data):
            header = data[pos:pos + 60]
            if header[58:60] != b"`\n":
                raise ValueError("bad ar header")
            i += 1
            raw_name = header[:16].rstrip(b" ").rstrip(b"/")
            size = int(header[48:58].strip() or b"0")
            body = data[pos + 60:pos + 60 + size]
            inner = self.member(label, raw_name, i)
            if self.blob(inner, body, depth + 1):
                proven.append((pos + 60, pos + 60 + len(body)))
            self.set_skip(label)
            pos += 60 + size + (size % 2)


def zip_member_span(data, info, content):
    """(start, end) of a zip member's compressed bytes to mask as proven, or None.

    The mask is a strict whitelist, not a length read from a header. A member's
    compressed bytes are masked only when every check here holds, and then only
    the local header's data through compress_size, nothing more. A stored member
    whose file size is not its compressed size, a deflate stream that is not
    exactly the proven bytes, any other method (bzip2, lzma), a local header
    that names another member or states different sizes, or a data descriptor
    whose sizes disagree all leave the member unmasked, so the raw pass reads it
    and any hit in it stands.
    """
    start = info.header_offset
    header = data[start:start + 30]
    if len(header) < 30 or header[:4] != b"PK\x03\x04":
        return None
    name_len = int.from_bytes(header[26:28], "little")
    extra_len = int.from_bytes(header[28:30], "little")
    body = start + 30 + name_len + extra_len
    if body + info.compress_size > len(data):
        return None
    # The local header must name the member the central directory names, and
    # state the same method and sizes. With a data descriptor (flag bit 3) the
    # sizes sit in a descriptor right after the compressed data instead.
    if data[start + 30:start + 30 + name_len] != info.filename.encode("utf-8", "surrogateescape"):
        return None
    flags = int.from_bytes(header[6:8], "little")
    method = int.from_bytes(header[8:10], "little")
    if method != info.compress_type:
        return None
    if flags & 0x08:
        descriptor = body + info.compress_size
        if descriptor + 16 > len(data) or data[descriptor:descriptor + 4] != b"PK\x07\x08":
            return None
        if int.from_bytes(data[descriptor + 8:descriptor + 12], "little") != info.compress_size:
            return None
        if int.from_bytes(data[descriptor + 12:descriptor + 16], "little") != info.file_size:
            return None
    elif (int.from_bytes(header[18:22], "little") != info.compress_size
          or int.from_bytes(header[22:26], "little") != info.file_size):
        return None
    stored = data[body:body + info.compress_size]
    proven = hashlib.sha256(content).digest()
    if method == zipfile.ZIP_STORED:
        if info.file_size != info.compress_size or hashlib.sha256(stored).digest() != proven:
            return None
    elif method == zipfile.ZIP_DEFLATED:
        d = zlib.decompressobj(-15)
        try:
            # One byte past the proven size is enough to refuse an oversized
            # member, and stops a crafted one inflating without bound first.
            out = d.decompress(stored, info.file_size + 1)
        except zlib.error:
            return None
        # One whole stream, nothing after it, that decompresses to exactly the
        # bytes that were proven. The masked span also holds the stream's own
        # Huffman tables, which zlib has validated and which are not byte
        # aligned, so no readable identifier can sit in them.
        if not d.eof or d.unused_data or d.unconsumed_tail:
            return None
        if len(out) != info.file_size or hashlib.sha256(out).digest() != proven:
            return None
    else:
        return None
    return (body, body + info.compress_size)


def archive_kind(data):
    if data[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
        return "zip"
    if data[:2] == b"\x1f\x8b":
        return "gzip"
    if data[:3] == b"BZh":
        return "bz2"
    if data[:6] == b"\xfd7zXZ\x00":
        return "xz"
    if data[:4] == b"\x28\xb5\x2f\xfd":
        return "zstd"
    if data[:8] == b"!<arch>\n":
        return "ar"
    if len(data) > 262 and data[257:262] == b"ustar":
        return "tar"
    # A zip is found from its end, so one behind a prefix (a self-extracting
    # .exe, a polyglot) is still a zip and is opened like one.
    if len(data) >= 22 and b"PK\x05\x06" in data[-65557:]:
        try:
            if zipfile.is_zipfile(io.BytesIO(data)):
                return "zip"
        except (OSError, ValueError):
            pass  # not readable as a zip after all; scanned as bytes
    return None


def git(repo, *args):
    p = subprocess.run(["git", "-C", repo, *args], capture_output=True, env=git_env())
    if p.returncode != 0:
        # git's own words can contain a path or a ref name, so not repeated.
        raise ScanError(f"git {args[0]} failed (exit {p.returncode})")
    return p.stdout


def batch(repo, ids):
    """Yield (oid, type, body) for each id, via one git cat-file --batch."""
    if not ids:
        return
    proc = subprocess.Popen(["git", "-C", repo, "cat-file", "--batch"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=git_env())

    def feed():
        # Written from a thread: writing everything before reading fills the
        # output pipe and both sides wait for ever.
        try:
            proc.stdin.write(b"\n".join(ids) + b"\n")
        finally:
            proc.stdin.close()

    threading.Thread(target=feed, daemon=True).start()
    out = proc.stdout
    seen = 0
    while True:
        header = out.readline()
        if not header:
            break
        parts = header.split()
        if len(parts) == 2 and parts[1] == b"missing":
            raise ScanError(f"object {parts[0][:10].decode()} missing")
        oid, kind, size = parts
        body = out.read(int(size))
        out.read(1)
        seen += 1
        yield oid, kind, body
    if proc.wait() != 0 or seen != len(ids):
        raise ScanError("git cat-file failed")


def tree_entries(body, hash_len):
    """(mode, name) for each entry of a raw tree object."""
    pos = 0
    while pos < len(body):
        sp = body.index(b" ", pos)
        nul = body.index(b"\0", sp)
        yield body[pos:sp], body[sp + 1:nul]
        pos = nul + 1 + hash_len


def scan_objects(sc, repo, revargs):
    # Policy alone needs only commits and tags, not every blob behind them.
    identifiers = "identifiers" in sc.checks
    listing = git(repo, "rev-list", *(["--objects"] if identifiers else []), *revargs)
    hash_len = 32 if git(repo, "rev-parse", "--show-object-format").strip() == b"sha256" else 20
    labels = {}
    order = []
    for line in listing.splitlines():
        oid, _, path = line.partition(b" ")
        fallback = f"object {oid[:10].decode()}"
        label = sc.label_for(path, fallback) if path else fallback
        if oid not in labels:
            order.append(oid)
            labels[oid] = label
    # Tags named on the command line are peeled by rev-list; scan the tag
    # objects themselves too, since a tag message is published with the tag.
    for a in revargs:
        if a.startswith("-") or a.startswith("^") or ".." in a:
            continue
        p = subprocess.run(["git", "-C", repo, "cat-file", "-t", a], capture_output=True, env=git_env())
        if p.returncode == 0 and p.stdout.strip() == b"tag":
            # A tag may point at another tag; every object in the chain is
            # transferred, so every one is scanned, not only the outermost.
            oid = git(repo, "rev-parse", a + "^{tag}").strip()
            for _ in range(64):
                if oid not in labels:
                    order.append(oid)
                    labels[oid] = f"tag {oid[:10].decode()}"
                body = git(repo, "cat-file", "tag", oid.decode())
                target, kind = None, None
                for hl in body.split(b"\n\n", 1)[0].split(b"\n"):
                    if hl.startswith(b"object "):
                        target = hl[7:].strip()
                    elif hl.startswith(b"type "):
                        kind = hl[5:].strip()
                if kind != b"tag" or not target:
                    break
                oid = target
            else:
                raise ScanError("tag chain too deep")
    commits = 0
    for oid, kind, body in batch(repo, order):
        if kind == b"blob":
            # A symlink's blob is its target, scanned as text like any other.
            if identifiers:
                sc.blob(labels[oid], body)
        elif kind == b"tree":
            # Every name in every new tree. rev-list names an object once, by
            # the first path it meets, so a rename (the blob already on the
            # remote) or a second name for the same bytes is only visible here.
            if identifiers:
                for i, (_, name) in enumerate(tree_entries(body, hash_len), 1):
                    sc.names(name, f"tree {oid[:10].decode()} entry #{i}")
        elif kind in (b"commit", b"tag"):
            commits += kind == b"commit"
            sc.git_object(kind, oid, body, f"{kind.decode()} {oid[:10].decode()}")
    return len(order), commits


def scan_tree(sc, repo, rev):
    listing = git(repo, "ls-tree", "-r", "-z", "--full-tree", rev)
    ids, labels = [], {}
    for entry in listing.split(b"\0"):
        if not entry:
            continue
        meta, _, path = entry.partition(b"\t")
        mode, kind, oid = meta.split()
        if kind != b"blob":
            continue
        label = sc.label_for(path, f"object {oid[:10].decode()}")
        if oid not in labels:
            ids.append(oid)
            labels[oid] = []
        labels[oid].append(label)
    for oid, kind, body in batch(repo, ids):
        for label in labels[oid]:
            sc.blob(label, body)


def scan_paths(sc, targets):
    n = 0
    for ti, t in enumerate(targets, 1):
        if os.path.islink(t):
            n += 1
            label = sc.label_for(os.path.basename(t), f"file #{n}")
            sc.text(f"{label} (link target)", os.readlink(t).encode("utf-8", "replace"), line_numbers=False)
        elif os.path.isdir(t):
            for root, dirs, files in os.walk(t, followlinks=False):
                dirs[:] = [d for d in dirs if d != ".git"]
                for f in sorted(files) + [d for d in dirs if os.path.islink(os.path.join(root, d))]:
                    n += 1
                    full = os.path.join(root, f)
                    rel = os.path.relpath(full, t).replace(os.sep, "/")
                    sc.set_skip(rel)
                    label = sc.label_for(rel, f"file #{n}")
                    st = os.lstat(full)
                    if stat.S_ISLNK(st.st_mode):
                        sc.text(f"{label} (link target)", os.readlink(full).encode("utf-8", "replace"), line_numbers=False)
                        continue
                    if not stat.S_ISREG(st.st_mode):
                        continue
                    with open(full, "rb") as fh:
                        sc.blob(label if label.startswith("file #") else rel, fh.read())
        elif os.path.isfile(t):
            n += 1
            label = sc.label_for(os.path.basename(t), f"file #{n}")
            with open(t, "rb") as fh:
                sc.blob(label, fh.read())
        else:
            raise ScanError(f"argument #{ti} not found")


def strip_msg(path):
    with open(path, "rb") as f:
        msg = f.read()
    spans = attribution_lines(msg)
    if not spans:
        return 0
    out, last = [], 0
    for s, e in spans:
        if s < last:
            continue
        out.append(msg[last:s])
        last = e + 1 if e < len(msg) and msg[e:e + 1] == b"\n" else e
    out.append(msg[last:])
    new = re.sub(rb"\n{3,}", b"\n\n", b"".join(out)).rstrip(b"\n") + b"\n"
    with open(path, "wb") as f:
        f.write(new)
    sys.stderr.write("privacy-scan: removed AI attribution from the commit message\n")
    return 0


def export_secret():
    d = next((d for d in PRIVATE_DIRS if os.path.isfile(os.path.join(d, "identifiers.txt"))), None)
    if not d:
        raise ScanError("no identifiers list found")
    keep = lambda text: [l for l in text.splitlines() if l.strip() and not l.lstrip().startswith("#")]  # noqa: E731
    lines = keep(read(os.path.join(d, "identifiers.txt")))
    if os.path.isfile(os.path.join(d, "allow.txt")):
        for l in keep(read(os.path.join(d, "allow.txt"))):
            classes, rx = l.split("\t", 1)
            lines.append(f"allow:{classes}\t{rx}")
    if os.path.isfile(os.path.join(d, "identity.txt")):
        lines += [f"identity\t{l.strip()}" for l in keep(read(os.path.join(d, "identity.txt")))]
    parse_list("\n".join(lines), "export")
    sys.stdout.write("\n".join(lines) + "\n")
    return 0


def main(argv):
    opts = {"checks": "identifiers,policy", "ref": [], "lenient": {}}
    while argv and argv[0].startswith("-"):
        flag = argv.pop(0)
        if flag in ("-h", "--help"):
            print(__doc__)
            return 0
        if flag in ("--checks", "--patterns", "--allow", "--identity", "--ref", "--lenient",
                    "--prove-npm", "--prove-node", "--proof-cache", "--node-dist"):
            if not argv:
                raise ScanError(f"{flag} needs a value")
            value = argv.pop(0)
            if flag == "--ref":
                opts["ref"].append(value)
            elif flag == "--lenient":
                d, _, classes = value.partition("=")
                if not d or not classes:
                    raise ScanError("--lenient takes DIR=CLASS[,CLASS]")
                opts["lenient"].setdefault(d, set()).update(c.strip() for c in classes.split(",") if c.strip())
            else:
                opts[flag[2:]] = value
        elif flag == "--ci":
            global CI_MODE
            CI_MODE = True
        else:
            raise ScanError("unknown option (see --help)")
    if CI_MODE and (opts.get("patterns") or opts.get("allow") or opts.get("identity") or opts["lenient"]
                    and set(opts["lenient"]) != {"node_modules"}):
        raise ScanError("--ci takes its list from $PRIVATE_IDENTIFIERS only")
    # A proof changes nothing about the list. Its trust roots are a lockfile and
    # a version pin from the repository, and nodejs.org itself, never a local
    # copy of SHASUMS256.txt.
    if CI_MODE and opts.get("node-dist"):
        raise ScanError("--ci reads Node's checksums from nodejs.org only")
    if not argv:
        print(__doc__)
        return 2
    mode, args = argv[0], argv[1:]
    if mode == "export-secret":
        return export_secret()
    if mode == "strip-msg":
        if len(args) != 1:
            raise ScanError("strip-msg <file>")
        return strip_msg(args[0])
    checks = set(c.strip() for c in opts["checks"].split(",") if c.strip())
    if not checks or not checks <= {"identifiers", "policy"}:
        raise ScanError("--checks takes identifiers and/or policy")
    rules, allow, identities = resolve(opts)
    if "policy" in checks and not identities:
        raise ScanError("policy check needs identity.txt (the one allowed commit identity)")
    provenance = None
    if opts.get("prove-npm") or opts.get("prove-node"):
        if mode != "path":
            raise ScanError("--prove-npm and --prove-node apply to path mode only")
        cache = opts.get("proof-cache")
        provenance = Provenance(
            NpmProof(opts["prove-npm"], cache) if opts.get("prove-npm") else None,
            NodeProof(opts["prove-node"], cache, opts.get("node-dist")) if opts.get("prove-node") else None,
        )
    sc = Scanner(rules if "identifiers" in checks else [], allow, identities, checks, opts["lenient"], provenance)
    for i, ref in enumerate(opts["ref"], 1):
        sc.names(ref, f"ref #{i}")
    if mode in ("range", "history"):
        if not args:
            raise ScanError(f"{mode} <repo> ...")
        revs = ["--all"] if mode == "history" else args[1:]
        if not revs:
            raise ScanError("range needs rev-list arguments")
        n, commits = scan_objects(sc, args[0], revs)
        summary = f"{n} new objects, {commits} commits"
    elif mode in ("tree", "path"):
        if "identifiers" not in checks:
            raise ScanError(f"{mode} mode only runs identifier rules")
        if not args:
            raise ScanError(f"{mode} needs an argument")
        if mode == "tree":
            scan_tree(sc, args[0], args[1] if len(args) > 1 else "HEAD")
        else:
            scan_paths(sc, args)
        summary = f"{sc.items} items"
    else:
        raise ScanError("unknown mode (see --help)")
    found = sorted(sc.findings)
    for f in found:
        print(f"  {f}")
    if provenance:
        # Why a hit in a third-party file was not excused: the reason, never the match.
        for note in sorted(provenance.unproven):
            print(f"  not proven upstream: {note}")
    for f, proof in sorted(sc.exempted):
        print(f"  exempt, proven upstream bytes: {f}; {proof}")
    classes = {}
    for f in found:
        c = f.rsplit(": ", 1)[1]
        classes[c] = classes.get(c, 0) + 1
    by = ", ".join(f"{k} {v}" for k, v in sorted(classes.items()))
    exempt = f", exempted {len(sc.exempted)}" if provenance else ""
    print(f"privacy-scan: {summary}, rules {len(sc.rules)}, findings {len(found)}{' (' + by + ')' if by else ''}{exempt}")
    return 1 if found else 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except ScanError as e:
        sys.stderr.write(f"privacy-scan: ERROR: {e}\n")
        sys.exit(2)
    except Exception as e:  # anything unexpected is an error, never a pass
        sys.stderr.write(f"privacy-scan: ERROR: {e.__class__.__name__}\n")
        sys.exit(2)
