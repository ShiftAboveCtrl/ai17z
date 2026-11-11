#!/usr/bin/env python3
"""Copy GitHub releases and every asset to AI17Z Code. Run on the backup server."""
import argparse
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.error import HTTPError
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_publish", ROOT / "ci/scripts/release_publish.py")
release_publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release_publish)


# What has been verified, so a timer run asks GitHub for one list of releases
# and downloads nothing it has already proved. Without it every run downloaded
# every asset of every release, which an hourly timer would spend GitHub's API
# allowance on for nothing. systemd's StateDirectory makes this path writable.
STATE = Path(os.environ.get("AI17Z_SYNC_STATE", "/var/lib/ai17z-mirror/verified.json"))
SIGNER = ROOT / "ci/cosign.pub"


def fingerprint(release):
    """What a verified record is about: the release and every asset as GitHub lists them."""
    assets = sorted((asset["name"], asset["size"], asset.get("id")) for asset in release.get("assets", []))
    return dict(id=release.get("id"), name=release["name"], body=release["body"],
                prerelease=release["prerelease"], assets=assets)


def load_state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def record(state, tag, release):
    state[tag] = json.loads(json.dumps(fingerprint(release)))
    STATE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=1, sort_keys=True), encoding="utf-8")
    temporary.replace(STATE)


def verify_signatures(directory, run=None):
    """Every asset that has a Sigstore bundle verifies against AI17Z's release key."""
    run = run or subprocess.run
    cosign = os.environ.get("COSIGN", "cosign")
    checked = 0
    for bundle in sorted(directory.glob("*.sigstore.json")):
        subject = directory / bundle.name[: -len(".sigstore.json")]
        if not subject.is_file():
            raise ValueError("a signature bundle has no asset beside it")
        result = run([cosign, "verify-blob", str(subject), "--bundle", str(bundle), "--key", str(SIGNER)],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if result.returncode != 0:
            raise ValueError("an asset does not verify against ci/cosign.pub")
        checked += 1
    return checked


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Copy or verify exactly one tag; otherwise copy releases since beta.89")
    parser.add_argument("--check", action="store_true", help="Compare only; never create a release")
    parser.add_argument("--force", action="store_true", help="Download and verify again even what is recorded as verified")
    args = parser.parse_args()
    token = os.environ.get("FORGEJO_TOKEN", "")
    if not token:
        raise ValueError("FORGEJO_TOKEN is required")
    # Optional. The source repository is public, so an empty value reads it
    # anonymously: one API request for the release list plus one per release
    # not yet verified, and asset bytes from github.com's release downloads,
    # which do not spend the API allowance (sixty requests an hour per address).
    read_token = os.environ.get("GITHUB_READ_TOKEN", "")
    source = release_publish.Api("github", read_token)
    state = load_state()
    target = release_publish.Api("aicode", token)
    if args.tag:
        entry = source.by_tag(args.tag)
        if not entry:
            raise ValueError("source release is missing")
        releases = [entry]
    else:
        releases = []
        for page in range(1, 101):
            batch = source.request(f"/releases?per_page=100&page={page}")
            releases.extend(batch)
            if len(batch) < 100:
                break
        else:
            raise ValueError("too many releases")
    for release in reversed(releases):
        tag = release["tag_name"]
        if release["draft"]:
            continue
        release_publish.strict_tag(tag)
        if tag.startswith("v1.0.0-beta.") and int(tag.rsplit(".", 1)[1]) < 89:
            raise ValueError("old beta releases must not be copied")
        if tag.startswith("v0."):
            raise ValueError("old releases must not be copied")
        if not args.force and state.get(tag) == json.loads(json.dumps(fingerprint(release))):
            continue
        with tempfile.TemporaryDirectory(prefix="ai17z-release-sync-") as room:
            directory = Path(room)
            assets = source.assets(release)
            names = [release_publish.safe_name(asset["name"]) for asset in assets]
            if len(names) != len(set(names)) or not names:
                raise ValueError("source has missing or duplicate assets")
            files = []
            for asset in assets:
                path = directory / asset["name"]
                source.download(asset, path)
                if path.stat().st_size != asset["size"]:
                    raise ValueError("source download size differs")
                files.append(path)
            release_publish.verify_sums(directory)
            verify_signatures(directory)
            manifest = json.loads((directory / "release-manifest.json").read_text(encoding="utf-8"))
            if manifest.get("tag") != tag or manifest.get("version") != tag[1:]:
                raise ValueError("manifest does not describe the source tag")
            commit = manifest["commit"]
            if not re.fullmatch(r"[0-9a-f]{40}", commit):
                raise ValueError("manifest has an invalid commit")
            # Pull mirroring must finish first. This also prevents creating a tag
            # from a branch name supplied in third-party release metadata.
            refs = subprocess.check_output(["git", "ls-remote", "https://code.ai17z.io/AI17Z/ai17z.git", f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"], text=True)
            hashes = [line.split()[0] for line in refs.splitlines()]
            if not hashes or hashes[-1] != commit:
                raise ValueError("backup tag does not match the release commit; sync the pull mirror first")
            existing = target.by_tag(tag)
            if existing:
                if existing["draft"]:
                    raise ValueError("backup has an incomplete draft; inspect it before retrying")
                release_publish.compare(target, existing, files)
                if (existing["name"], existing["body"], existing["prerelease"]) != (release["name"], release["body"], release["prerelease"]):
                    raise ValueError("backup release metadata differs")
                print(f"Verified {tag}: {len(files)} assets")
            elif args.check:
                raise ValueError("backup release is missing")
            else:
                release_publish.publish(target, tag, release["name"], commit, release["body"], files)
            record(state, tag, release)


GITHUB_HOSTS = ("github.com", "githubusercontent.com")


def rate_limit_sentence(error):
    """A sentence for GitHub answering 403/429 because a limit was reached, else None."""
    host = urlparse(getattr(error, "url", "") or "").hostname or ""
    if error.code not in (403, 429) or not any(host == name or host.endswith("." + name) for name in GITHUB_HOSTS):
        return None
    headers = error.headers
    if error.code == 403 and headers.get("X-RateLimit-Remaining") != "0" and not headers.get("Retry-After"):
        return None
    reset = "unknown"
    try:
        if headers.get("X-RateLimit-Reset"):
            moment = datetime.fromtimestamp(int(headers["X-RateLimit-Reset"]), timezone.utc)
        elif headers.get("Retry-After"):
            moment = datetime.now(timezone.utc) + timedelta(seconds=int(headers["Retry-After"]))
        else:
            moment = None
        if moment:
            reset = moment.strftime("%Y-%m-%d %H:%M:%S UTC")
    except ValueError:
        pass
    return ("GitHub's rate limit is reached, so this run stopped; releases verified before it are kept. "
            f"The limit resets at {reset}. The next timer run tries again; set GITHUB_READ_TOKEN to lift it.")


def run():
    try:
        main()
    except HTTPError as error:
        # Response bodies and environment values are deliberately omitted.
        print(rate_limit_sentence(error) or f"Release sync refused ({type(error).__name__}); inspect local server logs", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"Release sync refused ({type(error).__name__}); inspect local server logs", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(run())
