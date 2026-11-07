// The Electron binary a test script launches; `env` is the environment the script gives the app.
//
// macOS decides whether an app gets a Dock icon from the Info.plist of the bundle its binary sits in, as the process
// starts and before any of Folio's code runs. Launched from the ordinary Electron.app, a hidden run made the Dock open
// a slot for an icon for about a second, until main.cjs took it away. So on macOS hidden runs start a copy of
// Electron.app whose Info.plist says it is an agent app (LSUIElement), which never has a Dock icon. The copy is kept
// beside the electron package and made again when the Electron version changes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export function electronPath(env) {
  const executable = require("electron");
  if (process.platform !== "darwin" || env.FOLIO_TEST_HIDDEN !== "1") return executable;

  const bundle = executable.slice(0, executable.lastIndexOf(".app/") + ".app".length);
  const version = readFileSync(path.join(path.dirname(bundle), "version"), "utf8").trim();
  const cache = path.join(path.dirname(require.resolve("electron/package.json")), "..", ".cache", "folio-hidden-electron");
  const copy = path.join(cache, version);
  const hidden = path.join(copy, path.relative(path.dirname(bundle), executable));
  if (existsSync(hidden)) return hidden;

  mkdirSync(cache, { recursive: true });
  for (const name of readdirSync(cache)) {
    if (name !== version && !name.startsWith(`${version}.`)) rmSync(path.join(cache, name), { recursive: true, force: true });
  }
  // Built under another name and moved into place, so a copy that exists is complete, also when two scripts start
  // at once or one is stopped halfway.
  const building = `${copy}.${process.pid}`;
  try {
    mkdirSync(building);
    // -c clones the files where the disk can (APFS), which takes a moment and no space; elsewhere cp copies them.
    execFileSync("/bin/cp", ["-c", "-R", bundle, building]);
    execFileSync("/usr/bin/plutil", ["-replace", "LSUIElement", "-bool", "YES", path.join(building, path.basename(bundle), "Contents", "Info.plist")]);
    try { renameSync(building, copy); }
    catch (error) { if (!existsSync(hidden)) throw error; }
  } finally {
    rmSync(building, { recursive: true, force: true });
  }
  return hidden;
}
