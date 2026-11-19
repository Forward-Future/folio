// PDFs written out byte by byte, for tests of what reads them: a PDF library writes only the files it would read well,
// and what a reader does with a file built to mislead it is the thing to know.

type Part = string | Uint8Array;

/** Strings (one byte for each character) and bytes, joined. */
export function bytesOf(...parts: Part[]) {
  const all = parts.map(part => typeof part === "string" ? Uint8Array.from(part, char => char.charCodeAt(0)) : part);
  const out = new Uint8Array(all.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of all) { out.set(part, at); at += part.length; }
  return out;
}

export async function pack(bytes: Uint8Array) {
  return new Uint8Array(await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
}

/** A stream object's body: `settings` are its dictionary's entries besides the length. */
export const streamOf = (data: Part, settings = "") => bytesOf(`<< ${settings} /Length ${bytesOf(data).length} >>\nstream\n`, data, "\nendstream");

/** Where the newest table of `pdf` starts. */
export const tableOf = (pdf: Uint8Array) => Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(String.fromCharCode(...pdf.subarray(-64)))![1]);

/**
 * `objects` (by number) written after `onto`, an earlier revision of the same file if there is one, then a table of
 * where they are and a trailer. `gone` are objects this revision deletes.
 */
export function handPdf(objects: Record<number, Part>, { onto, trailer = "/Root 1 0 R", gone = [] as number[] } = {} as { onto?: Uint8Array; trailer?: string; gone?: number[] }) {
  const parts: Part[] = [onto ?? "%PDF-1.7\n"], offsets = new Map<number, number>();
  let at = bytesOf(parts[0]).length;
  for (const [num, body] of Object.entries(objects)) {
    offsets.set(Number(num), at);
    const object = bytesOf(`${num} 0 obj\n`, body, "\nendobj\n");
    parts.push(object);
    at += object.length;
  }
  const size = Math.max(...offsets.keys(), ...gone) + 1;
  const row = (num: number) => offsets.has(num) ? `${String(offsets.get(num)).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n";
  let table = "xref\n";
  if (onto) for (const num of [...offsets.keys(), ...gone]) table += `${num} 1\n${row(num)}`;
  else table += `0 ${size}\n${Array.from({ length: size }, (_, num) => row(num)).join("")}`;
  parts.push(table, `trailer\n<< /Size ${size} ${trailer}${onto ? ` /Prev ${tableOf(onto)}` : ""} >>\nstartxref\n${at}\n%%EOF\n`);
  return bytesOf(...parts);
}

/** The objects of a one-page PDF with one attached file, "a.txt" (hello), for a test to change or add to. */
export const withAttachment = (): Record<number, Part> => ({
  1: "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 6 0 R >> >>",
  2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
  4: "<< /Type /Filespec /F (a.txt) /EF << /F 5 0 R >> >>",
  5: streamOf("hello\n"),
  6: "<< /Names [ (a.txt) 4 0 R ] >>",
});
