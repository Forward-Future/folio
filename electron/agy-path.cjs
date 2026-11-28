// Finding the Antigravity CLI (agy) for Ask AI, and the PATH it runs with.
const fs = require("node:fs");
const path = require("node:path");

// Apps opened from the Dock, Finder, or a double-clicked PDF get launchd's minimal PATH,
// which leaves out Homebrew and user-local install folders.
const installFolders = (platform, home, localAppData) => {
  if (platform === "win32") {
    const base = localAppData || path.join(home, "AppData", "Local");
    return [path.join(base, "agy", "bin")];
  }
  return ["/opt/homebrew/bin", "/usr/local/bin"];
};

const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/**
 * Searches absolute folders only (never the current folder, which `where.exe` checks first),
 * with Antigravity's default install locations first. Only native `agy.exe` on Windows (no .cmd/.bat shims).
 */
function findAgy({ platform, home, localAppData, envPath, extraFolders = installFolders(platform, home, localAppData) }) {
  const defaults = platform === "win32"
    ? [...extraFolders, path.join(home, ".local", "bin")]
    : [path.join(home, ".local", "bin")];
  const trailing = platform === "win32" ? [] : extraFolders;
  const dirs = [...defaults, ...String(envPath ?? "").split(path.delimiter), ...trailing]
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter((d) => d && path.isAbsolute(d));
  const binary = platform === "win32" ? "agy.exe" : "agy";
  return dirs.map((d) => path.join(d, binary)).find(isFile) ?? null;
}

/** Keeps the CLI's own folder on PATH once on macOS and Linux. */
function agyChildPath(envPath, exe) {
  const dir = path.dirname(exe);
  const dirs = String(envPath ?? "").split(path.delimiter).filter(Boolean);
  return dirs.includes(dir) ? envPath : [...dirs, dir].join(path.delimiter);
}

module.exports = { findAgy, agyChildPath, installFolders };
