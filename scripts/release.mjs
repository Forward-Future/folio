// Publish a new Folio version: bump the version, build the Windows installers, upload them to the
// public GitHub repo mberman84/folio-releases, and push the source to mberman84/folio.
// Every installed copy picks the update up automatically (electron-updater reads latest.yml from the release).
//
//   npm run release                      # 1.0.0 -> 1.0.1
//   npm run release -- minor             # 1.0.0 -> 1.1.0
//   npm run release -- patch --notes "Faster search, fixed printing"
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const RELEASES_REPO = "mberman84/folio-releases";
const ASSETS = ["Folio-Setup.exe", "Folio-Setup.exe.blockmap", "latest.yml", "Folio-Portable.exe"];

const args = process.argv.slice(2);
const notesAt = args.indexOf("--notes");
const notes = notesAt >= 0 ? args[notesAt + 1] : "";
const bump = args.find((a, i) => !a.startsWith("--") && i !== notesAt + 1) || "patch";

// ELECTRON_RUN_AS_NODE (set by some hosts) makes Electron tooling behave like plain Node.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const run = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", env, ...opts });

if (execSync("git status --porcelain").toString().trim()) {
  console.error("Commit or stash your changes first — a release is built from committed code.");
  process.exit(1);
}

run(`npm version ${bump} -m "Release v%s"`);
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

// Build locally, then upload every asset in one step (electron-builder's own publisher races
// between the installer and portable targets when creating the GitHub release).
rmSync("release", { recursive: true, force: true });
run("npm run build");
run("npx electron-builder --win nsis portable --publish never");

const body = [
  notes || `Folio ${version}.`,
  "",
  "**Install:** download **Folio-Setup.exe** below and run it. Installed copies update themselves automatically.",
  "Prefer not to install? **Folio-Portable.exe** runs as-is (portable copies don't auto-update).",
].join("\n");
run(
  `gh release create v${version} --repo ${RELEASES_REPO} --title "Folio ${version}" --notes ${JSON.stringify(body)} ${ASSETS.join(" ")}`,
  { cwd: "release" },
);
run("git push --follow-tags");

console.log(`\nFolio ${version} is live: https://github.com/${RELEASES_REPO}/releases/tag/v${version}`);
console.log("Installed copies will download it within a few hours (or on next launch).");
