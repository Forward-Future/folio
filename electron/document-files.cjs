const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");

const MAX_DOCUMENT_BYTES = 300 * 1024 * 1024;
const MAX_HTML_BYTES = 48 * 1024 * 1024;
const tooLarge = (limit = MAX_DOCUMENT_BYTES) => Object.assign(new Error("The file exceeds the size limit."),
  { userMessage: limit === MAX_DOCUMENT_BYTES ? "It's larger than 300 MB." : "It's too large to convert." });
const changed = () => new Error("The file changed while it was being opened.");
const digest = (data) => crypto.createHash("sha256").update(data).digest("hex");
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

// Open once. O_NONBLOCK also covers a FIFO substituted between lstat and open on POSIX.
async function withRegular(file, limit, use) {
  checkDiskPath(file);
  const before = await fsp.lstat(file, { bigint: true });
  if (!before.isFile()) throw new Error("Choose a regular file.");
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  const handle = await fsp.open(file, flags);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !sameFile(stat, before)) throw changed();
    if (stat.size > limit) throw tooLarge(limit);
    return await use(handle, stat);
  } finally { await handle.close(); }
}

async function readRegular(file, limit = MAX_DOCUMENT_BYTES, expectedSize) {
  return withRegular(file, limit, async (handle, stat) => {
    const size = Number(stat.size);
    if (expectedSize !== undefined && size !== expectedSize) throw changed();
    const data = Buffer.allocUnsafe(size);
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await handle.read(data, offset, Math.min(size - offset, 1024 * 1024));
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1))).bytesRead) throw changed();
    return data;
  });
}

function checkDiskPath(file) {
  // UNC disk shares are supported. Device namespaces, named-pipe shares and alternate data streams aren't files.
  if (process.platform === "win32" && (/^\\\\(?:[?.]\\|[^\\]+\\(?:pipe|mailslot)\\)/i.test(file.replaceAll("/", "\\"))
    || file.slice(2).includes(":"))) throw new Error("Choose a regular file.");
}

async function stageWord(file, source, limit = MAX_DOCUMENT_BYTES) {
  checkDiskPath(file);
  const selected = await fsp.lstat(file, { bigint: true });
  const resolved = await fsp.realpath(file);
  checkDiskPath(resolved);
  const folder = path.dirname(resolved);
  const directory = await fsp.stat(folder, { bigint: true });
  return withRegular(resolved, limit, async (handle, stat) => {
    if (!selected.isSymbolicLink() && !sameFile(selected, stat)) throw changed();
    const hash = crypto.createHash("sha256");
    let size = 0;
    await pipeline(handle.createReadStream({ autoClose: false }), async function* (chunks) {
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > limit) throw tooLarge(limit);
        hash.update(chunk);
        yield chunk;
      }
    }, fs.createWriteStream(source, { flags: "wx", mode: 0o600 }));
    const after = await handle.stat({ bigint: true });
    if (BigInt(size) !== stat.size || after.ctimeNs !== stat.ctimeNs) throw changed();
    // Following a file link is permission to read its target. Only a directly selected regular file can be exported.
    const location = !selected.isSymbolicLink() && stat.nlink === 1n && stat.ino && directory.ino ? {
      folder, name: path.basename(resolved), directory: { dev: directory.dev, ino: directory.ino },
      source: { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs },
    } : null;
    return { resolved, location, sourceDigest: hash.digest("hex") };
  });
}

const pdfName = (name, index = 1) => `${path.parse(name).name}${index === 1 ? "" : ` (${index})`}.pdf`;

function receiptPath(profile, staged) {
  return path.join(profile, "word-conversions", digest(staged.resolved) + ".json");
}

async function cachedPdf(profile, staged) {
  if (!staged.location) return null;
  try {
    const record = JSON.parse(await readRegular(receiptPath(profile, staged), 1024));
    if (record.sourceDigest !== staged.sourceDigest || !Number.isInteger(record.index) || record.index < 1 || record.index > 99
      || !Number.isSafeInteger(record.size) || record.size < 1 || record.size > MAX_DOCUMENT_BYTES) return null;
    const name = pdfName(staged.location.name, record.index);
    const data = await readRegular(path.join(staged.location.folder, name), MAX_DOCUMENT_BYTES, record.size);
    return digest(data) === record.pdfDigest ? { name, data } : null;
  } catch { return null; }
}

async function rememberPdf(profile, staged, index, data) {
  const file = receiptPath(profile, staged);
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + crypto.randomUUID();
  try {
    await fsp.writeFile(temp, JSON.stringify({ sourceDigest: staged.sourceDigest, index, size: data.length, pdfDigest: digest(data) }),
      { flag: "wx", mode: 0o600 });
    await fsp.rename(temp, file);
  } finally { await fsp.rm(temp, { force: true }); }
}

module.exports = { MAX_DOCUMENT_BYTES, MAX_HTML_BYTES, checkDiskPath, tooLarge, readRegular, stageWord, sameFile, pdfName, cachedPdf, rememberPdf };
