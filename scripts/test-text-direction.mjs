import assert from "node:assert/strict";
import { test } from "node:test";
import { hasRightToLeft, unsupportedDirection, RIGHT_TO_LEFT_MESSAGE } from "../src/textDirection.ts";

const at = (...points) => String.fromCodePoint(...points);

test("right-to-left scripts are detected", () => {
  // "Murad Nasser" in Arabic, the name from the report.
  assert.equal(hasRightToLeft(at(0x645, 0x631, 0x627, 0x62f, 0x20, 0x646, 0x627, 0x635, 0x631)), true);
  // "Shalom" in Hebrew.
  assert.equal(hasRightToLeft(at(0x5e9, 0x5dc, 0x5d5, 0x5dd)), true);
  for (const [name, point] of [
    ["Syriac", 0x710], ["Thaana", 0x780], ["N'Ko", 0x7ca], ["Arabic Extended-A", 0x8a0],
    ["Hebrew presentation form", 0xfb1d], ["Arabic presentation form A", 0xfdf2],
    ["Arabic presentation form B", 0xfefb], ["Phoenician", 0x10900], ["Adlam", 0x1e900],
  ]) assert.equal(hasRightToLeft(at(point)), true, name);
});

test("one right-to-left character in left-to-right text is enough", () => {
  // Arabic-Indic digits reorder too.
  assert.equal(hasRightToLeft("Invoice " + at(0x662, 0x660, 0x662, 0x666)), true);
  assert.equal(hasRightToLeft("Total: " + at(0x5e9) + " 40"), true);
});

test("left-to-right text is left alone", () => {
  for (const text of [
    "", "Original", "Résumé 2026", at(0x65e5, 0x672c, 0x8a9e), at(0x1f642), at(0x10348),
    at(0x58f), at(0x900), at(0xfb00), at(0xfe6f), at(0xfeff), at(0xff21), at(0x107ff), at(0x11000),
  ]) assert.equal(hasRightToLeft(text), false, JSON.stringify(text));
});

test("the message says what can't be edited", () => {
  assert.match(RIGHT_TO_LEFT_MESSAGE, /right-to-left/);
});

test("Arabic editing accepts Arabic and mixed Latin lines and preserves the protection for other RTL scripts", () => {
  for (const text of ["مَرْحَبًا 2026", "PDF (العربية)", "Original"]) assert.equal(unsupportedDirection(text), false);
  for (const text of ["שלום", "العربية שלום", "ܫܠܡܐ"]) assert.equal(unsupportedDirection(text), true);
});
