import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

// A real server on this computer, reached through the production IPC, local-address question, guarded session, stream
// reader and citations. folio-local.test resolves to 127.0.0.1 (see the host resolver rules in smoke-test.mjs).
export async function checkCustomEndpoint(app, page, shots) {
  const served = [];
  let hold = false, cancelled = false, lastChat = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      served.push({ path: req.url, auth: req.headers.authorization ?? null });
      if (req.headers.authorization !== "Bearer fixture-only-endpoint-key") { res.writeHead(401, { "content-type": "application/json" }); return res.end("{}"); }
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "harbor-large" }, { id: "harbor-small" }] }));
      }
      if (req.url !== "/v1/chat/completions") { res.writeHead(404); return res.end(); }
      lastChat = JSON.parse(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (hold) { res.on("close", () => { cancelled = true; }); return res.write(": waiting\n\n"); }
      const citation = JSON.parse(lastChat.messages[1].content).documents ? "(Ferry schedule.pdf, p. 2)." : "(p. 2).";
      res.end('data: {"choices":[{"delta":{"content":"The ferry leaves at dawn "}}]}\n\n'
        + `data: ${JSON.stringify({ choices: [{ delta: { content: citation }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const host = `folio-local.test:${server.address().port}`;

  const pdf = await PDFDocument.create();
  pdf.addPage([480, 520]).drawText("Harbor log", { x: 38, y: 435, size: 28 });
  pdf.addPage([480, 520]).drawText("The ferry leaves at dawn.", { x: 38, y: 435, size: 20 });
  const bytes = Buffer.from(await pdf.save()).toString("base64");
  await app.evaluate(({ webContents, safeStorage, dialog }, bytes) => {
    const target = webContents.getAllWebContents().find(c => c.getURL().startsWith("app://folio/"));
    const methods = ["isAsyncEncryptionAvailable", "encryptStringAsync", "decryptStringAsync"];
    if (process.platform === "linux") methods.push("getSelectedStorageBackend");
    const original = Object.fromEntries(methods.map(name => [name, safeStorage[name]]));
    safeStorage.isAsyncEncryptionAvailable = async () => true;
    if (process.platform === "linux") safeStorage.getSelectedStorageBackend = () => "gnome_libsecret";
    safeStorage.encryptStringAsync = async value => Buffer.from(value).map(b => b ^ 128);
    safeStorage.decryptStringAsync = async bytes => ({ result: Buffer.from(bytes).map(b => b ^ 128).toString() });
    const ask = dialog.showMessageBox;
    const state = globalThis.endpointTest = { asked: [], answer: 1 };
    dialog.showMessageBox = async (_window, options) => { state.asked.push(options.message); return { response: state.answer }; };
    state.restore = () => { Object.assign(safeStorage, original); dialog.showMessageBox = ask; };
    target.send("folio:open-file", { name: "Harbor log.pdf", data: Buffer.from(bytes, "base64") });
  }, bytes);
  const asked = () => app.evaluate(() => globalThis.endpointTest.asked);
  try {
    await page.window.waitForFunction(() => document.title.startsWith("Harbor log.pdf"));
    const panel = page.getByRole("complementary", { name: "Ask AI" });
    if (!(await panel.count())) await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    const provider = panel.getByRole("combobox", { name: "AI provider" });
    await provider.selectOption("custom");
    await panel.getByRole("heading", { name: "Connect an endpoint" }).waitFor();
    await panel.getByRole("button", { name: "Open Ask AI settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    // A local address is asked about first. Declining sends nothing.
    await settings.getByLabel("Base URL").fill(`http://${host}/v1/`);
    await settings.getByLabel("API key (optional)").fill("fixture-only-endpoint-key");
    await settings.getByRole("button", { name: "Connect" }).click();
    await settings.getByRole("alert").filter({ hasText: `Folio didn't connect to ${host}.` }).waitFor();
    assert.deepEqual(await asked(), [`Open ${host}?`]);
    assert.deepEqual(served, []);
    // Agreeing connects. Only the approved address is reached, with the key.
    await app.evaluate(() => { globalThis.endpointTest.answer = 0; });
    await settings.getByLabel("API key (optional)").fill("fixture-only-endpoint-key");
    await settings.getByRole("button", { name: "Connect" }).click();
    await settings.getByText(`http://${host}/v1 · key stored securely on this device`).waitFor();
    const filter = settings.getByRole("searchbox", { name: "Model" });
    await filter.fill("large");
    await settings.getByRole("button", { name: /harbor-large/ }).click();
    assert.deepEqual(served.map(s => s.path), ["/v1/models", "/v1/models"]);
    await settings.getByRole("button", { name: "Close" }).click();
    await panel.getByText(`Sent to ${host}`).waitFor();
    await panel.getByRole("textbox").fill("When does the ferry leave?");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await panel.getByRole("button", { name: "(p. 2)" }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === "2");
    assert.equal(lastChat.model, "harbor-large");
    assert.equal(lastChat.stream, true);
    assert.match(JSON.parse(lastChat.messages[1].content).document.text, /\[Page 2\]/);
    assert.ok(served.every(s => s.auth === "Bearer fixture-only-endpoint-key"));
    await panel.screenshot({ path: path.join(shots, "ask-ai-single-document.png") });
    // Pick another open PDF, keep it when the panel closes, and follow its citation into the right tab.
    const schedule = await PDFDocument.create();
    schedule.addPage([480, 520]).drawText("Ferry schedule", { x: 38, y: 435, size: 28 });
    schedule.addPage([480, 520]).drawText("Departure: dawn. Arrival: noon.", { x: 38, y: 435, size: 20 });
    await app.evaluate(({ webContents }, data) => {
      webContents.getAllWebContents().find(c => c.getURL().startsWith("app://folio/"))
        .send("folio:open-file", { name: "Ferry schedule.pdf", data: Buffer.from(data, "base64") });
    }, Buffer.from(await schedule.save()).toString("base64"));
    await page.window.waitForFunction(() => document.title.startsWith("Ferry schedule.pdf"));
    await page.locator(".textLayer span:not(.markedContent)").first().waitFor();
    const tabs = page.getByRole("tablist", { name: "Open documents" });
    await tabs.getByRole("tab", { name: "Harbor log.pdf", exact: true }).click();
    await panel.getByRole("button", { name: "Add open document", exact: true }).click();
    await panel.getByRole("menuitem", { name: "Ferry schedule", exact: true }).click();
    await panel.getByRole("button", { name: "Remove Ferry schedule.pdf", exact: true }).waitFor();
    await panel.screenshot({ path: path.join(shots, "ask-ai-open-tabs.png") });
    await panel.getByRole("button", { name: "Close Ask AI" }).click();
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    await panel.getByRole("button", { name: "Remove Ferry schedule.pdf", exact: true }).waitFor();
    await panel.getByRole("textbox").fill("Compare the harbor log with the ferry schedule.");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    const fileCitation = panel.getByRole("button", { name: "(Ferry schedule.pdf, p. 2)" });
    await fileCitation.waitFor();
    const documents = JSON.parse(lastChat.messages[1].content).documents;
    assert.deepEqual(documents.map(doc => doc.name), ["Harbor log.pdf", "Ferry schedule.pdf"]);
    assert.match(documents[1].text, /Departure: dawn/);
    await fileCitation.click();
    await page.window.waitForFunction(() => document.title.startsWith("Ferry schedule.pdf"));
    await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === "2");
    await tabs.getByRole("button", { name: "Close Ferry schedule.pdf", exact: true }).click();
    await page.window.waitForFunction(() => document.title.startsWith("Harbor log.pdf"));
    await panel.locator(".attachment.missing").filter({ hasText: "Ferry schedule" }).waitFor();
    assert.equal(await fileCitation.count(), 0, "a closed document's citation is no longer clickable");
    await panel.getByRole("textbox").fill("Summarize the documents still open.");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "Ferry schedule.pdf isn't open, so it was left out." }).waitFor();
    await panel.getByRole("button", { name: "Send", exact: true }).waitFor();
    assert.equal(JSON.parse(lastChat.messages[1].content).documents, undefined);
    await panel.getByRole("button", { name: "Remove Ferry schedule.pdf", exact: true }).click();
    console.log("ok  Ask AI adds an open document, keeps its chip, sends both texts, follows its citation, and skips a closed tab");
    // Stop ends the request at the server.
    const completed = served.filter(s => s.path.endsWith("completions")).length;
    hold = true;
    await panel.getByRole("textbox").fill("Continue");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    for (let i = 0; i < 100 && served.filter(s => s.path.endsWith("completions")).length <= completed; i++) await page.waitForTimeout(50);
    await panel.getByRole("button", { name: "Stop" }).click();
    await panel.getByRole("button", { name: "Send", exact: true }).waitFor();
    for (let i = 0; i < 100 && !cancelled; i++) await page.waitForTimeout(50);
    assert.ok(cancelled, "Stop closes the connection");
    hold = false;
    // A typed ID works for servers whose list leaves a model out; later requests aren't asked about again.
    await panel.getByRole("button", { name: "harbor-large", exact: true }).click();
    await settings.getByRole("button", { name: "Change model" }).click();
    await filter.fill("harbor:custom-7b");
    await settings.getByRole("button", { name: "Use harbor:custom-7b" }).click();
    await settings.getByRole("button", { name: "Check connection" }).click();
    await settings.getByText("Connection verified.").waitFor();
    assert.equal((await asked()).length, 2);
    await settings.getByRole("button", { name: "Change endpoint" }).click();
    await settings.getByRole("button", { name: "Remove endpoint" }).click();
    await settings.getByLabel("Base URL").waitFor();
    assert.equal(await page.window.evaluate(() => localStorage.getItem("folio:ai-model:custom")), "");
    await settings.getByLabel("Ask AI provider").selectOption("chatgpt");
    await settings.getByRole("button", { name: "Close" }).click();
    await page.getByRole("tablist", { name: "Open documents" }).getByRole("button", { name: "Close Harbor log.pdf" }).click();
    console.log("ok  custom endpoint: local address asked first, decline sends nothing, models, streaming, citations, Stop, typed model and removal");
  } finally {
    await app.evaluate(() => { globalThis.endpointTest.restore(); delete globalThis.endpointTest; });
    server.close();
    server.closeAllConnections();
  }
}
