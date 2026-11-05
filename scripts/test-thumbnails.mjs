// Offline checks for the Pages sidebar: thumbnail sizes and how page sizes are loaded. No PDF or window is needed.
import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom" });
let passed = 0;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// A stand-in for a PDF.js document whose getPage calls stay pending until the test settles them.
function deferredPdf(numPages, sizeOf = () => ({ width: 612, height: 792 })) {
  const calls = [];
  let outstanding = 0;
  let peak = 0;
  const pdf = {
    numPages,
    getPage(n) {
      outstanding++;
      peak = Math.max(peak, outstanding);
      return new Promise((resolve, reject) => {
        const settle = () => { outstanding--; };
        calls.push({
          n,
          resolve: () => {
            settle();
            const s = sizeOf(n);
            resolve({ rotate: 0, getViewport: () => s });
          },
          reject: () => {
            settle();
            reject(new Error(`page ${n} failed`));
          },
        });
      });
    },
  };
  return { pdf, calls, get outstanding() { return outstanding; }, get peak() { return peak; } };
}

try {
  const { thumbLayout, loadPageSizes, anchoredScrollTop, rowAt, SIZE_REQUEST_LIMIT, THUMB_W, THUMB_MAX_H, THUMB_MIN } = await server.ssrLoadModule("/src/thumbnails.ts");
  const check = async (name, test) => {
    await test();
    passed++;
    console.log(`ok  ${name}`);
  };
  const dims = (f) => `${f.width}x${f.height}`;
  const letter = { width: 612, height: 792 };
  const letterLandscape = { width: 792, height: 612 };
  const tabloid = { width: 1224, height: 792 };

  await check("a document of one page size keeps the usual 132px thumbnails", () => {
    const { frames } = thumbLayout([letter, letter], 2, 0);
    assert.deepEqual(frames.map(dims), ["132x171", "132x171"]);
  });

  await check("mixed sizes keep each page's shape and relative size", () => {
    const { frames } = thumbLayout([letter, letterLandscape, tabloid], 3, 0);
    assert.deepEqual(frames.map(dims), ["66x85", "85x66", "132x85"]);
  });

  await check("a small page beside a large sheet is enlarged to the minimum", () => {
    const { frames } = thumbLayout([letter, { width: 2592, height: 3456 }], 2, 0);
    assert.equal(Math.min(frames[0].width, frames[0].height), THUMB_MIN);
  });

  for (const rotation of [0, 90]) {
    await check(`a tall strip stays inside the frame limits and keeps its shape (rotation ${rotation})`, () => {
      const { frames } = thumbLayout([{ width: 72, height: 720 }], 1, rotation);
      const [f] = frames;
      assert.ok(f.width <= THUMB_W, `too wide: ${dims(f)}`);
      assert.ok(f.height <= THUMB_MAX_H, `too tall: ${dims(f)}`);
      const expected = rotation ? 10 : 0.1;
      assert.ok(Math.abs(f.width / f.height / expected - 1) < 0.05, `shape changed: ${dims(f)}`);
    });
  }

  await check("reordered pages keep their own shape in their new rows", () => {
    // The organizer shows page 3 first, then 1, then 2.
    const sizes = [letter, letterLandscape, tabloid];
    const plain = thumbLayout(sizes, 3, 0);
    const moved = thumbLayout(sizes, 3, 0, [3, 1, 2]);
    assert.deepEqual(moved.frames.map(dims), ["132x85", "66x85", "85x66"]);
    assert.deepEqual(moved.frames, [plain.frames[2], plain.frames[0], plain.frames[1]]);
    const rowHeights = moved.tops.slice(1).map((t, i) => t - moved.tops[i]);
    assert.deepEqual(rowHeights, moved.frames.map((f) => f.height + 48));
  });

  await check("unmeasured pages borrow the first measured size, not Letter", () => {
    const { frames } = thumbLayout([undefined, tabloid, undefined], 3, 0);
    assert.deepEqual(frames.map(dims), ["132x85", "132x85", "132x85"]);
  });

  await check("the row at the top of the list stays put when pages above it get their sizes", () => {
    // Scrolled 30px into page 41 of 100, before any sizes arrive.
    const before = thumbLayout(null, 100, 0);
    const scrollTop = before.tops[40] + 30;
    // Pages 1-20 turn out to be landscape, so every row above page 41 gets shorter.
    const sizes = Array.from({ length: 100 }, (_, i) => (i < 20 ? letterLandscape : letter));
    const after = thumbLayout(sizes, 100, 0);
    assert.ok(after.tops[40] < before.tops[40], "rows above should have moved");
    const next = anchoredScrollTop(before.tops, after.tops, scrollTop);
    assert.equal(rowAt(after.tops, next), 40);
    assert.equal(next - after.tops[40], 30);
  });

  await check("the list doesn't move when nothing above the top row changes", () => {
    const sizes = Array.from({ length: 100 }, () => letter);
    const before = thumbLayout(sizes, 100, 0);
    // Smaller than letter, so the shared scale (set by the largest page) doesn't change.
    const changed = sizes.slice();
    changed[90] = { width: 420, height: 595 };
    const after = thumbLayout(changed, 100, 0);
    const scrollTop = before.tops[10] + 5;
    assert.equal(anchoredScrollTop(before.tops, after.tops, scrollTop), scrollTop);
  });

  await check("at the very top, the list stays at the very top", () => {
    const before = thumbLayout(null, 50, 0);
    const after = thumbLayout(Array.from({ length: 50 }, () => tabloid), 50, 0);
    assert.equal(anchoredScrollTop(before.tops, after.tops, 0), 0);
  });

  await check(`a 6,000-page document never has more than ${SIZE_REQUEST_LIMIT} size requests in flight`, async () => {
    const doc = deferredPdf(6000);
    const loader = loadPageSizes(doc.pdf, () => {});
    loader.prioritize(0, 12);
    assert.equal(doc.outstanding, SIZE_REQUEST_LIMIT);
    for (let i = 0; i < 200; i++) {
      doc.calls.find((c) => !c.done && (c.done = true)).resolve();
      await tick();
      assert.ok(doc.outstanding <= SIZE_REQUEST_LIMIT, `${doc.outstanding} requests in flight`);
    }
    assert.equal(doc.peak, SIZE_REQUEST_LIMIT);
    assert.equal(doc.calls.length, 200 + SIZE_REQUEST_LIMIT);
    loader.stop();
  });

  await check("visible rows are measured first, then the rest in order", async () => {
    const doc = deferredPdf(5000);
    const loader = loadPageSizes(doc.pdf, () => {});
    loader.prioritize(3000, 3010);
    assert.deepEqual(doc.calls.map((c) => c.n), [3001, 3002, 3003, 3004, 3005, 3006]);
    for (let i = 0; i < 10; i++) {
      doc.calls[i].resolve();
      await tick();
    }
    assert.deepEqual(doc.calls.slice(0, 10).map((c) => c.n), [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010]);
    assert.deepEqual(doc.calls.slice(10).map((c) => c.n), [1, 2, 3, 4, 5, 6]);
    loader.stop();
  });

  await check("after a reorder, the pages shown in the visible rows are measured first", async () => {
    const doc = deferredPdf(1000);
    const loader = loadPageSizes(doc.pdf, () => {});
    // Pages 900-905 were dragged to the top of the list.
    const order = [900, 901, 902, 903, 904, 905, ...Array.from({ length: 1000 }, (_, i) => i + 1).filter((n) => n < 900 || n > 905)];
    loader.prioritize(0, 6, order);
    assert.deepEqual(doc.calls.map((c) => c.n), [900, 901, 902, 903, 904, 905]);
    loader.stop();
  });

  await check("nothing more is requested or reported after the list closes", async () => {
    const doc = deferredPdf(100);
    const seen = [];
    const loader = loadPageSizes(doc.pdf, (i) => seen.push(i));
    loader.prioritize(0, 12);
    loader.stop();
    for (const c of [...doc.calls]) c.resolve();
    await tick();
    assert.equal(doc.calls.length, SIZE_REQUEST_LIMIT);
    assert.deepEqual(seen, []);
  });

  await check("one failed page doesn't discard the sizes that loaded", async () => {
    const doc = deferredPdf(3, (n) => [letter, letterLandscape, tabloid][n - 1]);
    const sizes = new Array(3);
    const loader = loadPageSizes(doc.pdf, (i, s) => { sizes[i] = s; });
    loader.prioritize(0, 3);
    doc.calls[0].resolve();
    doc.calls[1].reject();
    doc.calls[2].resolve();
    await tick();
    assert.deepEqual(sizes[0], letter);
    assert.equal(sizes[1], undefined);
    assert.deepEqual(sizes[2], tabloid);
    // The failed page takes page 1's size; the others keep their own.
    assert.deepEqual(thumbLayout(sizes, 3, 0).frames.map(dims), ["66x85", "66x85", "132x85"]);
  });

  console.log(`${passed} thumbnail checks passed`);
} finally {
  await server.close();
}
