"""Offline release-sync checks. No request reaches either public host."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

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
        with patch.object(MODULE.release_publish, "Api", side_effect=[self.source, self.target]), \
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

    def test_github_read_token_is_required(self):
        with self.assertRaisesRegex(ValueError, "GITHUB_READ_TOKEN"):
            self.sync(env={"FORGEJO_TOKEN": "offline-test"})
        self.assertEqual(self.source.downloads, 0)

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


if __name__ == "__main__":
    unittest.main()
