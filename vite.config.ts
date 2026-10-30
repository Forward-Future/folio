import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    license: true,
    // pdf.js alone is ~800 KB minified; it is one library and can't usefully be split further.
    chunkSizeWarningLimit: 1200,
  },
});
