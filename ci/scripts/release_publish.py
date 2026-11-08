"""Draft, upload, compare downloaded bytes, publish. Also used by the backup sync."""
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        if urlparse(newurl).scheme != "https" or urlparse(newurl).hostname not in {
            "github.com", "api.github.com", "uploads.github.com",
            "release-assets.githubusercontent.com", "objects.githubusercontent.com", "code.ai17z.io",
        }:
            raise ValueError("release redirect outside the declared hosts")
        redirected = super().redirect_request(request, fp, code, msg, headers, newurl)
        if redirected:
            redirected.remove_header("Authorization")
        return redirected


def safe_name(name):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) or name in {".", ".."}:
        raise ValueError("invalid asset name")
    return name


def strict_tag(tag):
    number = r"(?:0|[1-9][0-9]*)"
    if not re.fullmatch(rf"v{number}\.{number}\.{number}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?", tag):
        raise ValueError("invalid semver release tag")
    if "-" in tag:
        for part in tag.split("-", 1)[1].split("."):
            if part.isdigit() and len(part) > 1 and part.startswith("0"):
                raise ValueError("invalid semver prerelease identifier")


def file_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_sums(directory):
    seen = set()
    for line in (directory / "SHA256SUMS.txt").read_text(encoding="ascii").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", line)
        if not match:
            raise ValueError("invalid checksum line")
        expected, name = match.groups()
        safe_name(name)
        if name in seen or not (directory / name).is_file() or file_digest(directory / name) != expected:
            raise ValueError("release checksum mismatch")
        seen.add(name)
    if not seen:
        raise ValueError("empty checksum list")
    return seen


class Api:
    def __init__(self, host, token=""):
        if host not in {"github", "aicode"}:
            raise ValueError("unknown release host")
        self.host = host
        self.root = ("https://api.github.com/repos/ShiftAboveCtrl/ai17z" if host == "github"
                     else "https://code.ai17z.io/api/v1/repos/AI17Z/ai17z")
        self.token = token
        self.opener = build_opener(SafeRedirect())

    def open(self, url, method="GET", data=None, kind="application/json"):
        # Auth is sent only to the API we constructed. Redirects drop it.
        headers = {"User-Agent": "AI17Z-release", "Accept": "application/vnd.github+json" if self.host == "github" else "application/json"}
        if self.token:
            headers["Authorization"] = ("Bearer " if self.host == "github" else "token ") + self.token
        if data is not None:
            headers["Content-Type"] = kind
        return self.opener.open(Request(url, data=data, headers=headers, method=method), timeout=300)

    def request(self, path, method="GET", data=None):
        payload = None if data is None else json.dumps(data).encode()
        with self.open(self.root + path, method, payload) as response:
            return json.load(response)

    def by_tag(self, tag):
        try:
            return self.request("/releases/tags/" + quote(tag, safe=""))
        except HTTPError as error:
            if error.code == 404:
                return None
            raise

    def create(self, data):
        return self.request("/releases", "POST", data)

    def upload(self, release, path):
        name = safe_name(path.name)
        if self.host == "github":
            url = self.root.replace("api.github.com", "uploads.github.com") + f"/releases/{release['id']}/assets?name={quote(name)}"
            data = path.read_bytes()
            kind = "application/octet-stream"
        else:
            # Forgejo's upload endpoint takes multipart, not GitHub's raw bytes.
            boundary = "AI17ZReleaseBoundary"
            data = (f'--{boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="{name}"\r\n'
                    'Content-Type: application/octet-stream\r\n\r\n').encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
            kind = "multipart/form-data; boundary=" + boundary
            url = self.root + f"/releases/{release['id']}/assets?name={quote(name)}"
        with self.open(url, "POST", data, kind) as response:
            json.load(response)

    def assets(self, release):
        result = []
        for page in range(1, 101):
            rows = self.request(f"/releases/{release['id']}/assets?per_page=100&limit=100&page={page}")
            result.extend(rows)
            if len(rows) < 100:
                return result
        raise ValueError("too many release assets")

    def download(self, asset, path=None):
        if self.host == "github":
            request = Request(self.root + f"/releases/assets/{int(asset['id'])}", headers={
                "User-Agent": "AI17Z-release", "Accept": "application/octet-stream",
                **({"Authorization": "Bearer " + self.token} if self.token else {}),
            })
        else:
            url = asset["browser_download_url"]
            if not url.startswith("https://code.ai17z.io/AI17Z/ai17z/releases/download/"):
                raise ValueError("invalid backup asset URL")
            request = Request(url, headers={"User-Agent": "AI17Z-release", **({"Authorization": "token " + self.token} if self.token else {})})
        digest = hashlib.sha256()
        target = path.open("wb") if path else None
        try:
            with self.opener.open(request, timeout=300) as response:
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    if target:
                        target.write(chunk)
        finally:
            if target:
                target.close()
        return digest.hexdigest()

    def digest(self, asset):
        return self.download(asset)

    def publish(self, release, data):
        return self.request(f"/releases/{release['id']}", "PATCH", data)


def compare(api, release, files):
    attached = api.assets(release)
    expected = {path.name: path for path in files}
    names = [asset["name"] for asset in attached]
    if len(names) != len(set(names)) or set(names) != set(expected):
        raise ValueError("release assets differ from the complete file set")
    for asset in attached:
        path = expected[asset["name"]]
        if path.stat().st_size != asset["size"] or api.digest(asset) != file_digest(path):
            raise ValueError("release asset size or digest mismatch; draft stays unpublished")


def publish(api, tag, title, commit, notes, files):
    strict_tag(tag)
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("invalid release commit")
    names = [safe_name(path.name) for path in files]
    if not names or len(names) != len(set(names)):
        raise ValueError("empty or duplicate asset names")
    if any(not path.is_file() or path.is_symlink() for path in files):
        raise ValueError("release asset is not a regular file")
    if api.by_tag(tag) is not None:
        raise ValueError("release already exists; refusing to modify it")
    prerelease = "-" in tag
    release = api.create(dict(tag_name=tag, name=title, target_commitish=commit, body=notes, draft=True, prerelease=prerelease))
    for path in files:
        api.upload(release, path)
    compare(api, release, files)
    api.publish(release, dict(draft=False, prerelease=prerelease))
    print(f"Published {title}: {len(files)} assets, downloaded hashes match")


def main():
    import os
    tag, title, commit, notes, *names = sys.argv[1:]
    token = os.environ.get("RELEASE_TOKEN", "")
    if not token:
        raise ValueError("RELEASE_TOKEN is required")
    verify_sums(Path.cwd())
    publish(Api("github", token), tag, title, commit, Path(notes).read_text(encoding="utf-8"), [Path(name) for name in names])


if __name__ == "__main__":
    try:
        main()
    except (ValueError, HTTPError) as error:
        # HTTPError's body can hold credentials; never print it.
        print(f"Release refused: {error.code if isinstance(error, HTTPError) else error}", file=sys.stderr)
        sys.exit(1)
