import {resolve} from "path";
import {fileURLToPath} from "url";
import {defineConfig} from "vite";
import manifest from "./plugin.json";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({command}) => ({
    define: {__PENCIL_DEV__: JSON.stringify(command === "serve"), __PENCIL_VERSION__: JSON.stringify(manifest.version)},
    optimizeDeps: {include: ["jspdf", "modern-screenshot"]},
    resolve: command === "serve" ? {alias: {siyuan: resolve(__dirname, "test/siyuan.ts")}} : undefined,
    build: {
        outDir: "build",
        emptyOutDir: true,
        lib: {
            entry: resolve(__dirname, "src/index.ts"),
            formats: ["cjs"],
            fileName: () => "index.js",
        },
        rollupOptions: {
            external: ["siyuan"],
        },
        sourcemap: process.env.NODE_ENV === "development",
    },
}));
