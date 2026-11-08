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

SPEC = importlib.util.spec_from_file_location("release_publish", Path(__file__).with_name("release_publish.py"))
MODULE = importlib.util.module_from_spec(SPEC)
if SPEC.loader:
    try:
        SPEC.loader.exec_module(MODULE)
    except FileNotFoundError:
        pass


class FakeApi:
    def __init__(self, corrupt=False, existing=None):
        self.corrupt = corrupt
        self.release = existing
        self.files = {}
        self.published = False

    def by_tag(self, tag):
        return self.release

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
