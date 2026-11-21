import assert from "node:assert/strict";
import test from "node:test";
import { ORIGIN, startSandbox } from "./editor-fixtures.mjs";

test("the sandbox serves a dashboard bundle without runtime module imports", async () => {
  const sandbox = await startSandbox();
  try {
    const response = await sandbox.fetch(new Request(`${ORIGIN}/app/main.js`));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/javascript/);
    const source = await response.text();
    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.match(source, /profiles-heading/);
    assert.match(source, /cs-hierarchy-title/);
  } finally {
    sandbox.close();
  }
});
