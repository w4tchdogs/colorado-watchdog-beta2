// Bundles the Worker entry point into one ES module. Local and CI only. Deploys nothing.
import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
const result = await build({
  entryPoints: ["src/worker.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  metafile: true,
  logLevel: "warning",
});
const inputs = Object.keys(result.metafile.inputs);
const forbidden = inputs.filter((file) => file.includes("node-sqlite") || file.includes("migrate"));
if (forbidden.length > 0) {
  throw new Error(`Local-only modules reached the Worker bundle: ${forbidden.join(", ")}`);
}
const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`Built dist/server/index.js (${bytes} bytes) from ${inputs.length} modules.`);
