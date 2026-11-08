// Builds the renderer (React UI) into dist/ with esbuild — a single fast step, no Vite/Tailwind needed.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const dev = process.argv.includes("--dev");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
    entryPoints: { app: join(root, "src", "main.tsx") },
    outdir: out,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    jsx: "automatic",
    minify: !dev,
    sourcemap: dev,
    legalComments: "none",
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(/[;:]/) : [],
    logLevel: "info",
});
copyFileSync(join(root, "src", "index.html"), join(out, "index.html"));
console.log("renderer built →", out);
