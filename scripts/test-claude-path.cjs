const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { findClaude, claudeChildPath, installFolders } = require("../electron/claude-path.cjs");

const GUI_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);

function folder(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-claude-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeClaude(dir, name = "claude", contents = "#!/bin/sh\necho 1.0.0\n") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), contents, { mode: 0o755 });
  return path.join(dir, name);
}

test("finds Claude Code in a Homebrew or npm folder when the app gets the Dock's PATH", (t) => {
  const root = folder(t), home = path.join(root, "home"), brew = path.join(root, "homebrew", "bin");
  const exe = fakeClaude(brew);
  const local = path.join(home, ".claude", "local");
  assert.equal(findClaude({ platform: "darwin", home, envPath: GUI_PATH, extraFolders: [local, brew] }), exe);
  assert.equal(findClaude({ platform: "linux", home, envPath: GUI_PATH, extraFolders: [brew] }), exe);
  assert.equal(findClaude({ platform: "darwin", home, envPath: GUI_PATH, extraFolders: [] }), null);
});

test("macOS and Linux also look where Homebrew, npm, and the older local installer put claude; Windows doesn't", () => {
  const home = path.join(path.sep, "Users", "someone");
  const expected = ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".claude", "local")];
  assert.deepEqual(installFolders("darwin", home), expected);
  assert.deepEqual(installFolders("linux", home), expected);
  assert.deepEqual(installFolders("win32", home), []);
});

test("looks in the older local install by default", { skip: ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].some(fs.existsSync) }, (t) => {
  const home = path.join(folder(t), "home");
  const local = path.join(home, ".claude", "local");
  const exe = fakeClaude(local);
  fakeClaude(local, "claude.exe");
  assert.equal(findClaude({ platform: "darwin", home, envPath: GUI_PATH }), exe);
  assert.equal(findClaude({ platform: "win32", home, envPath: GUI_PATH }), null);
});

test("Claude Code's own install folder and then PATH come before the extra folders", (t) => {
  const root = folder(t), home = path.join(root, "home");
  const first = path.join(root, "first"), later = path.join(root, "later"), extra = path.join(root, "extra");
  fakeClaude(later);
  fakeClaude(extra);
  const exe = fakeClaude(first);
  const envPath = [first, later, GUI_PATH].join(path.delimiter);
  assert.equal(findClaude({ platform: "darwin", home, envPath, extraFolders: [extra] }), exe);
  const own = fakeClaude(path.join(home, ".local", "bin"));
  assert.equal(findClaude({ platform: "darwin", home, envPath, extraFolders: [extra] }), own);
});

test("never looks in the current folder or relative PATH entries", (t) => {
  const root = folder(t), home = path.join(root, "home");
  fakeClaude(root);
  fakeClaude(path.join(root, "bin"));
  fakeClaude(root, "claude.exe");
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const envPath = [".", "bin", "", GUI_PATH].join(path.delimiter);
    assert.equal(findClaude({ platform: "darwin", home, envPath, extraFolders: [] }), null);
    assert.equal(findClaude({ platform: "win32", home, envPath, extraFolders: ["bin"] }), null);
  } finally {
    process.chdir(cwd);
  }
});

test("Windows only runs claude.exe, never a .cmd shim", (t) => {
  const root = folder(t), home = path.join(root, "home"), npm = path.join(root, "npm");
  fakeClaude(npm, "claude.cmd");
  fakeClaude(npm);
  assert.equal(findClaude({ platform: "win32", home, envPath: npm }), null);
  const exe = fakeClaude(npm, "claude.exe");
  assert.equal(findClaude({ platform: "win32", home, envPath: npm }), exe);
});

test("Claude Code's folder is added to its PATH once", () => {
  const dir = path.join(path.sep, "opt", "homebrew", "bin");
  const exe = path.join(dir, "claude");
  const withDir = claudeChildPath(GUI_PATH, exe);
  assert.equal(withDir, [GUI_PATH, dir].join(path.delimiter));
  assert.equal(claudeChildPath(withDir, exe), withDir);
  const terminal = [dir, GUI_PATH].join(path.delimiter);
  assert.equal(claudeChildPath(terminal, exe), terminal);
  assert.equal(claudeChildPath(undefined, exe), dir);
});

test("an npm install's script finds the node beside it", { skip: process.platform === "win32" }, (t) => {
  const bin = path.join(folder(t), "bin");
  const exe = fakeClaude(bin, "claude", '#!/usr/bin/env node\nconsole.log("1.0.0 (Claude Code)");\n');
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  if (!GUI_PATH.split(path.delimiter).some((d) => fs.existsSync(path.join(d, "node")))) {
    assert.throws(() => execFileSync(exe, ["--version"], { env: { PATH: GUI_PATH }, stdio: "pipe" }));
  }
  const out = execFileSync(exe, ["--version"], { env: { PATH: claudeChildPath(GUI_PATH, exe) }, encoding: "utf8" });
  assert.equal(out.trim(), "1.0.0 (Claude Code)");
});
