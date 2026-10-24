"""Unpacks the shared libraries of Debian packages into one directory (the recipe's unpack-blender-libs step):

    python3.12 deployment/idunn/unpack-debs.py <destination directory> <package.deb>...

Only usr/lib/x86_64-linux-gnu/*.so* is taken, flat: regular files and relative symlinks. Nothing else in a package
is read out, nothing is overwritten, and a package that yields no library is an error. Standard library only: the
step runs before any package is installed.
"""
import fnmatch
import io
import os
import pathlib
import sys
import tarfile

LIBRARY_DIRECTORY = "usr/lib/x86_64-linux-gnu"


def data_archive(deb):
    """The data.tar.* member of a .deb, an ar archive."""
    raw = deb.read_bytes()
    if raw[:8] != b"!<arch>\n":
        raise SystemExit("not an ar archive: " + deb.name)
    position = 8
    while position + 60 <= len(raw):
        header = raw[position:position + 60]
        name = header[:16].decode("ascii").strip().rstrip("/")
        size = int(header[48:58].decode("ascii").strip())
        position += 60
        if name.startswith("data.tar"):
            return raw[position:position + size]
        position += size + (size & 1)
    raise SystemExit("no data archive in " + deb.name)


def unpack(deb, destination):
    taken = []
    with tarfile.open(fileobj=io.BytesIO(data_archive(deb)), mode="r:*") as archive:
        for member in archive:
            directory, _, name = member.name.lstrip("./").rpartition("/")
            if directory != LIBRARY_DIRECTORY or not fnmatch.fnmatch(name, "*.so*"):
                continue
            target = destination / name
            if os.path.lexists(target):
                raise SystemExit("already present: " + name)
            if member.isreg():
                target.write_bytes(archive.extractfile(member).read())
                target.chmod(0o644)
            elif member.issym():
                if "/" in member.linkname or member.linkname in ("", ".", ".."):
                    raise SystemExit("not a sibling link: " + name)
                os.symlink(member.linkname, target)
            else:
                raise SystemExit("unexpected member type: " + name)
            taken.append(name)
    if not taken:
        raise SystemExit("no library in " + deb.name)
    return taken


def main(argv):
    if len(argv) < 2:
        raise SystemExit("usage: unpack-debs.py <destination directory> <package.deb>...")
    destination = pathlib.Path(argv[0])
    if not destination.is_dir():
        raise SystemExit("destination is not a directory")
    total = 0
    for deb in argv[1:]:
        taken = unpack(pathlib.Path(deb), destination)
        total += len(taken)
        print(f"{pathlib.Path(deb).name}: {len(taken)} libraries")
    print(f"unpacked {total} libraries")


if __name__ == "__main__":
    main(sys.argv[1:])
