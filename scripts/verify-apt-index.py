"""Check the signed Release -> Packages/Packages.gz -> .deb hash and version chain."""

import gzip
import hashlib
import json
import subprocess
import sys
from email.parser import Parser
from pathlib import Path


def stanza(text, label):
    record = Parser().parsestr(text)
    if record.defects or record.get_payload():
        sys.exit(f"{label} must contain one Debian control stanza")
    return record


def digest_and_size(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest(), str(path.stat().st_size)


metadata, deb, manifest = map(Path, sys.argv[1:])
release = stanza((metadata / "Release").read_text(), "Release")
sections = release.get_all("SHA256", [])
if len(sections) != 1:
    sys.exit("Release must contain one SHA256 section")
entries = [line.split() for line in sections[0].splitlines() if line.strip()]
for name in ("Packages", "Packages.gz"):
    checksum, size = digest_and_size(metadata / name)
    if [entry for entry in entries if entry[-1] == name] != [[checksum, size, name]]:
        sys.exit(f"Signed Release does not match {name}'s SHA256 and size")

index = (metadata / "Packages").read_bytes()
if gzip.decompress((metadata / "Packages.gz").read_bytes()) != index:
    sys.exit("Packages.gz and Packages have different contents")
package = stanza(index.decode(), "Packages")
app = json.loads(manifest.read_text())
identity = {"Package": app["name"], "Version": app["version"], "Architecture": "amd64"}
checksum, size = digest_and_size(deb)
for field, value in {**identity, "Filename": f"./{deb.name}", "Size": size, "SHA256": checksum}.items():
    if package.get_all(field) != [value]:
        sys.exit(f"Signed Packages {field} must be {value!r}")
control = stanza(subprocess.check_output(["dpkg-deb", "--field", deb], text=True), ".deb control")
for field, value in identity.items():
    if control.get_all(field) != [value]:
        sys.exit(f".deb {field} must be {value!r}")
print(f"Verified {deb.name} {app['version']} ({size} bytes, SHA256 {checksum})")
