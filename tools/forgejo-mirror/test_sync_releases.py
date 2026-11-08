"""Offline release-sync checks. No request reaches either public host."""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("sync_releases", Path(__file__).with_name("sync-releases.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Source:
    def __init__(self):
        self.release = dict(id=1, tag_name="v1.0.0-beta.89", name="Beta 0.89", body="Notes", draft=False, prerelease=True)
        payload = b"application payload"
        self.files = {
            "package.zip": payload,
            "SHA256SUMS.txt": (hashlib.sha256(payload).hexdigest() + "  package.zip\n").encode(),
            "release-manifest.json": json.dumps(dict(version="1.0.0-beta.89", tag="v1.0.0-beta.89", commit="a" * 40)).encode(),
            "release-notes.md": b"Notes",
            "package.zip.sigstore.json": b"signature bundle",
        }

    def by_tag(self, tag):
        return self.release

    def assets(self, release):
        return [dict(name=name, size=len(data)) for name, data in self.files.items()]

    def download(self, asset, path):
        path.write_bytes(self.files[asset["name"]])


class Target:
    def __init__(self):
        self.release = None
        self.files = {}
        self.published = False

    def by_tag(self, tag):
        return self.release

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

    def sync(self, check=False, refs=None):
        if refs is None:
            refs = "b" * 40 + "\trefs/tags/v1.0.0-beta.89\n" + "a" * 40 + "\trefs/tags/v1.0.0-beta.89^{}\n"
        with patch.object(MODULE.release_publish, "Api", side_effect=[self.source, self.target]), \
             patch.object(MODULE.subprocess, "check_output", return_value=refs), \
             patch.dict(MODULE.os.environ, {"FORGEJO_TOKEN": "offline-test"}), \
             patch("sys.argv", ["sync-releases.py", "--tag", "v1.0.0-beta.89"] + (["--check"] if check else [])):
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


if __name__ == "__main__":
    unittest.main()
