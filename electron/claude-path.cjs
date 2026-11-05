// Finding the Claude Code CLI for Ask AI, and the PATH it runs with.
const fs = require("node:fs");
const path = require("node:path");

// Apps opened from the Dock, Finder, or a double-clicked PDF get launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), which
// leaves out where Homebrew, npm, and Claude Code's older local installer put `claude`.
const installFolders = (platform, home) =>
  platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".claude", "local")];

/**
 * Searches absolute folders only (never the current folder, which `where.exe` checks first), with Claude Code's default
 * install location first. Only native executables on Windows: .cmd/.bat shims would need a shell.
 */
function findClaude({ platform, home, envPath, extraFolders = installFolders(platform, home) }) {
  const name = platform === "win32" ? "claude.exe" : "claude";
  const dirs = [path.join(home, ".local", "bin"), ...String(envPath ?? "").split(path.delimiter), ...extraFolders]
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter((d) => d && path.isAbsolute(d));
  return dirs.map((d) => path.join(d, name)).find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) ?? null;
}

/** An npm install's `claude` starts with `#!/usr/bin/env node`, and that `node` usually sits in the same folder. */
function claudeChildPath(envPath, exe) {
  const dir = path.dirname(exe);
  const dirs = String(envPath ?? "").split(path.delimiter).filter(Boolean);
  return dirs.includes(dir) ? envPath : [...dirs, dir].join(path.delimiter);
}

module.exports = { findClaude, claudeChildPath, installFolders };
