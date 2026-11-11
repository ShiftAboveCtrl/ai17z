"""Offline release-sync checks. No request reaches either public host."""
from email.message import Message as MailMessage
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError


def Message(headers):
    message = MailMessage()
    for name, value in headers.items():
        message[name] = value
    return message

SPEC = importlib.util.spec_from_file_location("sync_releases", Path(__file__).with_name("sync-releases.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Source:
    def __init__(self):
        self.release = dict(id=1, tag_name="v1.0.0-beta.89", name="Beta 0.89", body="Notes", draft=False, prerelease=True)
        self.downloads = 0
        payload = b"application payload"
        self.files = {
            "package.zip": payload,
            "SHA256SUMS.txt": (hashlib.sha256(payload).hexdigest() + "  package.zip\n").encode(),
            "release-manifest.json": json.dumps(dict(version="1.0.0-beta.89", tag="v1.0.0-beta.89", commit="a" * 40)).encode(),
            "release-notes.md": b"Notes",
            "package.zip.sigstore.json": b"signature bundle",
        }

    def by_tag(self, tag):
        # GitHub lists a release's assets inline; the verified record is
        # compared against that list.
        return dict(self.release, assets=self.assets(self.release))

    def assets(self, release):
        return [dict(name=name, size=len(data), id=index) for index, (name, data) in enumerate(self.files.items())]

    def download(self, asset, path):
        self.downloads += 1
        path.write_bytes(self.files[asset["name"]])


class Target:
    def __init__(self):
        self.release = None
        self.files = {}
        self.published = False

    def by_tag(self, tag):
        return self.release

    def draft_exists(self, tag):
        return bool(self.release and self.release.get("draft") and self.release.get("tag_name") == tag)

    def create(self, data):
        self.release = dict(data, id=2)
        return self.release

    def upload(self, release, path):
        self.files[path.name] = path.read_bytes()

    def assets(self, release):
        return [dict(name=name, size=len(data)) for name, data in self.files.items()]

    def digest(self, asset):
        return hashlib.sha256(self.files[asset["name"]]).hexdigest()

    def publish(self, release, data):
        self.published = True
        self.release.update(data)


class Sync(unittest.TestCase):
    def setUp(self):
        self.source, self.target = Source(), Target()
        room = tempfile.TemporaryDirectory()
        self.addCleanup(room.cleanup)
        self.state = Path(room.name) / "verified.json"
        self.cosign_calls = []
        self.cosign_answer = 0

    def cosign(self, command, **options):
        self.cosign_calls.append(command)
        return subprocess.CompletedProcess(command, self.cosign_answer)

    def sync(self, check=False, refs=None, env=None, force=False):
        if refs is None:
            refs = "b" * 40 + "\trefs/tags/v1.0.0-beta.89\n" + "a" * 40 + "\trefs/tags/v1.0.0-beta.89^{}\n"
        if env is None:
            env = {"FORGEJO_TOKEN": "offline-test", "GITHUB_READ_TOKEN": "offline-read"}
        argv = ["sync-releases.py", "--tag", "v1.0.0-beta.89"] + (["--check"] if check else []) + (["--force"] if force else [])
        with patch.object(MODULE.release_publish, "Api", side_effect=[self.source, self.target]) as self.api, \
             patch.object(MODULE.subprocess, "check_output", return_value=refs), \
             patch.object(MODULE.subprocess, "run", side_effect=self.cosign), \
             patch.object(MODULE, "STATE", self.state), \
             patch.dict(MODULE.os.environ, env, clear=True), \
             patch("sys.argv", argv):
            MODULE.main()

    def test_copies_every_file_and_preserves_metadata(self):
        self.sync()
        self.assertEqual(self.target.files, self.source.files)
        self.assertTrue(self.target.published)
        self.assertEqual(self.target.release["name"], "Beta 0.89")
        self.assertEqual(self.target.release["body"], "Notes")
        self.assertTrue(self.target.release["prerelease"])

    def test_existing_release_is_compare_only(self):
        self.sync()
        self.target.published = False
        with patch.object(self.target, "create", side_effect=AssertionError("must not write")), \
             patch.object(self.target, "upload", side_effect=AssertionError("must not write")):
            self.sync(check=True)
        self.assertFalse(self.target.published)

    def test_check_missing_release_never_creates_one(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            self.sync(check=True)
        self.assertIsNone(self.target.release)

    def test_corrupt_source_stops_before_draft(self):
        self.source.files["package.zip"] = b"corruption"
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.sync()
        self.assertIsNone(self.target.release)

    def test_mirror_must_have_matching_peeled_tag(self):
        with self.assertRaisesRegex(ValueError, "backup tag"):
            self.sync(refs="b" * 40 + "\trefs/tags/v1.0.0-beta.89\n")
        self.assertIsNone(self.target.release)

    def test_manifest_must_describe_source_tag(self):
        self.source.files["release-manifest.json"] = json.dumps(dict(version="1.0.0-beta.90", tag="v1.0.0-beta.90", commit="a" * 40)).encode()
        with self.assertRaisesRegex(ValueError, "manifest.*tag"):
            self.sync()
        self.assertIsNone(self.target.release)

    def test_github_read_token_is_optional(self):
        self.sync(env={"FORGEJO_TOKEN": "offline-test"})
        self.assertEqual(self.api.call_args_list[0].args, ("github", ""))
        self.assertEqual(self.target.files, self.source.files)

    def test_a_token_is_passed_to_the_source_when_set(self):
        self.sync()
        self.assertEqual(self.api.call_args_list[0].args, ("github", "offline-read"))

    def test_a_forgejo_token_is_still_required(self):
        with self.assertRaisesRegex(ValueError, "FORGEJO_TOKEN"):
            self.sync(env={})

    def test_a_verified_release_is_not_downloaded_again(self):
        self.sync()
        first = self.source.downloads
        self.assertGreater(first, 0)
        self.assertIn("v1.0.0-beta.89", json.loads(self.state.read_text(encoding="utf-8")))
        self.sync()
        self.assertEqual(self.source.downloads, first)

    def test_a_changed_or_forced_release_is_verified_again(self):
        self.sync()
        first = self.source.downloads
        self.sync(force=True)
        self.assertEqual(self.source.downloads, 2 * first)
        # GitHub now lists a file the record does not know: verified again, and
        # refused, because the backup does not hold it.
        self.source.files["extra.txt"] = b"a file GitHub did not list before"
        with self.assertRaises(ValueError):
            self.sync()
        self.assertEqual(self.source.downloads, 3 * first + 1)

    def test_a_failed_run_records_nothing(self):
        self.source.files["package.zip"] = b"corruption"
        with self.assertRaises(ValueError):
            self.sync()
        self.assertFalse(self.state.exists())

    def test_every_bundle_is_verified_against_the_release_key(self):
        self.sync()
        self.assertEqual(len(self.cosign_calls), 1)
        command = self.cosign_calls[0]
        self.assertEqual(command[1], "verify-blob")
        self.assertTrue(command[2].endswith("package.zip"))
        self.assertTrue(command[4].endswith("package.zip.sigstore.json"))
        self.assertEqual(Path(command[6]), MODULE.ROOT / "ci" / "cosign.pub")

    def test_a_signature_that_does_not_verify_stops_before_a_draft(self):
        self.cosign_answer = 1
        with self.assertRaisesRegex(ValueError, "cosign.pub"):
            self.sync()
        self.assertIsNone(self.target.release)
        self.assertFalse(self.state.exists())


DOWNLOAD = "https://github.com/ShiftAboveCtrl/ai17z/releases/download/v1.0.0-beta.89/package.zip"


class Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *details):
        return False

    def read(self, size=-1):
        data, self.payload = self.payload[:size] if size > 0 else self.payload, b""
        return data


class Anonymous(unittest.TestCase):
    """The real GitHub Api object with no token, its network replaced by a recorder."""

    def setUp(self):
        self.api = MODULE.release_publish.Api("github", "")
        self.requests = []
        room = tempfile.TemporaryDirectory()
        self.addCleanup(room.cleanup)
        self.path = Path(room.name) / "package.zip"

    def opener(self, request, timeout=None):
        self.requests.append(request)
        return Response(b"application payload")

    def download(self, url=DOWNLOAD):
        with patch.object(self.api.opener, "open", side_effect=self.opener):
            self.api.download(dict(id=7, name="package.zip", size=19, browser_download_url=url), self.path)

    def test_download_uses_the_release_download_url_and_sends_no_credential(self):
        self.download()
        self.assertEqual(self.path.read_bytes(), b"application payload")
        self.assertEqual(len(self.requests), 1)
        request = self.requests[0]
        self.assertEqual(request.full_url, DOWNLOAD)
        self.assertNotIn("api.github.com", request.full_url)
        self.assertFalse(request.has_header("Authorization"))
        self.assertTrue(request.get_header("User-agent"))

    def test_api_requests_send_no_authorization_header(self):
        with patch.object(self.api.opener, "open", side_effect=lambda request, timeout=None: Response(b"[]")) as opened:
            self.api.request("/releases?per_page=100&page=1")
        request = opened.call_args.args[0]
        self.assertTrue(request.full_url.startswith("https://api.github.com/"))
        self.assertFalse(request.has_header("Authorization"))

    def test_a_download_url_outside_the_source_repository_is_refused(self):
        for url in ("https://example.invalid/releases/download/v1/package.zip",
                    "https://github.com/someone-else/repo/releases/download/v1/package.zip",
                    "http://github.com/ShiftAboveCtrl/ai17z/releases/download/v1/package.zip"):
            with self.assertRaisesRegex(ValueError, "source asset URL"):
                self.download(url)
        self.assertEqual(self.requests, [])

    def test_a_redirect_to_a_foreign_host_is_refused(self):
        redirect = MODULE.release_publish.SafeRedirect()
        request = MODULE.release_publish.Request(DOWNLOAD)
        for target in ("https://example.invalid/package.zip", "http://objects.githubusercontent.com/package.zip",
                       "https://objects.githubusercontent.com.example.invalid/package.zip"):
            with self.assertRaisesRegex(ValueError, "outside the declared hosts"):
                redirect.redirect_request(request, None, 302, "Found", {}, target)
        followed = redirect.redirect_request(request, None, 302, "Found", {}, "https://release-assets.githubusercontent.com/package.zip")
        self.assertEqual(followed.full_url, "https://release-assets.githubusercontent.com/package.zip")

    def test_a_token_still_downloads_through_the_api(self):
        self.api = MODULE.release_publish.Api("github", "offline-read")
        self.download()
        self.assertEqual(self.requests[0].full_url, "https://api.github.com/repos/ShiftAboveCtrl/ai17z/releases/assets/7")
        self.assertEqual(self.requests[0].get_header("Authorization"), "Bearer offline-read")


class RateLimit(unittest.TestCase):
    def limited(self, code, headers, url="https://api.github.com/repos/ShiftAboveCtrl/ai17z/releases?per_page=100&page=1"):
        return HTTPError(url, code, "limited", Message(headers), io.BytesIO(b""))

    def run_main(self, error):
        # A real run: the first request GitHub is asked is the one that fails.
        with patch.object(MODULE, "main", side_effect=error), patch("sys.stderr", new_callable=io.StringIO) as stderr:
            return MODULE.run(), stderr.getvalue()

    def test_an_exhausted_limit_exits_nonzero_with_the_reset_time_and_does_not_retry(self):
        error = self.limited(403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1793000000"})
        with patch.object(MODULE, "main", side_effect=error) as main, patch("sys.stderr", new_callable=io.StringIO) as stderr:
            code = MODULE.run()
        self.assertEqual(code, 1)
        self.assertEqual(main.call_count, 1)
        self.assertIn("rate limit", stderr.getvalue())
        self.assertIn("2026-10-26 07:33:20 UTC", stderr.getvalue())

    def test_429_with_retry_after_names_a_reset_time(self):
        code, message = self.run_main(self.limited(429, {"Retry-After": "120"}, "https://github.com/ShiftAboveCtrl/ai17z/releases/download/v1/a"))
        self.assertEqual(code, 1)
        self.assertRegex(message, r"resets at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC")

    def test_a_forbidden_without_rate_limit_headers_is_not_called_a_rate_limit(self):
        code, message = self.run_main(self.limited(403, {}))
        self.assertEqual(code, 1)
        self.assertNotIn("rate limit", message)
        self.assertIn("HTTPError", message)

    def test_other_failures_still_exit_nonzero_without_detail(self):
        code, message = self.run_main(ValueError("secret detail"))
        self.assertEqual((code, "secret detail" in message), (1, False))

    def test_success_exits_zero(self):
        with patch.object(MODULE, "main"):
            self.assertEqual(MODULE.run(), 0)


class Configure(unittest.TestCase):
    def test_every_request_carries_a_user_agent(self):
        spec = importlib.util.spec_from_file_location("configure", Path(__file__).with_name("configure.py"))
        configure = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(configure)
        seen = []

        def urlopen(request, timeout=None):
            seen.append(request)
            return Response(b"{}")

        with patch.object(configure, "urlopen", side_effect=urlopen), \
             patch.dict(configure.os.environ, {"FORGEJO_TOKEN": "offline-test"}, clear=True), \
             patch("sys.argv", ["configure.py", "create"]), patch("sys.stdout", new_callable=io.StringIO):
            configure.main()
        self.assertEqual(len(seen), 2)
        for request in seen:
            self.assertTrue(request.get_header("User-agent"))
            self.assertNotIn("python-urllib", request.get_header("User-agent").lower())


if __name__ == "__main__":
    unittest.main()
