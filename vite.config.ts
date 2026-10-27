import { resolve } from "node:path";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { build as bundle } from "esbuild";
import { defineConfig } from "vite";
import manifest from "./public/manifest.json";
import { browserManifest } from "./build/manifest";
import { verifyOcrRuntime } from "./build/ocr/verify";

export default defineConfig(({ mode }) => {
  const firefox = mode === "firefox";
  const outDir = firefox ? "dist-firefox" : "dist";
  const target = firefox ? "firefox154" : "chrome120";
  const sourcemap = process.env.WUPAGE_SOURCEMAP === "1";
  return {
    plugins: [{
      name: "bundle-local-ocr-runtime",
      async closeBundle() {
        const runtime = await verifyOcrRuntime(resolve(__dirname));
        // Manifest content scripts are classic scripts. Bundle them independently
        // so shared helpers cannot introduce Rollup's module imports into content.js.
        await writeFile(resolve(__dirname, outDir, "manifest.json"), JSON.stringify(browserManifest(manifest, firefox), null, 2) + "\n");
        await bundle({ entryPoints: ["src/content/index.ts"], outfile: resolve(__dirname, outDir, "content.js"),
          bundle: true, minify: true, sourcemap, format: "iife", platform: "browser", target });
        const output = resolve(__dirname, outDir, "ocr-runtime");
        await mkdir(output, { recursive: true });
        await bundle({ entryPoints: ["src/ocr/sandbox.ts"], outfile: resolve(output, "engine.js"), bundle: true, minify: true, format: "iife", platform: "browser", target, external: ["fs", "path"],
          conditions: ["onnxruntime-web-use-extern-wasm"],
          plugins: [{ name: "ocr-ort-adapter", setup(build) {
            build.onResolve({ filter: /^onnxruntime-web$/ }, () => ({ path: resolve(__dirname, "src/ocr/ort-runtime.ts") }));
            build.onResolve({ filter: /^@techstark\/opencv-js$/ }, () => ({ path: resolve(runtime, "opencv.js") }));
          } }], define: { "process.env.NODE_ENV": '"production"' } });
        for (const file of ["opencv.wasm", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm",
          "opencv-LICENSE.txt", "opencv-NOTICES.txt", "onnxruntime-LICENSE.txt", "onnxruntime-NOTICES.txt"]) {
          await copyFile(resolve(runtime, file), resolve(output, file));
        }
        const bergamotOutput = resolve(__dirname, outDir, "bergamot-runtime");
        await mkdir(bergamotOutput, { recursive: true });
        for (const file of ["translator-worker.js", "bergamot-translator-worker.js", "bergamot-translator-worker.wasm"]) {
          const source = resolve(__dirname, "node_modules/@browsermt/bergamot-translator/worker", file);
          if (firefox && file === "translator-worker.js") {
            const contents = await readFile(source, "utf8");
            const fetchWasm = "const response = await self.fetch(new URL('./bergamot-translator-worker.wasm', self.location));";
            if (!contents.includes(fetchWasm)) throw new Error("Bergamot worker WASM loading changed; review the Firefox adapter.");
            await writeFile(resolve(bergamotOutput, file), contents.replace(fetchWasm,
              'const response = new Response(this.options.wasmBinary, { headers: { "Content-Type": "application/wasm" } });'));
          } else await copyFile(source, resolve(bergamotOutput, file));
        }
      }
    }],
    build: {
      outDir,
      target,
      emptyOutDir: true,
      sourcemap,
      modulePreload: false,
      rollupOptions: {
        input: {
          background: resolve(__dirname, "src/background/index.ts"),
          popup: resolve(__dirname, "popup.html"),
          options: resolve(__dirname, "options.html"),
          pdf: resolve(__dirname, "pdf.html"),
          ocrOffscreen: resolve(__dirname, "ocr-offscreen.html")
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]"
        }
      }
    }
  };
});
