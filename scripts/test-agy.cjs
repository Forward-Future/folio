const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { findAgy, agyChildPath, installFolders } = require("../electron/agy-path.cjs");
const { createAgy, parseAgyModels, validAgyModel, AGY_SETTINGS } = require("../electron/agy.cjs");

const GUI_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);

function folder(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folio-agy-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeAgy(dir, name = "agy", contents = "#!/bin/sh\necho 1.5.18\n") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), contents, { mode: 0o755 });
  return path.join(dir, name);
}

test("finds agy in ~/.local/bin, PATH, Homebrew, or Windows AppData\\Local\\agy\\bin", (t) => {
  const root = folder(t), home = path.join(root, "home"), brew = path.join(root, "homebrew", "bin");
  const exe = fakeAgy(brew);
  assert.equal(findAgy({ platform: "darwin", home, envPath: GUI_PATH, extraFolders: [brew] }), exe);
  assert.equal(findAgy({ platform: "linux", home, envPath: GUI_PATH, extraFolders: [brew] }), exe);
  const local = fakeAgy(path.join(home, ".local", "bin"));
  assert.equal(findAgy({ platform: "darwin", home, envPath: GUI_PATH, extraFolders: [brew] }), local);

  const localAppData = path.join(root, "AppData", "Local");
  const winExe = fakeAgy(path.join(localAppData, "agy", "bin"), "agy.exe");
  assert.equal(findAgy({ platform: "win32", home, localAppData, envPath: "" }), winExe);
  assert.deepEqual(installFolders("win32", home, localAppData), [path.join(localAppData, "agy", "bin")]);
  assert.deepEqual(installFolders("darwin", home), ["/opt/homebrew/bin", "/usr/local/bin"]);
});

test("never looks in relative PATH entries and ignores Windows .cmd shims", (t) => {
  const root = folder(t), home = path.join(root, "home");
  fakeAgy(root);
  fakeAgy(root, "agy.exe");
  fakeAgy(path.join(root, "winbin"), "agy.cmd");
  const cwd = process.cwd();
  process.chdir(root);
  try {
    assert.equal(findAgy({ platform: "darwin", home, envPath: [".", "bin", "", GUI_PATH].join(path.delimiter), extraFolders: [] }), null);
    assert.equal(findAgy({ platform: "win32", home, localAppData: path.join(root, "empty"), envPath: path.join(root, "winbin"), extraFolders: [] }), null);
  } finally { process.chdir(cwd); }
});

test("agyChildPath appends the executable folder once", () => {
  const dir = path.join(path.sep, "opt", "homebrew", "bin");
  const exe = path.join(dir, "agy");
  assert.equal(agyChildPath(GUI_PATH, exe), [GUI_PATH, dir].join(path.delimiter));
  assert.equal(agyChildPath([dir, GUI_PATH].join(path.delimiter), exe), [dir, GUI_PATH].join(path.delimiter));
  assert.equal(agyChildPath(undefined, exe), dir);
});

test("parseAgyModels parses tab-separated, space-aligned, and ANSI output and filters invalid slugs", () => {
  const raw = [
    "\x1b[2Kgemini-4-neon-high\tGemini 4 Neon (High)",
    "gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)",
    "gemini-4-neon-high\tDuplicate",
    "../bad-slug\tBad",
    "not a model line",
    "",
  ].join("\n");
  assert.deepEqual(parseAgyModels(raw), [
    { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  ]);
  assert.equal(validAgyModel(""), true);
  assert.equal(validAgyModel("gemini-4-neon-high"), true);
  assert.equal(validAgyModel("--dangerously-skip-permissions"), false);
  assert.equal(validAgyModel("../etc"), false);
});

test("status detects installed, signed-out, and signed-in agy and caches results", async (t) => {
  const root = folder(t);
  let exe = null, modelsOut = "gemini-4-neon-high\tGemini 4 Neon (High)\n", modelsErr = null, calls = 0;
  const agy = createAgy({
    dir: () => root,
    findExe: () => exe,
    execFile: (_cmd, args, _opts, cb) => {
      calls++;
      if (args[0] === "--version") return cb(null, "1.5.18\n");
      if (args[0] === "models") return modelsErr ? cb(modelsErr, "") : cb(null, modelsOut);
      cb(new Error("unexpected"));
    },
  });
  assert.deepEqual(await agy.status(), { installed: false, loggedIn: false, version: "", models: [] });
  exe = "/fake/agy";
  modelsErr = new Error("authentication required");
  assert.deepEqual(await agy.status(true), { installed: true, loggedIn: false, version: "1.5.18", models: [] });
  modelsErr = null;
  const signedIn = await agy.status(true);
  assert.deepEqual(signedIn, {
    installed: true, loggedIn: true, version: "1.5.18",
    models: [{ id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" }],
  });
  const before = calls;
  assert.deepEqual(await agy.status(), signedIn);
  assert.equal(calls, before, "cached status does not respawn agy");
});

test("ask isolates system prompt in a no-tools agent, streams deltas, blocks bad models, and cleans up", async (t) => {
  const root = folder(t);
  const stale = path.join(root, "agy-abc123");
  fs.mkdirSync(stale, { recursive: true });
  const runs = [];
  const makeChild = (handler) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit("close", 1); };
    let stdinData = "";
    child.stdin.on("data", chunk => { stdinData += chunk.toString("utf8"); });
    child.stdin.on("finish", () => handler(child, stdinData));
    return child;
  };
  let nextHandler;
  const agy = createAgy({
    dir: () => root,
    findExe: () => "/fake/agy",
    spawn: (exe, args, opts) => {
      const agentFile = path.join(opts.cwd, ".agents", "agents", "folio", "agent.md");
      runs.push({ exe, args, cwd: opts.cwd, env: opts.env, agentMd: fs.readFileSync(agentFile, "utf8") });
      return makeChild(nextHandler);
    },
  });
  agy.cleanStaleFolders();
  assert.equal(fs.existsSync(stale), false);

  const doc = { name: "Report.pdf", text: "[Page 1]\nSECRET_PDF_TEXT", truncated: false, recognized: true };
  const messages = [{ role: "user", content: "Summarize it." }];

  await assert.rejects(agy.ask({ model: "--bad", document: doc, messages }, () => {}, new AbortController().signal), /valid Antigravity model/);

  let receivedStdin = "";
  nextHandler = (child, stdinData) => {
    receivedStdin = stdinData;
    child.stdout.write('{"event":"init","conversation_id":"1"}\n');
    child.stdout.write('{"event":"step_update","step_update":{"step_type":"agent_response","state":"ACTIVE","text_delta":"Answer "}}\n');
    child.stdout.write('{"event":"step_update","step_update":{"step_type":"agent_response","state":"DONE","text_delta":"(p. 1)."}}\n');
    child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"Answer (p. 1)."}}\n');
    child.stdout.end();
    child.emit("close", 0);
  };
  const chunks = [];
  await agy.ask({ model: "gemini-4-neon-high", document: doc, messages }, text => chunks.push(text), new AbortController().signal);
  assert.deepEqual(chunks, ["Answer ", "(p. 1)."]);
  assert.equal(runs.length, 1);
  assert.ok(runs[0].args.includes("--agent") && runs[0].args.includes("folio"));
  assert.ok(runs[0].args.includes("--disable-slash-commands"));
  assert.ok(runs[0].args.includes("--settings") && runs[0].args.includes(AGY_SETTINGS));
  assert.ok(runs[0].args.includes("--model") && runs[0].args.includes("gemini-4-neon-high"));
  assert.equal(runs[0].env.ELECTRON_RUN_AS_NODE, undefined);
  assert.match(runs[0].agentMd, /tools: \[\]/);
  assert.match(runs[0].agentMd, /commandExecutionPolicy: off/);
  assert.match(runs[0].agentMd, /untrusted data/);
  assert.match(runs[0].agentMd, /recognition errors/);
  assert.doesNotMatch(runs[0].agentMd, /SECRET_PDF_TEXT/, "document text never enters system prompt");
  const payload = JSON.parse(receivedStdin.trim());
  assert.equal(payload.event, "user");
  assert.deepEqual(JSON.parse(payload.message.content), { document: doc, conversation: messages });
  assert.equal(fs.existsSync(runs[0].cwd), false, "temporary folder removed after close");

  // Auth, quota, and abort handling.
  nextHandler = (child) => {
    child.stdout.end('{"event":"result","result":{"status":"ERROR","error":"authentication required"}}\n');
    child.emit("close", 1);
  };
  await assert.rejects(agy.ask({ model: "", document: doc, messages }, () => {}, new AbortController().signal), /run `agy`/);

  nextHandler = (child) => {
    child.stdout.end('{"event":"result","result":{"status":"ERROR","error":"RESOURCE_EXHAUSTED: quota exceeded"}}\n');
    child.emit("close", 1);
  };
  await assert.rejects(agy.ask({ model: "", document: doc, messages }, () => {}, new AbortController().signal), /usage limit/);

  const controller = new AbortController();
  let abortedChild;
  nextHandler = (child) => {
    abortedChild = child;
    controller.abort();
  };
  await agy.ask({ model: "", document: doc, messages }, () => {}, controller.signal);
  assert.equal(abortedChild.killed, true);
});
