import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cdp/index.ts", "src/mcp/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  minify: false,
  target: "es2022",
  external: ["zod", "chrome"],
});
