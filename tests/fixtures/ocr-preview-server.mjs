// Run `npm run build`, then `node tests/fixtures/ocr-preview-server.mjs`.
import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createServer } from "node:http";
const root = process.cwd();
const output = resolve(root, "node_modules/.cache/ocr-preview");
await mkdir(output, { recursive: true });
let html = await readFile("tests/fixtures/ocr-preview.html", "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
await build({ stdin: { contents: script, resolveDir: resolve(root, "tests/fixtures"), loader: "ts" }, outfile: resolve(output, "fixture.js"), bundle: true, format: "esm", platform: "browser" });
html = html.replace(/<script type="module">[\s\S]*?<\/script>/, '<link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script>');
const manifest = JSON.parse(await readFile("public/manifest.json", "utf8"));
createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (pathname === "/") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); return; }
    const file = pathname.startsWith("/dist/") ? resolve(root, `.${pathname}`) : resolve(output, `.${pathname}`);
    if (!file.startsWith(resolve(root, "dist") + sep) && !file.startsWith(output + sep)) { response.writeHead(403).end(); return; }
    const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".html": "text/html" }[extname(file)];
    response.setHeader("Content-Type", mime || "application/octet-stream");
    if (pathname === "/dist/ocr-sandbox.html") response.setHeader("Content-Security-Policy", manifest.content_security_policy.sandbox.replace("chrome-extension:", "http://127.0.0.1:5175"));
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
}).listen(5175, "127.0.0.1", () => console.log("OCR preview: http://127.0.0.1:5175"));
