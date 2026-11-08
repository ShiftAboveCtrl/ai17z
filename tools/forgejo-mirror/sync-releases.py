#!/usr/bin/env python3
"""Copy GitHub releases and every asset to AI17Z Code. Run on the backup server."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

SPEC = importlib.util.spec_from_file_location("release_publish", Path(__file__).resolve().parents[2] / "ci/scripts/release_publish.py")
release_publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release_publish)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Copy or verify exactly one tag; otherwise copy releases since beta.89")
    parser.add_argument("--check", action="store_true", help="Compare only; never create a release")
    args = parser.parse_args()
    token = os.environ.get("FORGEJO_TOKEN", "")
    if not token:
        raise ValueError("FORGEJO_TOKEN is required")
    source = release_publish.Api("github", os.environ.get("GITHUB_READ_TOKEN", ""))
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


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Server responses and environment values are deliberately omitted.
        print(f"Release sync refused ({type(error).__name__}); inspect local server logs", file=sys.stderr)
        sys.exit(1)
