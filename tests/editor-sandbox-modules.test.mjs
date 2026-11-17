import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ORIGIN, startSandbox } from "./editor-fixtures.mjs";

const distribution = (name) =>
  fileURLToPath(new URL(`../dist/editor/${name}`, import.meta.url));

/** Every module the browser loads from main.js must be served by the sandbox. */
test("the sandbox serves every module the dashboard imports at runtime", async () => {
  const sandbox = await startSandbox();
  try {
    const seen = new Set();
    const queue = ["main.js"];
    while (queue.length > 0) {
      const name = queue.shift();
      if (seen.has(name)) continue;
      seen.add(name);
      const response = await sandbox.fetch(
        new Request(`${ORIGIN}/app/${name}`),
      );
      assert.equal(response.status, 200, `/app/${name} must be served`);
      const source = readFileSync(distribution(name), "utf8");
      for (const match of source.matchAll(/\bfrom\s+"(\.[^"]+)"/g)) {
        const specifier = match[1];
        assert.match(
          specifier,
          /^\.\/[a-z0-9-]+\.js$/,
          `${name} imports ${specifier}, which the browser cannot resolve under /app/`,
        );
        queue.push(specifier.slice(2));
      }
    }
    assert.ok(seen.size > 15);
  } finally {
    sandbox.close();
  }
});
