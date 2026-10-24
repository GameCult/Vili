"""deployment/idunn/unpack-debs.py takes a Debian package's shared libraries and nothing else."""
import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "deployment" / "idunn" / "unpack-debs.py"
spec = importlib.util.spec_from_file_location("unpack_debs", SOURCE)
unpack_debs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(unpack_debs)

LIB = "./usr/lib/x86_64-linux-gnu/"


def deb(path, members, compression="xz", marker=b"2.0\n"):
    """A .deb: an ar archive of a debian-binary marker and a data tarball holding `members` (name, kind, payload)."""
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode=f"w:{compression}") as archive:
        for name, kind, payload in members:
            info = tarfile.TarInfo(name)
            if kind == "file":
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
            elif kind in ("symlink", "hardlink"):
                info.type = tarfile.SYMTYPE if kind == "symlink" else tarfile.LNKTYPE
                info.linkname = payload
                archive.addfile(info)
            else:
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
    body = data.getvalue()

    def member(name, content):
        header = f"{name + '/':<16}{0:<12}{0:<6}{0:<6}{'100644':<8}{len(content):<10}`\n".encode("ascii")
        return header + content + (b"\n" if len(content) % 2 else b"")

    path.write_bytes(b"!<arch>\n" + member("debian-binary", marker) + member(f"data.tar.{compression}", body))


class UnpackDebs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)
        self.out = self.dir / "lib"
        self.out.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_takes_only_shared_libraries_flat_and_keeps_sibling_links(self):
        package = self.dir / "a.deb"
        deb(package, [
            (LIB, "dir", b""),
            (LIB + "libfoo.so.1.2", "file", b"ELF"),
            (LIB + "libfoo.so.1", "symlink", "libfoo.so.1.2"),
            (LIB + "libfoo.a", "file", b"static"),
            (LIB + "pkgconfig/foo.pc", "file", b"pc"),
            ("./usr/share/doc/foo/copyright", "file", b"text"),
            ("./etc/foo.so.conf", "file", b"conf"),
        ])
        self.assertEqual(sorted(unpack_debs.unpack(package, self.out)), ["libfoo.so.1", "libfoo.so.1.2"])
        self.assertEqual(sorted(entry.name for entry in self.out.iterdir()), ["libfoo.so.1", "libfoo.so.1.2"])
        self.assertEqual((self.out / "libfoo.so.1.2").read_bytes(), b"ELF")
        self.assertEqual((self.out / "libfoo.so.1").readlink().as_posix(), "libfoo.so.1.2")
        self.assertEqual((self.out / "libfoo.so.1.2").stat().st_mode & 0o777, 0o644)

    def test_a_gzip_data_archive_is_read_too(self):
        package = self.dir / "g.deb"
        deb(package, [(LIB + "libbar.so.0", "file", b"ELF")], compression="gz")
        self.assertEqual(unpack_debs.unpack(package, self.out), ["libbar.so.0"])

    def test_refuses_to_overwrite(self):
        (self.out / "libfoo.so.1").write_bytes(b"already here")
        package = self.dir / "a.deb"
        deb(package, [(LIB + "libfoo.so.1", "file", b"ELF")])
        with self.assertRaises(SystemExit):
            unpack_debs.unpack(package, self.out)
        self.assertEqual((self.out / "libfoo.so.1").read_bytes(), b"already here")

    def test_refuses_a_link_that_leaves_the_directory(self):
        for target in ("/etc/passwd", "../../etc/passwd", "sub/libfoo.so.1", ".."):
            package = self.dir / "l.deb"
            deb(package, [(LIB + "libfoo.so.1", "symlink", target)])
            with self.assertRaises(SystemExit, msg=target):
                unpack_debs.unpack(package, self.out)
            self.assertEqual(list(self.out.iterdir()), [], target)

    def test_a_package_with_no_library_is_an_error(self):
        package = self.dir / "n.deb"
        deb(package, [("./usr/share/doc/foo/copyright", "file", b"text")])
        with self.assertRaises(SystemExit):
            unpack_debs.unpack(package, self.out)

    def test_an_odd_sized_member_before_the_data_is_padded_over(self):
        package = self.dir / "o.deb"
        deb(package, [(LIB + "libodd.so.0", "file", b"ELF")], marker=b"2.0 x")
        self.assertEqual(unpack_debs.unpack(package, self.out), ["libodd.so.0"])

    def test_refuses_a_member_that_is_neither_a_file_nor_a_symlink(self):
        package = self.dir / "h.deb"
        deb(package, [(LIB + "libhard.so.0", "hardlink", "libother.so.0")])
        with self.assertRaises(SystemExit):
            unpack_debs.unpack(package, self.out)

    def test_not_an_ar_archive_is_an_error(self):
        package = self.dir / "x.deb"
        package.write_bytes(b"PK\x03\x04 not a deb")
        with self.assertRaises(SystemExit):
            unpack_debs.unpack(package, self.out)


if __name__ == "__main__":
    unittest.main()
