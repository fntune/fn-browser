import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/host-classification.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
