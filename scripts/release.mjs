// Publish a new Folio version: bump the version, build the Windows installers, upload them to the
// public GitHub repo mberman84/folio-releases, and push the source to mberman84/folio.
// Every installed copy picks the update up automatically.
//
//   npm run release                      # 1.0.0 -> 1.0.1
//   npm run release -- minor             # 1.0.0 -> 1.1.0
//   npm run release -- patch --notes "Faster search, fixed printing"
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const notesAt = args.indexOf("--notes");
const notes = notesAt >= 0 ? args[notesAt + 1] : "";
const bump = args.find((a, i) => !a.startsWith("--") && i !== notesAt + 1) || "patch";

const run = (cmd, env) => execSync(cmd, { stdio: "inherit", env: env ?? process.env });

if (execSync("git status --porcelain").toString().trim()) {
  console.error("Commit or stash your changes first — a release is built from committed code.");
  process.exit(1);
}

run(`npm version ${bump} -m "Release v%s"`);
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

// electron-builder uploads with GH_TOKEN; reuse the GitHub CLI login. ELECTRON_RUN_AS_NODE breaks Electron tooling.
const env = { ...process.env, GH_TOKEN: execSync("gh auth token").toString().trim() };
delete env.ELECTRON_RUN_AS_NODE;
run("npm run build", env);
run("npx electron-builder --win nsis portable --publish always", env);

if (notes) run(`gh release edit v${version} --repo mberman84/folio-releases --notes ${JSON.stringify(notes)}`);
run("git push --follow-tags");

console.log(`\nFolio ${version} is live: https://github.com/mberman84/folio-releases/releases/tag/v${version}`);
