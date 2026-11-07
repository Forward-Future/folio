import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";

// Use only a synthetic PDF, key, and local responses. The production IPC, stream reader and citations run as usual.
export async function checkCustomEndpoint(app, page) {
  const pdf = await PDFDocument.create();
  pdf.addPage([480, 520]).drawText("Harbor log", { x: 38, y: 435, size: 28 });
  pdf.addPage([480, 520]).drawText("The ferry leaves at dawn.", { x: 38, y: 435, size: 20 });
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
    const state = globalThis.endpointTest = { calls: [], cancelled: false, hold: false };
    net.fetch = async (url, options) => {
      if (!String(url).startsWith("https://llm.example.test/")) return fetch.call(net, url, options);
      const endpoint = new URL(url).pathname;
      state.calls.push(endpoint);
      if (options.headers.Authorization !== "Bearer fixture-only-endpoint-key") return Response.json({ error: {} }, { status: 401 });
      if (endpoint === "/v1/models") return Response.json({ data: [{ id: "harbor-large" }, { id: "harbor-small" }] });
      if (endpoint !== "/v1/chat/completions") throw new Error("Unexpected endpoint");
      state.request = JSON.parse(options.body);
      if (state.hold) return new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener("abort", () => { state.cancelled = true; controller.error(new Error("Stopped")); }, { once: true });
      } }));
      return new Response('data: {"choices":[{"delta":{"content":"The ferry leaves at dawn "}}]}\n\n'
        + 'data: {"choices":[{"delta":{"content":"(p. 2)."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    };
    state.restore = () => { net.fetch = fetch; Object.assign(safeStorage, original); };
    target.send("folio:open-file", { name: "Harbor log.pdf", data: Buffer.from(bytes, "base64") });
  }, bytes);
  try {
    await page.window.waitForFunction(() => document.title.startsWith("Harbor log.pdf"));
    const panel = page.getByRole("complementary", { name: "Ask AI" });
    if (!(await panel.count())) await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    const provider = panel.getByRole("combobox", { name: "AI provider" });
    await provider.selectOption("custom");
    await panel.getByRole("heading", { name: "Connect an endpoint" }).waitFor();
    await panel.getByRole("button", { name: "Open Ask AI settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    assert.deepEqual(await app.evaluate(() => globalThis.endpointTest.calls), []);
    // Plain http to the internet is refused before anything is sent.
    await settings.getByLabel("Base URL").fill("http://llm.example.test/v1");
    await settings.getByRole("button", { name: "Connect" }).click();
    await settings.getByRole("alert").filter({ hasText: "Plain http works only" }).waitFor();
    assert.deepEqual(await app.evaluate(() => globalThis.endpointTest.calls), []);
    await settings.getByLabel("Base URL").fill("https://llm.example.test/v1/");
    await settings.getByLabel("API key (optional)").fill("fixture-only-endpoint-key");
    await settings.getByRole("button", { name: "Connect" }).click();
    await settings.getByText("https://llm.example.test/v1 · key stored securely on this device").waitFor();
    const filter = settings.getByRole("searchbox", { name: "Model" });
    await filter.fill("large");
    await settings.getByRole("button", { name: /harbor-large/ }).click();
    assert.deepEqual(await app.evaluate(() => globalThis.endpointTest.calls), ["/v1/models", "/v1/models"]);
    await settings.getByRole("button", { name: "Close" }).click();
    await panel.getByText("Sent to llm.example.test").waitFor();
    await panel.getByRole("textbox").fill("When does the ferry leave?");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await panel.getByRole("button", { name: "(p. 2)" }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === "2");
    const request = await app.evaluate(() => globalThis.endpointTest.request);
    assert.equal(request.model, "harbor-large");
    assert.equal(request.stream, true);
    assert.match(JSON.parse(request.messages[1].content).document.text, /\[Page 2\]/);
    await app.evaluate(() => { globalThis.endpointTest.hold = true; });
    await panel.getByRole("textbox").fill("Continue");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    for (let i = 0; i < 100 && !(await app.evaluate(() => globalThis.endpointTest.calls.filter(c => c.endsWith("completions")).length === 2)); i++) await page.waitForTimeout(50);
    await panel.getByRole("button", { name: "Stop" }).click();
    await panel.getByRole("button", { name: "Send", exact: true }).waitFor();
    assert.ok(await app.evaluate(() => globalThis.endpointTest.cancelled));
    // A typed ID works for servers whose list leaves a model out.
    await panel.getByRole("button", { name: "harbor-large", exact: true }).click();
    await settings.getByRole("button", { name: "Change model" }).click();
    await filter.fill("harbor:custom-7b");
    await settings.getByRole("button", { name: "Use harbor:custom-7b" }).click();
    await settings.getByRole("button", { name: "Check connection" }).click();
    await settings.getByText("Connection verified.").waitFor();
    await settings.getByRole("button", { name: "Change endpoint" }).click();
    await settings.getByRole("button", { name: "Remove endpoint" }).click();
    await settings.getByLabel("Base URL").waitFor();
    assert.equal(await page.window.evaluate(() => localStorage.getItem("folio:ai-model:custom")), "");
    await settings.getByLabel("Ask AI provider").selectOption("chatgpt");
    await settings.getByRole("button", { name: "Close" }).click();
    await page.getByRole("tablist", { name: "Open documents" }).getByRole("button", { name: "Close Harbor log.pdf" }).click();
    console.log("ok  custom endpoint setup, http guard, models, streaming, citations, Stop, typed model and removal");
  } finally { await app.evaluate(() => { globalThis.endpointTest.restore(); delete globalThis.endpointTest; }); }
}
