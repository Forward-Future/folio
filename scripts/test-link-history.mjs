import assert from "node:assert/strict";
import { test } from "node:test";
import { LinkHistory } from "../src/linkHistory.ts";

function fixture() {
  const states = [], visits = [];
  const viewer = { pdfDocument: {}, pagesCount: 1000, currentPageNumber: 1, currentScaleValue: "1.25", pagesRotation: 0,
    x: 10, y: 20, container: { clientLeft: 2, clientTop: 3, getBoundingClientRect: () => ({ left: 100, top: 200 }) },
    getPageView() { return { pdfPage: {}, div: { clientLeft: 1, clientTop: 1,
      getBoundingClientRect: () => ({ left: 101 - viewer.x, top: 202 - viewer.y }) }, getPagePoint: (x, y) => [x, y] }; },
    scrollPageIntoView(value) { visits.push(value); viewer.currentPageNumber = value.pageNumber;
      viewer.x = value.destArray?.[2] ?? 0; viewer.y = value.destArray?.[3] ?? 0; },
  };
  const history = new LinkHistory(viewer, state => states.push(state));
  const follow = (page, destination = [null, { name: "XYZ" }, 30, 40, null]) => {
    history.pushCurrentPosition(); history.push({ pageNumber: page, explicitDest: destination });
    viewer.scrollPageIntoView({ pageNumber: page, destArray: destination });
  };
  return { viewer, history, follow, states, visits };
}

test("Back and Forward restore exact coordinates, zoom and rotation, including later scrolling", () => {
  const f = fixture();
  f.follow(2); f.viewer.x = 70; f.viewer.y = 80;
  f.viewer.currentScaleValue = "2"; f.viewer.pagesRotation = 90;
  f.history.back();
  assert.equal(f.viewer.currentPageNumber, 1);
  assert.equal(f.viewer.currentScaleValue, "1.25"); assert.equal(f.viewer.pagesRotation, 0);
  assert.deepEqual(f.visits.at(-1).destArray.slice(2, 4), [10, 20]);
  assert.deepEqual(f.states.at(-1), { back: false, forward: true });
  f.history.forward();
  assert.equal(f.viewer.currentPageNumber, 2);
  assert.equal(f.viewer.currentScaleValue, "2"); assert.equal(f.viewer.pagesRotation, 90);
  assert.deepEqual(f.visits.at(-1).destArray.slice(2, 4), [70, 80]);
});

test("a different link after Back discards the old forward branch", () => {
  const f = fixture(); f.follow(2); f.follow(3); f.history.back(); f.follow(4);
  assert.deepEqual(f.states.at(-1), { back: true, forward: false });
  f.history.forward(); assert.equal(f.viewer.currentPageNumber, 4);
  f.history.back(); assert.equal(f.viewer.currentPageNumber, 2);
  f.history.back(); assert.equal(f.viewer.currentPageNumber, 1);
});

test("reset, invalid targets and unavailable documents do not replay locations", () => {
  const f = fixture();
  for (const page of [0, -1, 1.5, Infinity, 1001]) { f.history.pushCurrentPosition(); f.history.push({ pageNumber: page }); }
  assert.equal(f.states.length, 0);
  f.history.back(); f.history.forward(); assert.equal(f.visits.length, 0);
  f.follow(2); f.history.reset(); f.history.back(); f.history.forward();
  assert.deepEqual(f.states.at(-1), { back: false, forward: false });
  assert.equal(f.viewer.currentPageNumber, 2);
  f.follow(3); f.viewer.pdfDocument = null; f.history.back(); assert.equal(f.viewer.currentPageNumber, 3);
});

test("history is bounded and separate readers never share entries", () => {
  const a = fixture(), b = fixture();
  for (let page = 2; page <= 120; page++) a.follow(page);
  for (let i = 0; i < 200; i++) a.history.back();
  assert.equal(a.viewer.currentPageNumber, 21);
  assert.equal(b.viewer.currentPageNumber, 1); assert.equal(b.visits.length, 0);
  assert.deepEqual(a.states.at(-1), { back: false, forward: true });
});

test("page-only destinations use the same history contract", () => {
  const f = fixture(); f.history.pushCurrentPosition(); f.history.pushPage(3);
  f.viewer.currentPageNumber = 3; f.history.back();
  assert.equal(f.viewer.currentPageNumber, 1);
});

test("Back works before the destination page loads, and Forward reuses its resolved destination", () => {
  const f = fixture(), destination = [null, { name: "XYZ" }, 30, 40, 2];
  f.follow(2, destination);
  f.viewer.getPageView = () => ({ pdfPage: null });
  f.history.back(); assert.equal(f.viewer.currentPageNumber, 1);
  f.history.forward(); assert.equal(f.viewer.currentPageNumber, 2);
  assert.deepEqual(f.visits.at(-1).destArray, destination);
});

test("links within a page still keep their distinct reading positions", () => {
  const f = fixture(); f.follow(1); f.history.back();
  assert.deepEqual(f.visits.at(-1).destArray.slice(2, 4), [10, 20]);
  f.history.forward(); assert.deepEqual(f.visits.at(-1).destArray.slice(2, 4), [30, 40]);
});
