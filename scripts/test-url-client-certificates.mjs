// Exercise both URL import stages against a TLS server that requests a client identity.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "playwright-core";
import { electronPath } from "./electron-path.mjs";
import { readerPage } from "./reader-page.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dir = mkdtempSync(path.join(tmpdir(), "folio-url-tls-"));
const issuer = "Folio test " + randomUUID();
const read = name => readFileSync(path.join(dir, name));
const openssl = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe", windowsHide: true });
const password = randomUUID();
// Only disposable hosted Windows runners install the generated leaf identity. Local runs never modify an OS store.
const installIdentity = process.platform === "win32" && process.env.FOLIO_TEST_CLIENT_IDENTITY === "1"
  && process.env.RUNNER_ENVIRONMENT === "github-hosted";
const certutil = (...args) => execFileSync("certutil.exe", ["-user", ...args], { cwd: dir, stdio: "pipe", windowsHide: true });

let app, server, thumbprint;
try {
  writeFileSync(path.join(dir, "cert.cnf"), [
    "[req]", "distinguished_name=dn", "[dn]", "[server]", "basicConstraints=critical,CA:TRUE",
    "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign", "subjectAltName=IP:127.0.0.1",
    "[client]", "basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature", "extendedKeyUsage=clientAuth",
  ].join("\n"));
  openssl("req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=" + issuer,
    "-config", "cert.cnf", "-extensions", "server", "-keyout", "server.key", "-out", "server.pem");
  openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Folio test client",
    "-config", "cert.cnf", "-keyout", "client.key", "-out", "client.csr");
  openssl("x509", "-req", "-in", "client.csr", "-CA", "server.pem", "-CAkey", "server.key", "-CAcreateserial",
    "-days", "1", "-extfile", "cert.cnf", "-extensions", "client", "-out", "client.pem");
  const cert = read("server.pem");
  if (installIdentity) {
    openssl("pkcs12", "-export", "-in", "client.pem", "-inkey", "client.key", "-out", "client.p12", "-passout", "pass:" + password);
    certutil("-f", "-p", password, "-importPFX", "My", "client.p12", "NoRoot");
    thumbprint = new X509Certificate(read("client.pem")).fingerprint.replaceAll(":", "");
  }

  const requests = [];
  server = https.createServer({ key: read("server.key"), cert, ca: cert, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    requests.push({ path: req.url, peer: req.socket.getPeerCertificate().fingerprint256 ?? null });
    if (req.url === "/redirect") { res.writeHead(302, { location: "/paper.pdf" }); return res.end(); }
    if (req.url === "/webpage") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end('<title>Anonymous capture</title><img src="/image">');
    }
    if (req.url === "/image") { res.writeHead(204); return res.end(); }
    res.writeHead(200, { "content-type": "application/pdf" });
    res.end("%PDF-1.4\n%%EOF");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "https://127.0.0.1:" + server.address().port;
  await new Promise((resolve, reject) => https.get(origin + "/control", { ca: cert, cert: read("client.pem"),
    key: read("client.key"), agent: false }, response => { response.resume(); response.on("end", resolve); }).on("error", reject));
  assert.equal(requests.shift().peer, new X509Certificate(read("client.pem")).fingerprint256);

  // Trust only this generated server key inside the off-screen test app.
  const spki = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const env = { ...process.env, FOLIO_TEST_HIDDEN: "1", FOLIO_TEST_USER_DATA: path.join(dir, "profile") };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: electronPath(env), env,
    args: [root, "--mute-audio", "--ignore-certificate-errors-spki-list=" + spki,
      ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [])] });
  const page = readerPage(await app.firstWindow());
  await page.getByRole("button", { name: /Try a sample/ }).waitFor();
  await app.evaluate(({ app, dialog }, authority) => {
    dialog.showMessageBox = async () => ({ response: 0 });
    globalThis.importChallenges = [];
    app.on("select-client-certificate", (event, contents, host, candidates) => {
      if (host === authority && candidates.length) globalThis.importChallenges.push(contents ? "capture" : "download");
    });
  }, new URL(origin).host);
  const fetchName = route => page.evaluate(url => window.folioDesktop.fetchPdf(url).then(file => file.name), origin + route);
  assert.equal(await fetchName("/redirect"), "paper.pdf");
  const downloads = requests.splice(0);
  assert.equal(await fetchName("/webpage"), "Anonymous capture.pdf");
  const captures = requests.splice(0);
  assert.deepEqual(downloads.map(req => req.path), ["/redirect", "/paper.pdf"]);
  assert.equal(captures.filter(req => req.path === "/webpage").length, 2, "both the probe and the capture loaded the page");
  assert.ok(captures.some(req => req.path === "/image"), "the captured page loaded its subresource");
  const identified = [...downloads, ...captures].filter(req => req.peer !== null).map(req => req.path);
  assert.deepEqual(identified, [], "URLs that received the generated client identity");
  if (installIdentity) {
    const challenges = await app.evaluate(() => globalThis.importChallenges);
    assert.ok(challenges.includes("download") && challenges.includes("capture"), JSON.stringify(challenges));
    // A new, unrelated Electron session still negotiates the runner's test identity by default.
    await app.evaluate(async ({ session }, url) => {
      const response = await session.fromPartition("folio-cert-control").fetch(url, { credentials: "include" });
      await response.arrayBuffer();
    }, origin + "/electron-control");
    assert.equal(requests.find(req => req.path === "/electron-control")?.peer, new X509Certificate(read("client.pem")).fingerprint256);
  }
  console.log("ok  PDF redirects and webpage capture complete without sharing a TLS client certificate"
    + (installIdentity ? " with a matching OS identity available in both paths" : ""));
} finally {
  try { await app?.close(); }
  finally {
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (thumbprint) certutil("-delstore", "My", thumbprint);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
