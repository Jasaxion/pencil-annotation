import {defineConfig} from "vite";
import {resolve} from "node:path";

// Separate browser ESM: downloaded only when PDF export is requested.
export default defineConfig({
    build: {
        outDir: "build",
        emptyOutDir: false,
        lib: {entry: resolve("src/plugin/exportPdf.ts"), formats: ["es"], fileName: () => "pdf.js"},
        rollupOptions: {output: {inlineDynamicImports: true}},
    },
});
