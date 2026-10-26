// pdf_viewer.mjs reads the core library from globalThis.pdfjsLib at import time.
import * as pdfjsLib from "pdfjs-dist";

(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib;
