const JSZip = require("jszip");
const { MAX_HTML_BYTES } = require("./document-files.cjs");

const DOCX_LIMITS = { entries: 4096, part: 32 * 1024 ** 2, total: 96 * 1024 ** 2, html: MAX_HTML_BYTES };
const budgetError = () => Object.assign(new Error("Word document exceeds conversion limits."), { userMessage: "It's too large to convert." });
const invalidZip = () => new Error("Invalid or unsupported Word ZIP directory.");

// JSZip reads records until the central-header signature stops, ignoring a false record count, and then merges
// duplicate names. Walk the same directory before it allocates entry objects. DOCX needs only single-disk ZIP32.
function countZipEntries(bytes, limits) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) throw invalidZip();
  const advertised = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  const length = bytes.readUInt32LE(end + 12);
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== advertised || advertised === 0xffff
    || !advertised || start + length !== end) throw invalidZip();
  if (advertised > limits.entries || length > 8 * 1024 * 1024) throw budgetError();
  let count = 0;
  let offset = start;
  const localOffsets = new Set();
  while (offset < end) {
    if (++count > limits.entries) throw budgetError();
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50 || bytes.readUInt16LE(offset + 34) !== 0) throw invalidZip();
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraStart = offset + 46 + nameLength;
    const extraEnd = extraStart + bytes.readUInt16LE(offset + 30);
    const next = extraEnd + bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    if (!nameLength || next > end || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50
      || localOffsets.has(local) || bytes.readUInt16LE(local + 26) !== nameLength) throw invalidZip();
    localOffsets.add(local);
    const data = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
    if (data + bytes.readUInt32LE(offset + 20) > start
      || !bytes.subarray(local + 30, local + 30 + nameLength).equals(bytes.subarray(offset + 46, extraStart))
      || bytes.readUInt32LE(local + 18) === 0xffffffff || bytes.readUInt32LE(local + 22) === 0xffffffff) throw invalidZip();
    if (bytes.readUInt32LE(offset + 24) > limits.part) throw budgetError();
    // Keep optional metadata inside its record and bound the objects JSZip creates for extra fields.
    let fields = 0;
    for (let extra = extraStart; extra < extraEnd;) {
      if (++fields > 64) throw budgetError();
      if (extra + 4 > extraEnd || bytes.readUInt16LE(extra) === 1) throw invalidZip(); // ZIP64
      extra += 4 + bytes.readUInt16LE(extra + 2);
      if (extra > extraEnd) throw invalidZip();
    }
    offset = next;
  }
  if (count !== advertised) throw invalidZip();
  return count;
}

// Supply Mammoth with the exact parts that passed the byte counts. ZIP sizes and filenames in a second
// interpretation of the archive can't authorize additional reads. No entry is extracted to a filesystem path.
async function boundedParts(bytes, limits = DOCX_LIMITS) {
  const count = countZipEntries(bytes, limits);
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length !== count) throw invalidZip(); // duplicate or aliased names
  const parts = new Map();
  let total = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    if (entry.unsafeOriginalName !== entry.name) throw invalidZip();
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
      const stream = entry.internalStream("nodebuffer");
      stream.on("data", (chunk) => {
        size += chunk.length;
        total += chunk.length;
        if (size > limits.part || total > limits.total) {
          stream.pause();
          reject(budgetError());
        } else { chunks.push(chunk); }
      }).on("error", reject).on("end", resolve).resume();
    });
    parts.set(entry.name, Buffer.concat(chunks, size));
  }
  let encodedBytes = 0;
  let overBudget = false;
  return {
    exists: (name) => parts.has(name),
    async read(name, encoding) {
      const part = parts.get(name);
      if (!part) throw new Error("Missing Word document part.");
      // A document may reference a single large image thousands of times. Charge each embedded copy before encoding.
      if (encoding === "base64") {
        encodedBytes += 4 * Math.ceil(part.length / 3);
        if (encodedBytes > limits.html) {
          overBudget = true;
          throw budgetError();
        }
      }
      return encoding ? part.toString(encoding) : part;
    },
    checkHtml(html) {
      // Mammoth can recover from an image read failure. Reject the whole document if any read exhausted the budget.
      if (overBudget || Buffer.byteLength(html) > limits.html) throw budgetError();
    },
  };
}

module.exports = { boundedParts, DOCX_LIMITS, budgetError };
