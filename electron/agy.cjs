// Antigravity CLI (agy) runner for Ask AI: uses the person's own, unmodified `agy` installation
// signed in with their Google AI / Antigravity subscription. Folio never sees or stores their
// Google credentials; it runs `agy` in a private temporary folder with tools blocked and streams
// NDJSON responses over stdio.
const { execFile: defaultExecFile, spawn: defaultSpawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { claudePrompt } = require("./ai-prompt.cjs");
const { agyChildPath } = require("./agy-path.cjs");

const AGY_TIMEOUT_MS = 5 * 60_000;
const STATUS_TTL_MS = 30_000;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const validAgyModel = (id) => id === "" || (typeof id === "string" && /^[a-z\d][a-z\d._-]{0,127}$/i.test(id) && !id.includes(".."));

// Session-only override: lock permissions to strict and deny every tool category so untrusted
// document text cannot execute commands, read/write files, reach the network, or invoke MCP tools.
const AGY_SETTINGS = JSON.stringify({
  agentMode: "",
  toolPermission: "strict",
  allowNonWorkspaceAccess: false,
  disableSlashCommands: true,
  permissions: {
    allow: [],
    ask: [],
    deny: ["command(*)", "unsandboxed(*)", "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)"],
  },
});

/** Parses `agy models` output (`<slug>\t<Display Name>` or space-aligned columns). */
function parseAgyModels(output) {
  const seen = new Set();
  const models = [];
  for (const raw of String(output ?? "").split(/\r?\n/)) {
    const line = raw.replace(ANSI, "").trim();
    if (!line) continue;
    const match = /^([a-z\d][a-z\d._-]{0,127})(?:\t|\s{2,})(.+)$/i.exec(line);
    if (!match) continue;
    const id = match[1];
    const name = match[2].trim().slice(0, 160);
    if (!id || !validAgyModel(id) || !name || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name });
  }
  return models;
}

function agentDocument(systemPrompt) {
  return [
    "---",
    "name: folio",
    "description: Folio PDF reading assistant",
    "tools: []",
    "mainAgent: true",
    "subagent: false",
    "commandExecutionPolicy: off",
    "mcpServers: []",
    "skills: []",
    "plugins: []",
    "---",
    "",
    systemPrompt,
    "",
  ].join("\n");
}

function createAgy({
  dir,
  findExe,
  execFile = defaultExecFile,
  spawn = defaultSpawn,
  platform = process.platform,
  getEnv = () => process.env,
  timeoutMs = AGY_TIMEOUT_MS,
}) {
  let cachedPath;
  let statusCache = null;

  function locate(fresh = false) {
    if (fresh || cachedPath === undefined) cachedPath = findExe();
    return cachedPath;
  }

  function makeAgyDir() {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    return fs.mkdtempSync(path.join(dir(), "agy-"));
  }

  function agyEnv(exe) {
    const env = { ...getEnv() };
    delete env.ELECTRON_RUN_AS_NODE;
    if (exe && platform !== "win32") env.PATH = agyChildPath(env.PATH, exe);
    return env;
  }

  function run(exe, args, timeout = 10_000) {
    return new Promise((resolve) => {
      let cwd;
      try { cwd = makeAgyDir(); } catch { return resolve(null); }
      execFile(exe, args, { cwd, timeout, windowsHide: true, env: agyEnv(exe) }, (error, stdout) => {
        try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
        resolve(error ? null : String(stdout));
      });
    });
  }

  /** Removes prompt folders left behind if Folio or agy exited mid-answer. */
  function cleanStaleFolders() {
    try {
      for (const entry of fs.readdirSync(dir(), { withFileTypes: true })) {
        if (entry.isDirectory() && /^agy-[a-z0-9]{6}$/i.test(entry.name)) {
          fs.rmSync(path.join(dir(), entry.name), { recursive: true, force: true });
        }
      }
    } catch {}
  }

  async function status(fresh = false) {
    if (!fresh && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
    const exe = locate(fresh);
    let value = { installed: false, loggedIn: false, version: "", models: [] };
    if (exe) {
      const [verOut, modelsOut] = await Promise.all([run(exe, ["--version"], 10_000), run(exe, ["models"], 15_000)]);
      const version = verOut?.trim().split(/\s/)[0] ?? "";
      const models = parseAgyModels(modelsOut);
      value = { installed: true, version, loggedIn: modelsOut !== null && models.length > 0, models };
    }
    statusCache = { at: Date.now(), value };
    return value;
  }

  async function ask({ model = "", document, messages }, emit, signal) {
    const exe = locate();
    if (!exe) throw new Error("Antigravity CLI isn't installed.");
    if (!validAgyModel(model)) throw new Error("Choose a valid Antigravity model.");
    if (signal.aborted) return;
    const prompt = claudePrompt(document, messages);
    const cwd = makeAgyDir();
    const cleanup = () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} };
    try {
      const agentDir = path.join(cwd, ".agents", "agents", "folio");
      fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(agentDir, "agent.md"), agentDocument(prompt.system), { mode: 0o600 });
    } catch (error) {
      cleanup();
      throw error;
    }
    const args = [
      "--agent", "folio",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--disable-slash-commands",
      "--settings", AGY_SETTINGS,
    ];
    if (model) args.push("--model", model);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(exe, args, { cwd, env: agyEnv(exe), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        cleanup();
        return reject(error);
      }
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      const abort = () => child.kill();
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let buffer = "";
      let streamed = false;
      let result = null;
      let stderr = "";
      const consumeLine = (raw) => {
        const line = raw.trim();
        if (!line) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.event === "step_update" && event.step_update?.step_type === "agent_response"
          && typeof event.step_update.text_delta === "string" && event.step_update.text_delta) {
          streamed = true;
          emit(event.step_update.text_delta);
        } else if (event.event === "result" && event.result) {
          result = event.result;
        }
      };
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          consumeLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      });
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
      child.stdin.on("error", () => {});
      child.on("error", (error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); cleanup(); reject(error); });
      child.on("close", () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (buffer.trim()) consumeLine(buffer);
        cleanup();
        if (signal.aborted) return resolve();
        if (timedOut) return reject(new Error("Antigravity took too long to answer. Please try again."));
        if (result && result.status === "SUCCESS") {
          if (!streamed && typeof result.response === "string" && result.response) emit(result.response);
          return resolve();
        }
        const message = String(result?.error || stderr || "").trim();
        const firstLine = message.split(/\r?\n/).find((l) => l.trim()) || "";
        if (/auth|log ?in|sign ?in|logged in|credential|unauthenticated/i.test(message)) {
          return reject(new Error("Antigravity CLI isn't signed in. Open a terminal, run `agy`, and sign in with your Google account."));
        }
        if (/quota|limit|resource_exhausted|rate/i.test(message)) {
          return reject(Object.assign(new Error("You've reached your Antigravity usage limit. " + firstLine), { code: "usage_limit" }));
        }
        if (/invalid model|not recognized as a known model/i.test(message)) {
          return reject(new Error("Antigravity doesn't recognize that model. Choose another model and try again."));
        }
        reject(new Error(firstLine || "Antigravity couldn't answer."));
      });
      child.stdin.end(JSON.stringify({ event: "user", message: { content: prompt.input } }) + "\n");
    });
  }

  return { status, ask, cleanStaleFolders };
}

module.exports = { createAgy, parseAgyModels, validAgyModel, AGY_SETTINGS };
