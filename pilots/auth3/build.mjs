import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const root = new URL(".", import.meta.url).pathname.replace(/^\//, "");
const dist = join(root, "dist");
await mkdir(join(dist,"server"),{recursive:true});
await mkdir(join(dist,".openai","drizzle"),{recursive:true});
await build({entryPoints:[join(root,"worker.mjs")],outfile:join(dist,"server","index.js"),bundle:true,platform:"browser",format:"esm",target:"es2022"});
await cp(join(root,".openai","hosting.json"),join(dist,".openai","hosting.json"));
await cp(join(root,".openai","drizzle","0001_auth3_pilot.sql"),join(dist,".openai","drizzle","0001_auth3_pilot.sql"));
const config = JSON.parse(await readFile(join(dist,".openai","hosting.json"),"utf8"));
if (config.d1 !== "DB" || config.r2 !== null || !config.project_id) throw new Error("Invalid isolated pilot hosting manifest");
console.log("Prepared isolated AUTH-3 Worker and its single synthetic D1 migration.");
