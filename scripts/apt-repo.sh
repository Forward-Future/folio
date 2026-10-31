#!/usr/bin/env bash
# Build the release .deb's signed flat apt repository, or independently check downloaded artifacts:
#   bash scripts/apt-repo.sh
#   bash scripts/apt-repo.sh --verify-only /path/to/release
# Requires dpkg-dev, apt-utils, gnupg and python3. Only building needs $APT_SIGNING_KEY.
set +x
set -euo pipefail
export -n APT_SIGNING_KEY
repo=$(cd "$(dirname "$0")/.." && pwd)
old=B3376868EE2283896C2B8ABDC455276CCAE03757
successor=01AF1CBF971E5482C0641A6EEE0067F5E3B548FC
old_keyring_sha256=0db7d3c67250b9fe85b973caa32a686945bfc49f5a4c84848ce592e6ae103b9a
# Keep signing with the installed clients' key throughout the bridge. At cutover change
# this to $successor together with the protected secret. Both public keys can remain installed.
signer=$old
keyring="$repo/build/linux/folio-archive-keyring.gpg"
deb=Folio-linux-amd64.deb
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [[ $# == 0 ]]; then
  : "${APT_SIGNING_KEY:?APT_SIGNING_KEY (armored private key) is required}"
  artifacts="$repo/release"
  metadata="$work/repo"
  mkdir "$metadata"
  cp "$artifacts/$deb" "$metadata/"
  (cd "$metadata" && dpkg-scanpackages --multiversion . /dev/null > Packages)
  gzip -9nc "$metadata/Packages" > "$metadata/Packages.gz"
  (cd "$metadata" && apt-ftparchive \
    -o APT::FTPArchive::Release::Origin="Folio" \
    -o APT::FTPArchive::Release::Label="Folio" \
    -o APT::FTPArchive::Release::Suite="stable" \
    -o APT::FTPArchive::Release::Codename="stable" \
    -o APT::FTPArchive::Release::Architectures="amd64" \
    -o APT::FTPArchive::Release::Description="Folio PDF reader" \
    release . > "$work/Release")
  mv "$work/Release" "$metadata/Release"

  export GNUPGHOME="$work/signing"
  mkdir -m 700 "$GNUPGHOME"
  printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import
  unset APT_SIGNING_KEY
  sign=(gpg --batch --yes --pinentry-mode loopback --passphrase '' --local-user "$signer")
  "${sign[@]}" --clearsign -o "$metadata/InRelease" "$metadata/Release"
  "${sign[@]}" --armor --detach-sign -o "$metadata/Release.gpg" "$metadata/Release"
elif [[ $# == 2 && $1 == --verify-only ]]; then
  artifacts=$(cd -- "$2" && pwd)
  metadata=$artifacts
else
  echo "Usage: $0 [--verify-only ARTIFACT_DIRECTORY]" >&2
  exit 2
fi

export GNUPGHOME="$work/verification"
mkdir -m 700 "$GNUPGHOME"
fail() { echo "$*" >&2; exit 1; }
primary_fingerprints() {
  gpg --batch --with-colons --show-keys "$1" | awk -F: '
    $1 == "sec" || $1 == "ssb" { exit 1 }
    $1 == "pub" { primary = 1 }
    $1 == "fpr" && primary { print $10; primary = 0 }
  ' | LC_ALL=C sort
}
actual=$(primary_fingerprints "$keyring") || fail "Could not read the public archive keyring"
expected=$(printf '%s\n' "$old" "$successor" | LC_ALL=C sort)
[[ $actual == "$expected" ]] || fail "Archive keyring does not contain exactly the two pinned public keys"
gpg --batch --dearmor --output "$work/dearmored.gpg" "$repo/build/linux/folio-archive-keyring.asc"
cmp "$keyring" "$work/dearmored.gpg" || fail "Armored and binary archive keyrings differ"

# An installed pre-bridge client trusts only the old key. A signature by the successor
# would verify against the combined package keyring but would strand that client.
gpg --batch --quiet --import "$keyring"
gpg --batch --export "$signer" > "$work/signer.gpg"
actual=$(primary_fingerprints "$work/signer.gpg")
[[ $actual == "$signer" ]] || fail "Could not isolate the pinned signing key"
if [[ $signer == "$old" ]]; then
  # The exact pre-bridge certificate also excludes any signing subkey old clients never received.
  printf '%s  %s\n' "$old_keyring_sha256" "$work/signer.gpg" | sha256sum --check --status \
    || fail "The signer's certificate differs from the keyring installed before the bridge"
fi
gpgv --keyring "$work/signer.gpg" --output "$work/verified-Release" "$metadata/InRelease"
cmp "$work/verified-Release" "$metadata/Release" || fail "InRelease and Release have different contents"
gpgv --keyring "$work/signer.gpg" "$metadata/Release.gpg" "$metadata/Release"
python3 "$repo/scripts/verify-apt-index.py" "$metadata" "$artifacts/$deb" "$repo/package.json"
dpkg-deb --fsys-tarfile "$artifacts/$deb" | tar -xO ./opt/Folio/resources/folio-archive-keyring.gpg > "$work/packaged.gpg"
cmp "$keyring" "$work/packaged.gpg" || fail "The .deb's keyring differs from the checked-in public keyring"

if [[ $# == 0 ]]; then
  cp "$metadata"/{Packages,Packages.gz,Release,InRelease,Release.gpg} "$artifacts/"
fi
echo "Verified both apt signatures with $signer and the packaged keyring with $old and $successor"
