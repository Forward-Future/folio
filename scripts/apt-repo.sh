#!/usr/bin/env bash
# Turns release/Folio-linux-amd64.deb into a signed "flat" apt repository, published alongside it on each
# GitHub release. Installed .deb copies point apt at
#   deb [signed-by=/usr/share/keyrings/folio-archive-keyring.gpg] https://github.com/Forward-Future/folio-releases/releases/latest/download ./
# so `apt update && apt upgrade` (or the desktop's software updater) installs new Folio versions.
#
# Needs dpkg-dev, apt-utils, and gnupg, plus the armored private signing key in $APT_SIGNING_KEY.
# Writes release/Packages, Packages.gz, Release, InRelease, and Release.gpg.
set -euo pipefail
cd "$(dirname "$0")/../release"
: "${APT_SIGNING_KEY:?APT_SIGNING_KEY (armored private key) is required}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp Folio-linux-amd64.deb "$work/"
(cd "$work" && dpkg-scanpackages --multiversion . /dev/null > Packages 2>/dev/null)
gzip -9nc "$work/Packages" > "$work/Packages.gz"
(cd "$work" && apt-ftparchive \
  -o APT::FTPArchive::Release::Origin="Folio" \
  -o APT::FTPArchive::Release::Label="Folio" \
  -o APT::FTPArchive::Release::Suite="stable" \
  -o APT::FTPArchive::Release::Codename="stable" \
  -o APT::FTPArchive::Release::Architectures="amd64" \
  -o APT::FTPArchive::Release::Description="Folio PDF reader" \
  release . > Release)

export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import
gpg --batch --yes --pinentry-mode loopback --passphrase '' --clearsign -o "$work/InRelease" "$work/Release"
gpg --batch --yes --pinentry-mode loopback --passphrase '' --armor --detach-sign -o "$work/Release.gpg" "$work/Release"

cp "$work/Packages" "$work/Packages.gz" "$work/Release" "$work/InRelease" "$work/Release.gpg" .
grep -E "^(Package|Version|Filename|Size):" Packages
