// Small original fixtures: byte offsets are calculated over ASCII-only PDF syntax.
export function makePdf(objects) {
  let pdf = "%PDF-1.7\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  const xref = pdf.length;
  return pdf + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

export const textAttachment = "An attached text file.\n";
export const childPdf = makePdf([
  "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 4 0 R >> >> >> >>",
  "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R 7 0 R] >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  stream("BT /F 18 Tf 30 220 Td (Attached PDF content) Tj ET"),
  "<< /Type /Annot /Subtype /Widget /FT /Tx /T (Child form) /V (Read only value) /Rect [30 150 260 180] /P 3 0 R >>",
  "<< /Type /Annot /Subtype /FileAttachment /FS 8 0 R /Rect [30 110 50 130] >>",
  file("nested.txt", 9), stream("Nested content stays outside the first reader.\n"),
]);

function stream(bytes) { return `<< /Length ${bytes.length} >>\nstream\n${bytes}\nendstream`; }
function file(name, ref) { return `<< /Type /Filespec /F (${name}) /UF (${name}) /EF << /F ${ref} 0 R >> >>`; }

export function singleAttachmentPdf(name, bytes) {
  const hex = Buffer.from(bytes).toString("hex") + ">";
  return makePdf([
    "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(child) 5 0 R] >> >> >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> >>",
    "<< >>", file(name, 6),
    `<< /Length ${hex.length} /Filter /ASCIIHexDecode >>\nstream\n${hex}\nendstream`,
  ]);
}

export function attachmentsPdf() {
  return makePdf([
    "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(child-key) 7 0 R (text-key) 9 0 R (unknown-key) 11 0 R (invalid-key) 13 0 R] >> >> /AcroForm << /Fields [15 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 4 0 R >> >> >> >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F 4 0 R >> >> /Contents 6 0 R /Annots [15 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F 4 0 R >> >> /Contents 6 0 R /Annots [16 0 R] >>",
    stream("BT /F 18 Tf 30 250 Td (Parent with attachments) Tj ET"),
    file("child.pdf", 8), stream(childPdf),
    file("notes.txt", 10), stream(textAttachment),
    file("report", 12), stream(childPdf),
    file("invalid.pdf", 14), stream(textAttachment),
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (Parent name) /Rect [30 180 260 210] /P 3 0 R >>",
    "<< /Type /Annot /Subtype /FileAttachment /FS 17 0 R /Rect [30 100 50 120] /Name /PushPin >>",
    file("late-page.txt", 18), stream("Found without visiting page two.\n"),
  ]);
}
