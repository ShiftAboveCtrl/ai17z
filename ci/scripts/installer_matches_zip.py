"""Whether an unpacked installer holds every file of an application zip, byte for byte.

    python3 installer_matches_zip.py <AI17Z-App-<version>.zip> <unpacked installer's app directory>

The installer and the zip are made from one staged directory, so an unpacked
installer that lacks a file of the zip, or holds different bytes for one, was
not unpacked whole. Extra files in the installer are allowed and are scanned
like everything else. Prints counts only, never a file name: names are what
the private identifier scan withholds.

Exit: 0 every file matched, 1 something missing or different, 2 could not run.
"""
import hashlib
import os
import sys
import zipfile


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: installer_matches_zip.py <zip> <directory>\n")
        return 2
    archive, root = argv
    if not os.path.isdir(root):
        print("the installer unpacked no application directory")
        return 1
    missing = different = total = 0
    try:
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                total += 1
                path = os.path.join(root, *info.filename.split("/"))
                if not os.path.isfile(path):
                    missing += 1
                    continue
                with open(path, "rb") as f:
                    if hashlib.sha256(f.read()).digest() != hashlib.sha256(z.read(info)).digest():
                        different += 1
    except (OSError, zipfile.BadZipFile) as e:
        sys.stderr.write(f"could not compare: {e.__class__.__name__}\n")
        return 2
    print(f"application zip: {total} files; missing from the installer: {missing}; different: {different}")
    return 0 if total and not missing and not different else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
