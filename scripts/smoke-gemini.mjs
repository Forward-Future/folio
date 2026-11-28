import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";

// Use only a synthetic PDF, key, and local responses. The production IPC, stream reader and citations run as usual.
export async function checkGemini(app, page) {
  const pdf = await PDFDocument.create();
  pdf.addPage([480, 520]).drawText("Observatory log", { x: 38, y: 435, size: 28 });
  pdf.addPage([480, 520]).drawText("The comet reaches perihelion in April.", { x: 38, y: 435, size: 20 });
  const bytes = Buffer.from(await pdf.save()).toString("base64");
  await app.evaluate(({ webContents, net, safeStorage }, bytes) => {
    const target = webContents.getAllWebContents().find(c => c.getURL().startsWith("app://folio/"));
    const fetch = net.fetch;
    const methods = ["isAsyncEncryptionAvailable", "encryptStringAsync", "decryptStringAsync"];
    if (process.platform === "linux") methods.push("getSelectedStorageBackend");
    const original = Object.fromEntries(methods.map(name => [name, safeStorage[name]]));
    safeStorage.isAsyncEncryptionAvailable = async () => true;
    if (process.platform === "linux") safeStorage.getSelectedStorageBackend = () => "gnome_libsecret";
    safeStorage.encryptStringAsync = async value => Buffer.from(value).map(b => b ^ 128);
    safeStorage.decryptStringAsync = async bytes => ({ result: Buffer.from(bytes).map(b => b ^ 128).toString() });
    const state = globalThis.geminiTest = { calls: [], cancelled: false, hold: false };
    net.fetch = async (url, options) => {
      if (!String(url).startsWith("https://generativelanguage.googleapis.com/")) return fetch.call(net, url, options);
      const parsed = new URL(url);
      state.calls.push(parsed.pathname);
      if (parsed.searchParams.has("key")) throw new Error("Gemini key leaked in URL");
      if (options.headers["x-goog-api-key"] !== "fixture-only-gemini-key") {
        return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }, { status: 400 });
      }
      if (parsed.pathname === "/v1beta/models") {
        return Response.json({
          models: [
            { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1_048_576, supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: 1_048_576, supportedGenerationMethods: ["generateContent"] },
          ],
        });
      }
      if (!parsed.pathname.endsWith(":streamGenerateContent")) throw new Error("Unexpected Gemini endpoint");
      state.request = JSON.parse(options.body);
      if (state.hold) return new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener("abort", () => { state.cancelled = true; controller.error(new Error("Stopped")); }, { once: true });
      } }));
      return new Response('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"internal thought","thought":true},{"text":"The comet reaches perihelion in April "}]}}]}\n\n'
        + 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"(p. 2)."}]},"finishReason":"STOP"}]}\n\n');
    };
    state.restore = () => { net.fetch = fetch; Object.assign(safeStorage, original); };
    target.send("folio:open-file", { name: "Observatory log.pdf", data: Buffer.from(bytes, "base64") });
  }, bytes);
  try {
    await page.window.waitForFunction(() => document.title.startsWith("Observatory log.pdf"));
    const panel = page.getByRole("complementary", { name: "Ask AI" });
    if (!(await panel.count())) await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    const provider = panel.getByRole("combobox", { name: "AI provider" });
    await provider.selectOption("gemini");
    // Gemini defaults to Antigravity subscription; switch to API key mode through Settings.
    const agySetup = panel.getByRole("button", { name: "Or use a Gemini API key" });
    if (await agySetup.count()) {
      await agySetup.click();
    } else {
      await panel.getByText("Using Antigravity").waitFor();
      await page.getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: /Settings/ }).click();
    }
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.waitFor();
    await settings.getByRole("button", { name: "Ask AI", exact: true }).click();
    assert.equal(await settings.getByRole("button", { name: "Ask AI", exact: true }).getAttribute("aria-current"), "page");
    await settings.getByRole("radio", { name: "Antigravity" }).click();
    await settings.getByRole("button", { name: "Check again" }).waitFor();
    await settings.getByRole("radio", { name: "API key" }).click();
    assert.deepEqual(await app.evaluate(() => globalThis.geminiTest.calls), []);
    await settings.getByLabel("API key", { exact: true }).fill("fixture-only-gemini-key");
    await settings.getByRole("button", { name: "Verify and save" }).click();
    const filter = settings.getByRole("searchbox", { name: "Model" });
    await filter.fill("flash");
    await settings.getByRole("button", { name: /Gemini 2\.5 Flash/ }).click();
    assert.deepEqual(await app.evaluate(() => globalThis.geminiTest.calls), ["/v1beta/models", "/v1beta/models"]);
    await settings.getByRole("button", { name: "Close" }).click();
    await panel.getByText("Billed by Google").waitFor();
    await panel.getByRole("textbox").fill("When does the comet reach perihelion?");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await panel.getByRole("button", { name: "(p. 2)" }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === "2");
    assert.equal(await panel.getByText("internal thought").count(), 0);
    const request = await app.evaluate(() => globalThis.geminiTest.request);
    assert.match(JSON.parse(request.contents[0].parts[0].text).document.text, /\[Page 2\]/);
    await app.evaluate(() => { globalThis.geminiTest.hold = true; });
    await panel.getByRole("textbox").fill("Continue");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    for (let i = 0; i < 100 && !(await app.evaluate(() => globalThis.geminiTest.calls.filter(c => c.endsWith(":streamGenerateContent")).length === 2)); i++) await page.waitForTimeout(50);
    await panel.getByRole("button", { name: "Stop" }).click();
    await panel.getByRole("button", { name: "Send", exact: true }).waitFor();
    assert.ok(await app.evaluate(() => globalThis.geminiTest.cancelled));
    await provider.selectOption("claude");
    await provider.selectOption("gemini");
    await panel.getByText("When does the comet reach perihelion?").waitFor();
    await panel.getByRole("button", { name: "gemini-2.5-flash", exact: true }).click();
    await settings.getByRole("button", { name: "Change model" }).click();
    await filter.fill("gemini-3-flash-preview");
    await settings.getByRole("button", { name: "Use gemini-3-flash-preview" }).click();
    await settings.getByRole("button", { name: "Check connection" }).click();
    await settings.getByText("Connection verified.").waitFor();
    await settings.getByRole("button", { name: "Manage key" }).click();
    await settings.getByRole("button", { name: "Remove saved key" }).click();
    await settings.getByLabel("API key", { exact: true }).waitFor();
    await settings.getByRole("radio", { name: "Antigravity" }).click();
    await settings.getByLabel("Ask AI provider").selectOption("chatgpt");
    await settings.getByRole("button", { name: "Close" }).click();
    await page.getByRole("tablist", { name: "Open documents" }).getByRole("button", { name: "Close Observatory log.pdf" }).click();
    console.log("ok  Gemini (Antigravity + API key) setup, models, streaming, citations, Stop, provider switching and key removal");
  } finally { await app.evaluate(() => { globalThis.geminiTest.restore(); delete globalThis.geminiTest; }); }
}
