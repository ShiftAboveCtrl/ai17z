"""Offline proofs for publishing and copying releases, including equal-size corruption."""
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
from pathlib import Path
import tempfile
import unittest
import unittest.mock

SPEC = importlib.util.spec_from_file_location("release_publish", Path(__file__).with_name("release_publish.py"))
MODULE = importlib.util.module_from_spec(SPEC)
if SPEC.loader:
    try:
        SPEC.loader.exec_module(MODULE)
    except FileNotFoundError:
        pass


class FakeApi:
    def __init__(self, corrupt=False, existing=None, drafts=()):
        self.corrupt = corrupt
        self.release = existing
        self.drafts = list(drafts)
        self.files = {}
        self.published = False

    def by_tag(self, tag):
        # As on both hosts: asking by tag never returns a draft.
        return None if self.release and self.release.get("draft") else self.release

    def draft_exists(self, tag):
        return any(row["draft"] and row["tag_name"] == tag for row in self.drafts)

    def create(self, data):
        self.release = dict(data, id=1, assets=[])
        return self.release

    def upload(self, release, path):
        data = path.read_bytes()
        if self.corrupt:
            data = b"!" * len(data)
        self.files[path.name] = data
        self.release["assets"].append(dict(name=path.name, size=len(data), id=len(self.files)))

    def assets(self, release):
        return self.release["assets"]

    def digest(self, asset):
        return hashlib.sha256(self.files[asset["name"]]).hexdigest()

    def publish(self, release, data):
        self.published = True
        self.release.update(data)


class Publishing(unittest.TestCase):
    def setUp(self):
        self.room = tempfile.TemporaryDirectory()
        self.addCleanup(self.room.cleanup)
        self.directory = Path(self.room.name)
        self.payload = self.directory / "package.zip"
        self.payload.write_bytes(b"package")
        self.notes = self.directory / "release-notes.md"
        self.notes.write_text("Release notes\n", encoding="utf-8")

    def publish(self, api):
        MODULE.publish(api, "v1.0.0-beta.89", "Beta 0.89", "a" * 40,
                       self.notes.read_text(), [self.payload, self.notes])

    def test_compares_every_byte_before_publishing(self):
        api = FakeApi()
        self.publish(api)
        self.assertTrue(api.published)
        self.assertTrue(api.release["prerelease"])
        self.assertEqual(set(api.files), {"package.zip", "release-notes.md"})

    def test_equal_size_corruption_leaves_draft(self):
        api = FakeApi(corrupt=True)
        with self.assertRaisesRegex(ValueError, "digest"):
            self.publish(api)
        self.assertFalse(api.published)
        self.assertTrue(api.release["draft"])

    def test_existing_release_is_never_modified(self):
        api = FakeApi(existing={"id": 9, "draft": False})
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.publish(api)
        self.assertEqual(api.files, {})

    def test_a_draft_left_for_the_tag_is_refused_before_anything_is_created(self):
        api = FakeApi(drafts=[{"id": 7, "tag_name": "v1.0.0-beta.89", "draft": True}])
        with self.assertRaisesRegex(ValueError, "draft release already exists"):
            self.publish(api)
        self.assertIsNone(api.release)
        self.assertEqual(api.files, {})

    def test_a_draft_for_another_tag_does_not_block(self):
        api = FakeApi(drafts=[{"id": 7, "tag_name": "v1.0.0-beta.88", "draft": True}])
        self.publish(api)
        self.assertTrue(api.published)

    def test_listing_finds_drafts_across_short_pages(self):
        # Forgejo returns fewer rows than asked for; the draft is on page two.
        pages = {1: [{"tag_name": "v1.0.0-beta.90", "draft": False}], 2: [{"tag_name": "v1.0.0-beta.89", "draft": True}], 3: []}
        api = MODULE.Api("github", "offline")
        api.request = lambda path, *rest: pages[int(re.search(r"[?&]page=(\d+)", path).group(1))]
        self.assertTrue(api.draft_exists("v1.0.0-beta.89"))
        self.assertFalse(api.draft_exists("v1.0.0-beta.91"))

    def test_forgejo_attachments_are_fetched_once(self):
        # Forgejo ignores paging on this endpoint and returns the whole list
        # for every page asked for.
        everything = [{"name": f"file-{n}", "size": n, "id": n} for n in range(30)]
        calls = []
        api = MODULE.Api("aicode", "offline")
        api.request = lambda path, *rest: calls.append(path) or list(everything)
        self.assertEqual(api.assets({"id": 4}), everything)
        self.assertEqual(len(calls), 1)

    def test_github_attachments_are_paged_until_empty(self):
        pages = {1: [{"name": "a"}], 2: [{"name": "b"}], 3: []}
        api = MODULE.Api("github", "offline")
        api.request = lambda path, *rest: pages[int(re.search(r"[?&]page=(\d+)", path).group(1))]
        self.assertEqual([row["name"] for row in api.assets({"id": 4})], ["a", "b"])

    def test_digest_is_chunked_and_needs_no_python_311(self):
        big = self.directory / "big.bin"
        big.write_bytes(b"x" * (3 * 1024 * 1024 + 5))
        with unittest.mock.patch.object(MODULE.hashlib, "file_digest", None, create=True):
            self.assertEqual(MODULE.file_digest(big), hashlib.sha256(big.read_bytes()).hexdigest())

    def test_duplicate_names_refused_before_creating_draft(self):
        api = FakeApi()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            MODULE.publish(api, "v1.0.0", "1.0.0", "a" * 40, "notes", [self.payload, self.payload])
        self.assertIsNone(api.release)

    def test_manifest_hashes_refuse_modified_payload_and_path_escape(self):
        sums = self.directory / "SHA256SUMS.txt"
        sums.write_text(hashlib.sha256(b"package").hexdigest() + "  package.zip\n", encoding="ascii")
        MODULE.verify_sums(self.directory)
        self.payload.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum"):
            MODULE.verify_sums(self.directory)
        sums.write_text("a" * 64 + "  ../outside\n", encoding="ascii")
        with self.assertRaisesRegex(ValueError, "name"):
            MODULE.verify_sums(self.directory)

    def test_extra_or_duplicate_remote_assets_are_refused(self):
        api = FakeApi()
        self.publish(api)
        api.release["assets"].append(dict(api.release["assets"][0]))
        with self.assertRaisesRegex(ValueError, "complete file set"):
            MODULE.compare(api, api.release, [self.payload, self.notes])

    def test_prerelease_grammar_is_strict_before_any_draft(self):
        for tag in ["v01.0.0", "v1.0.0-beta.01", "v1.0.0-beta..1", "v1.0.0/other"]:
            api = FakeApi()
            with self.assertRaisesRegex(ValueError, "semver"):
                MODULE.publish(api, tag, "title", "a" * 40, "notes", [self.payload])
            self.assertIsNone(api.release)


class PublishedQualification(unittest.TestCase):
    @unittest.skipUnless(shutil.which("jq"), "qualification requires jq")
    def test_asset_url_filter_accepts_only_the_declared_host_tag_and_name(self):
        script = Path(__file__).with_name("verify-published-release.sh").read_text(encoding="utf-8")
        query = re.search(r"indirect=.*?--arg dl \"\$DL\" '([^']+)'", script)
        self.assertIsNotNone(query)
        for host in ("https://github.com/ShiftAboveCtrl/ai17z", "https://code.ai17z.io/AI17Z/ai17z"):
            base = host + "/releases/download/v1.0.0-beta.89"
            fixture = {"assets": [
                {"name": "package.zip", "browser_download_url": base + "/package.zip"},
                {"name": "wrong-host.zip", "browser_download_url": "https://example.invalid/wrong-host.zip"},
                {"name": "wrong-name.zip", "browser_download_url": base + "/other.zip"},
            ]}
            result = subprocess.run(["jq", "-r", "--arg", "dl", base, query.group(1)],
                                    input=json.dumps(fixture), text=True, capture_output=True, check=True)
            self.assertEqual(result.stdout.splitlines(), ["wrong-host.zip", "wrong-name.zip"])


if __name__ == "__main__":
    unittest.main()
