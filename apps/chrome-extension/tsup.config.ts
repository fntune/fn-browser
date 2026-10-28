import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/background/index.ts",
    "src/content/stop-overlay.ts",
    "src/sidepanel/index.tsx",
  ],
  format: ["esm"],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: false,
  minify: false,
  target: "es2022",
  platform: "browser",
  outDir: "dist",
  outExtension: () => ({ js: ".js" }),
  // Chrome loads the extension as a static folder — no node_modules resolution.
  // Bundle workspace deps inline so "@fn-browser/browser/cdp" resolves. Bundle React +
  // Radix + TanStack too so the side panel is self-contained.
  noExternal: [
    /^@fn-browser\//,
    "react",
    "react-dom",
    "react-dom/client",
    /^@radix-ui\//,
    "@tanstack/react-query",
    "motion",
    "motion/react",
    "lucide-react",
    "class-variance-authority",
    "clsx",
    "tailwind-merge",
  ],
  onSuccess: async () => {
    // Copy static assets (manifest, html) to dist/ so the folder can be loaded
    // unpacked into Chrome. globals.css is written by the sibling `build:css`
    // Tailwind CLI step — package.json chains the two.
    const dist = resolve("dist");
    mkdirSync(dist, { recursive: true });
    copyFileSync("manifest.json", resolve(dist, "manifest.json"));
    copyFileSync("managed-schema.json", resolve(dist, "managed-schema.json"));
    copyFileSync("public/sidepanel.html", resolve(dist, "sidepanel.html"));
  },
});
