"""Whether an unpacked installer holds every file of an application zip, byte for byte.

    python3 installer_matches_zip.py <AI17Z-App-<version>.zip> <app directory> [<whole output directory>]

The installer and the zip are made from one staged directory, so an unpacked
installer that lacks a file of the zip, or holds different bytes for one, was
not unpacked whole.

Files only in the installer are reported as installer-only, and each is then
judged by its content: one whose bytes are those of some file of the zip is a
copy of a file already proven, so it is proven too. That is the whole of what
the installer adds, in practice. The zip leaves out symbolic links and Inno
Setup follows them, so every npm workspace link under node_modules/@xbam comes
out of the installer as a second copy of a directory the zip holds once, and
the launcher the installer script adds is a file the zip carries as well. A
file that is neither in the zip nor a copy of one is reported as unproven, and
the caller refuses on those when innoextract warned that it could not read some
of its own output back, because nothing then shows that they came out whole.

Installer-only is counted across the whole output directory when one is given,
not only under the application directory. Prints counts only, never a file
name: names are what the private identifier scan withholds.

Exit: 0 every file matched, 1 something missing or different, 2 could not run.
"""
import hashlib
import os
import sys
import zipfile


def main(argv):
    if len(argv) not in (2, 3):
        sys.stderr.write("usage: installer_matches_zip.py <zip> <app-directory> [<whole-output-directory>]\n")
        return 2
    archive, app_dir = argv[0], argv[1]
    whole_dir = argv[2] if len(argv) == 3 else app_dir
    if not os.path.isdir(app_dir):
        print("the installer unpacked no application directory")
        return 1
    missing = different = total = 0
    zip_paths = set()
    # SHA-256 of every file the zip holds, to recognise a copy of one.
    zip_digests = set()
    try:
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                total += 1
                zip_paths.add(info.filename.replace("\\", "/"))
                expected = hashlib.sha256(z.read(info)).digest()
                zip_digests.add(expected)
                path = os.path.join(app_dir, *info.filename.split("/"))
                if not os.path.isfile(path):
                    missing += 1
                    continue
                with open(path, "rb") as f:
                    if hashlib.sha256(f.read()).digest() != expected:
                        different += 1
    except (OSError, zipfile.BadZipFile) as e:
        sys.stderr.write(f"could not compare: {e.__class__.__name__}\n")
        return 2
    # Installer-only files: every file of the whole unpacked output that is not
    # one of the application zip's files, wherever in the output it sits, not
    # only under the application directory. Without a whole-output directory the
    # application directory is the whole output.
    prefix = os.path.relpath(app_dir, whole_dir).replace(os.sep, "/")
    extra = copies = 0
    for dirpath, _, filenames in os.walk(whole_dir):
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, whole_dir).replace(os.sep, "/")
            accounted = rel in zip_paths if prefix == "." else (rel.startswith(prefix + "/") and rel[len(prefix) + 1:] in zip_paths)
            if accounted:
                continue
            extra += 1
            try:
                with open(full, "rb") as f:
                    if hashlib.sha256(f.read()).digest() in zip_digests:
                        copies += 1
            except OSError as e:
                # Unreadable is unproven, and it is counted as such below.
                sys.stderr.write(f"could not read an installer-only file: {e.__class__.__name__}\n")
    unproven = extra - copies
    print(
        f"application zip: {total} files; missing from the installer: {missing}; different: {different}; "
        f"installer-only: {extra}; copies of zip files: {copies}; unproven: {unproven}"
    )
    return 0 if total and not missing and not different else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
