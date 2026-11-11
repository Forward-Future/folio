import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";

export async function imagePlacementPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const cover = pdf.addPage([480, 320]);
  cover.drawText("Field notes", { x: 32, y: 270, size: 24, font, color: rgb(0.12, 0.18, 0.18) });
  const next = pdf.addPage([420, 530]);
  next.setCropBox(20, 15, 350, 460);
  next.setRotation(degrees(90));
  return pdf.save();
}

export async function checkImageInsertion(app, page, folder, shots) {
  const open = (name, bytes) => app.evaluate(({ BrowserWindow }, { name, bytes }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("folio:open-file", { name, data: Buffer.from(bytes) }),
    { name, bytes: Array.from(bytes) });
  await open("Field notes.pdf", await imagePlacementPdf());
  await page.window.waitForFunction(() => document.title.startsWith("Field notes.pdf"));
  const edit = page.getByRole("button", { name: "Edit mode", exact: true });
  await edit.click();
  const images = await page.evaluate(() => {
    const make = (width, height, type) => {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const g = canvas.getContext("2d");
      g.fillStyle = type === "jpeg" ? "#147d75" : "#da7224"; g.fillRect(0, 0, width, height);
      if (type === "png") g.clearRect(0, 0, width/3, height/3);
      else {
        g.fillStyle = "#f5eed5"; g.beginPath(); g.moveTo(30,78); g.lineTo(67,34); g.lineTo(112,78); g.fill();
        g.beginPath(); g.arc(124,24,10,0,2*Math.PI); g.fill();
      }
      if (type === "jpeg") {
        // Camera bitmap stored sideways; the EXIF tag below rotates it upright.
        const raw = document.createElement("canvas"); raw.width = height; raw.height = width;
        const ctx = raw.getContext("2d"); ctx.translate(0, width); ctx.rotate(-Math.PI/2); ctx.drawImage(canvas,0,0);
        return raw.toDataURL("image/jpeg", 0.95).split(",")[1];
      }
      return canvas.toDataURL("image/png").split(",")[1];
    };
    return { jpeg: make(160,96,"jpeg"), png: make(80,48,"png") };
  });
  await page.getByRole("button", { name: "Field notes", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit text on page" }).fill("Field observations");
  const upload = page.getByLabel("Image to insert");
  // Exercise the toolbar without opening a native file chooser on the user's desktop.
  await upload.evaluate(input => { input.click = () => input.dataset.opened = "true"; });
  await page.getByRole("button", { name: "Insert image", exact: true }).click();
  assert.equal(await upload.getAttribute("data-opened"), "true");
  const jpeg = Buffer.from(images.jpeg,"base64");
  const exif = Buffer.from("ffe1002245786966000049492a0008000000010012010300010000000600000000000000","hex");
  await upload.setInputFiles({ name: "landscape.jpg", mimeType: "image/jpeg", buffer: Buffer.concat([jpeg.subarray(0,2),exif,jpeg.subarray(2)]) });
  const frame = page.getByRole("group", { name: "Move inserted image" });
  await frame.waitFor();
  await page.getByRole("button", { name: "Field observations", exact: true }).waitFor();
  const drag = async (node, dx, dy) => {
    const b = await node.boundingBox(), x = b.x+b.width/2, y = b.y+b.height/2;
    await node.hover();
    await page.mouse.down();
    await page.mouse.move(x+dx, y+dy, { steps: 6 });
    await page.mouse.up();
  };
  const relative = () => frame.evaluate(el => {
    const box = el.getBoundingClientRect(), host = el.parentElement.getBoundingClientRect();
    return [(box.left-host.left)/host.width,(box.top-host.top)/host.height,box.width/host.width,box.height/host.height];
  });
  const start = await relative();
  await drag(frame, -35, 13);
  const moved = await relative();
  assert.ok(moved[0] < start[0] && moved[1] > start[1]);
  const corner = page.getByRole("button", { name: "Resize image from bottom right" });
  await drag(corner, 36, 22);
  const first = await relative();
  assert.ok(first[2] > moved[2] && first[3] > moved[3]);
  assert.ok(Math.abs(first[0]-moved[0]) < 0.005 && Math.abs(first[1]-moved[1]) < 0.005);
  assert.ok(Math.abs(first[2]/first[3]-start[2]/start[3]) < 0.01);
  await page.screenshot({ path: path.join(shots,"insert-image-after.png") });
  await page.getByRole("button", { name: "Place image", exact: true }).click();
  await page.getByRole("button", { name: "Image 1", exact: true }).first().waitFor();
  await page.getByTitle("Next page").click();
  await page.locator('.page[data-page-number="2"] .folio-content-layer').waitFor();
  const paste = async () => page.evaluate(base64 => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(base64), ch => ch.charCodeAt(0))], "transparent.png", { type:"image/png" }));
    return !document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles:true, cancelable:true }));
  }, images.png);
  assert.ok(await paste());
  await frame.waitFor();
  await page.getByRole("toolbar", { name: "Image placement" }).getByRole("button", { name: "Cancel" }).click();
  assert.equal(await frame.count(), 0);
  assert.ok(await paste());
  await frame.waitFor();
  await drag(frame, 21, -9);
  await drag(page.getByRole("button", { name: "Resize image from top left" }), -24, -15);
  const second = await relative();
  const file = path.join(folder,"images-added.pdf");
  await app.evaluate(({session}, file) => {
    globalThis.savedImageCopy = new Promise(resolve => session.defaultSession.once("will-download", (_,item) => {
      item.setSavePath(file); item.once("done", (_,state) => resolve(state));
    }));
  },file);
  // Save while the pasted image is still selected.
  await page.getByRole("button", { name: "Save copy", exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.savedImageCopy), "completed");
  const bytes = readFileSync(file);
  const bounds = await page.evaluate(async bytes => {
    const task = pdfjsLib.getDocument({ data: Uint8Array.from(bytes) });
    try {
      const doc = await task.promise;
      const output = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const p = await doc.getPage(n), viewport = p.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas"); canvas.width = viewport.width; canvas.height = viewport.height;
        await p.render({ canvas, viewport }).promise;
        const g = canvas.getContext("2d"), {width:w,height:h} = canvas, pixels = g.getImageData(0,0,w,h).data;
        // Text antialiasing can produce colored pixels too. Measure the largest
        // connected patch of the image color, independently of its expected position.
        const mask = new Uint8Array(w*h);
        for (let pos = 0; pos < mask.length; pos++) {
          const i = 4*pos, red = pixels[i], green = pixels[i+1], blue = pixels[i+2];
          mask[pos] = Number(n === 1 ? green-red > 55 && blue-red > 50 : red-green > 65 && green-blue > 50);
        }
        const queue = new Uint32Array(mask.length);
        let largest = 0, measured;
        for (let seed = 0; seed < mask.length; seed++) {
          if (!mask[seed]) continue;
          let count = 0, left = w, top = h, right = -1, bottom = -1;
          const visit = pos => {
            if (mask[pos]) { mask[pos] = 0; queue[count++] = pos; }
          };
          visit(seed);
          for (let head = 0; head < count; head++) {
            const pos = queue[head], x = pos % w, y = Math.floor(pos / w);
            left = Math.min(left, x); right = Math.max(right, x);
            top = Math.min(top, y); bottom = Math.max(bottom, y);
            if (x > 0) visit(pos-1);
            if (x+1 < w) visit(pos+1);
            if (y > 0) visit(pos-w);
            if (y+1 < h) visit(pos+w);
          }
          if (count > largest) { largest = count; measured = [left, top, right, bottom]; }
        }
        if (!measured) throw new Error("Image color missing on page "+n);
        const [l,t,r,b] = measured;
        const clear = Array.from(g.getImageData(Math.round(l+(r-l)/6),Math.round(t+(b-t)/6),1,1).data);
        const sun = Array.from(g.getImageData(Math.round(l+(r-l)*124/160),Math.round(t+(b-t)*24/96),1,1).data);
        output.push({ box:[l/w,t/h,(r-l+1)/w,(b-t+1)/h], clear, sun });
      }
      return output;
    } finally { await task.destroy(); }
  },Array.from(bytes));
  for (const [i,expected] of [first,second].entries()) {
    for (const [k,v] of expected.entries()) assert.ok(Math.abs(v-bounds[i].box[k])<0.008, JSON.stringify({ i, expected, actual:bounds[i].box }));
  }
  assert.ok(bounds[0].sun[0] > 220 && bounds[0].sun[1] > 220 && bounds[0].sun[2] < 240, "camera JPEG lost its orientation");
  assert.deepEqual(bounds[1].clear,[255,255,255,255]);
  await page.window.waitForFunction(() => document.title.startsWith("Field notes (edited).pdf"));
  await open("Reopened images.pdf",bytes);
  await page.window.waitForFunction(() => document.title.startsWith("Reopened images.pdf"));
  await edit.click();
  // Folio restores the saved position. Edit targets appear when their page is in view.
  const pageNumber = page.getByLabel("Page number", { exact: true });
  for (const number of [1, 2]) {
    await pageNumber.fill(String(number));
    await pageNumber.press("Enter");
    await page.locator(`.page[data-page-number="${number}"]`).getByRole("button", { name: "Image 1", exact: true }).waitFor();
  }
  console.log("ok  JPEG and pasted transparent PNG match the dragged and resized previews after save, including on a rotated cropped page");
}
