// Checks that a published Folio release is complete for every platform: all installers are attached, and every
// update feed (Windows, macOS, Linux AppImage, and the apt repository) offers that same version.
//
//   node scripts/check-release.mjs            # the latest release
//   node scripts/check-release.mjs v1.9.0     # a specific tag
//
// Exits non-zero and lists the problems if anything is missing or out of step. Used by scripts/release.mjs after
// publishing and by the daily "Release check" workflow.
import { pathToFileURL } from "node:url";

export const RELEASES_REPO = "Forward-Future/folio-releases";

/** The files produced by each release job, and the update feeds whose versions must match the release. */
export const RELEASE_ARTIFACTS = {
  "folio-windows": [
    { name: "Folio-Setup.exe" }, { name: "Folio-Setup.exe.blockmap" }, { name: "Folio-Portable.exe" },
    { name: "latest.yml", feed: "yaml" },
  ],
  "folio-macos": [
    { name: "Folio-mac.dmg" }, { name: "Folio-mac.dmg.blockmap" }, { name: "Folio-mac.zip" },
    { name: "Folio-mac.zip.blockmap" }, { name: "latest-mac.yml", feed: "yaml" },
  ],
  "folio-linux": [
    { name: "Folio-linux-x86_64.AppImage" }, { name: "Folio-linux-amd64.deb" }, { name: "latest-linux.yml", feed: "yaml" },
    { name: "Packages", feed: "apt" }, { name: "Packages.gz" }, { name: "Release" }, { name: "InRelease" }, { name: "Release.gpg" },
  ],
};
export const REQUIRED_ASSETS = Object.values(RELEASE_ARTIFACTS).flat();

const headers = { Accept: "application/vnd.github+json", "User-Agent": "folio-release-check" };
if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN || process.env.GH_TOKEN}`;

export async function checkRelease(tag = "latest") {
  const url = tag === "latest"
    ? `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`
    : `https://api.github.com/repos/${RELEASES_REPO}/releases/tags/${tag}`;
  const response = await fetch(url, { headers });
  if (!response.ok) return { tag, problems: [`Couldn't read the ${tag} release (${response.status}).`] };
  const release = await response.json();
  const version = release.tag_name.replace(/^v/, "");
  const assets = new Map(release.assets.map((a) => [a.name, a]));
  const problems = [];
  for (const required of REQUIRED_ASSETS) {
    const asset = assets.get(required.name);
    if (!asset) {
      problems.push(`${required.name} is missing.`);
      continue;
    }
    if (!required.feed) continue;
    const text = await (await fetch(asset.browser_download_url, { headers: { "User-Agent": headers["User-Agent"] } })).text();
    const found = required.feed === "yaml" ? /^version:\s*(\S+)/m.exec(text)?.[1] : /^Version:\s*(\S+)/m.exec(text)?.[1];
    if (found !== version) problems.push(`${required.name} offers version ${found ?? "(none)"}, not ${version}.`);
  }
  return { tag: release.tag_name, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { tag, problems } = await checkRelease(process.argv[2] ?? "latest");
  if (problems.length) {
    console.error(`Release ${tag} is incomplete:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`Release ${tag} is complete: every platform's installers and update feeds are at the same version.`);
}
