// Finding the Claude Code CLI for Ask AI, and the PATH it runs with.
const fs = require("node:fs");
const path = require("node:path");

// Apps opened from the Dock, Finder, or a double-clicked PDF get launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), which
// leaves out where Homebrew, npm, and Claude Code's older local installer put `claude`.
const installFolders = (platform, home) =>
  platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".claude", "local")];

// On Windows, `npm install -g @anthropic-ai/claude-code` puts only a `claude.cmd` shim on PATH. The shim starts the
// package's native claude.exe, which npm keeps at this path inside the same folder.
const NPM_WINDOWS_EXE = path.join("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/**
 * Searches absolute folders only (never the current folder, which `where.exe` checks first), with Claude Code's default
 * install location first. Only native executables on Windows: .cmd/.bat shims would need a shell, so for an npm shim
 * Folio runs the claude.exe it points to instead.
 */
function findClaude({ platform, home, envPath, extraFolders = installFolders(platform, home) }) {
  const dirs = [path.join(home, ".local", "bin"), ...String(envPath ?? "").split(path.delimiter), ...extraFolders]
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter((d) => d && path.isAbsolute(d));
  const candidates = platform === "win32"
    ? dirs.flatMap((d) => [path.join(d, "claude.exe"), ...(isFile(path.join(d, "claude.cmd")) ? [path.join(d, NPM_WINDOWS_EXE)] : [])])
    : dirs.map((d) => path.join(d, "claude"));
  return candidates.find(isFile) ?? null;
}

/** An npm install's `claude` starts with `#!/usr/bin/env node`, and that `node` usually sits in the same folder. */
function claudeChildPath(envPath, exe) {
  const dir = path.dirname(exe);
  const dirs = String(envPath ?? "").split(path.delimiter).filter(Boolean);
  return dirs.includes(dir) ? envPath : [...dirs, dir].join(path.delimiter);
}

module.exports = { findClaude, claudeChildPath, installFolders };
