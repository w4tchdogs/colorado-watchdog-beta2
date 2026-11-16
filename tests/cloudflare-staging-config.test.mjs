import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("staging config preserves operator variables and leaves auth fail-closed", async () => {
  const generated = spawnSync(
    process.execPath,
    [resolve(root, "scripts/cloudflare-staging-config.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        WATCHDOG_STAGING_ACCOUNT_ID: "e137ca17e819d5761088a98f59f6a8ff",
        WATCHDOG_STAGING_D1_ID: "4a4a6c6a-756b-4f13-aafa-0242939d950f",
        WATCHDOG_STAGING_R2_BUCKET_NAME: "colorado-watchdog-alpha1-staging",
      },
    },
  );
  assert.equal(generated.status, 0, generated.stderr);

  const config = await readFile(
    resolve(root, ".wrangler/wrangler.cloudflare-staging.toml"),
    "utf8",
  );
  assert.match(config, /^keep_vars = true$/m);
  assert.doesNotMatch(config, /^AUTH0_ENABLED\s*=/m);
  assert.match(config, /^REPORTS_TURNSTILE = "disabled"$/m);
  assert.match(
    config,
    /^database_id = "4a4a6c6a-756b-4f13-aafa-0242939d950f"$/m,
  );
});
