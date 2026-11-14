import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mountReportInterface } from "../dist/site/report-interface.js";
import { createFictionalReportAdapter } from "../dist/site-dev/report-demo.js";

const migration = readFileSync(
  new URL("../website/migrations/0001_counties.sql", import.meta.url),
  "utf8",
);
const counties = [...migration.matchAll(/\('(\d{5})', '([^']+)'\)/g)].map(
  ([, fips, name]) => ({ fips, name }),
);
const date = "2026-11-13T12:00:00.000Z";
const projection = {
  status: "submitted",
  submittedAt: date,
  history: [{ from: null, to: "submitted", at: date }],
};

function createHarness(overrides = {}) {
  const dom = new JSDOM("<!doctype html><main id='app'></main>", {
    url: "https://demo.invalid/",
  });
  const root = dom.window.document.getElementById("app");
  const calls = { submissions: [], tracks: [] };
  const adapterOverrides = overrides.adapter ?? {};
  const adapter = {
    async submit(input) {
      calls.submissions.push(input);
      return {
        reference: "CW-0011223344556677",
        recoveryKey: "a".repeat(64),
      };
    },
    async track(reference, recoveryKey) {
      calls.tracks.push({ reference, recoveryKey });
      return projection;
    },
    ...adapterOverrides,
  };
  const { adapter: _adapter, ...optionOverrides } = overrides;
  mountReportInterface(root, {
    counties,
    adapter,
    createIdempotencyKey: () => "synthetic-idempotency-key",
    ...optionOverrides,
  });
  return { dom, document: dom.window.document, root, calls, adapter };
}

function setValidSubmission(document, { description, county = "08001" } = {}) {
  document.getElementById("report-county").value = county;
  document.getElementById("report-description").value =
    description ?? "A fictional concern described for interface testing.";
}

async function submit(form, window) {
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await new Promise((resolve) => setImmediate(resolve));
}

test("renders all 64 registry counties, accessible report fields, and both screens", () => {
  assert.equal(counties.length, 64);
  const { document } = createHarness();
  assert.equal(document.querySelectorAll("#report-county option").length, 65);
  assert.equal(document.querySelectorAll(".report-tabs a").length, 2);
  assert.equal(
    document.getElementById("report-submit-heading").textContent,
    "Submit a Report",
  );
  assert.equal(
    document.getElementById("report-track-heading").textContent,
    "Track a Report",
  );
  assert.equal(document.querySelector('input[type="file"]'), null);
  assert.equal(document.getElementById("tracking-reference").required, true);
  assert.equal(document.getElementById("tracking-recovery-key").required, true);
  for (const control of document.querySelectorAll("input, select, textarea")) {
    assert.ok(
      control.labels?.length,
      `${control.id || control.name} should have an accessible label`,
    );
  }
  assert.equal(
    document.querySelector('[aria-live="polite"]')?.getAttribute("role"),
    "status",
  );
});

test("validates required fields and preserves values after a recoverable error", async () => {
  const { document, dom, calls } = createHarness();
  await submit(document.querySelector("#report-submit form"), dom.window);
  assert.equal(calls.submissions.length, 0);
  assert.equal(
    document.getElementById("report-county").getAttribute("aria-invalid"),
    "true",
  );
  assert.equal(
    document.getElementById("report-description").getAttribute("aria-invalid"),
    "true",
  );

  setValidSubmission(document);
  document.getElementById("report-description").value =
    "A valid fictional concern with enough characters.";
  await submit(document.querySelector("#report-submit form"), dom.window);
  assert.equal(calls.submissions.length, 1);
  assert.equal(calls.submissions[0].countyId, "08001");
  assert.equal(
    calls.submissions[0].description,
    "A valid fictional concern with enough characters.",
  );
});

test("enforces county selection, description limits, and HTTPS evidence validation", async () => {
  const { document, dom, calls } = createHarness();
  setValidSubmission(document, { county: "not-a-county" });
  document.getElementById("report-description").value = "x".repeat(12001);
  document.querySelector(".report-button-quiet").click();
  const source = document.querySelector(".report-evidence-row");
  source.querySelector('input[type="text"]').value = "Synthetic source";
  source.querySelector('input[type="url"]').value =
    "https://user:password@example.invalid/source";
  await submit(document.querySelector("#report-submit form"), dom.window);
  assert.equal(calls.submissions.length, 0);
  assert.match(
    document.getElementById("report-county-error").textContent,
    /county/i,
  );
  assert.match(
    document.getElementById("report-description-error").textContent,
    /12,000/i,
  );
  assert.match(
    [...source.querySelectorAll(".report-field-error")]
      .map((item) => item.textContent)
      .join(" "),
    /HTTPS URL/,
  );
  assert.equal(
    document.getElementById("report-description").value,
    "x".repeat(12001),
  );
});

test("supports optional subjects and anonymous versus authenticated attribution", async () => {
  const anonymous = createHarness();
  setValidSubmission(anonymous.document);
  await submit(
    anonymous.document.querySelector("#report-submit form"),
    anonymous.dom.window,
  );
  assert.equal(anonymous.calls.submissions[0].subject, undefined);
  assert.equal(
    anonymous.calls.submissions[0].reporter.attribution,
    "anonymous",
  );
  assert.equal(anonymous.calls.submissions[0].reporter.accountId, undefined);

  const signedIn = createHarness({
    account: {
      accountId: "synthetic-account",
      name: "Fictional Reporter",
      email: "reporter@example.invalid",
    },
  });
  setValidSubmission(signedIn.document);
  const doc = signedIn.document;
  doc.getElementById("report-subject-kind").value = "organization";
  doc
    .getElementById("report-subject-kind")
    .dispatchEvent(new signedIn.dom.window.Event("change", { bubbles: true }));
  doc.getElementById("report-subject-id").value = "synthetic-organization";
  doc.querySelector('input[name="attribution"][value="signed"]').click();
  await submit(doc.querySelector("#report-submit form"), signedIn.dom.window);
  assert.deepEqual(signedIn.calls.submissions[0].subject, {
    kind: "organization",
    id: "synthetic-organization",
  });
  assert.equal(signedIn.calls.submissions[0].reporter.attribution, "signed");
  assert.equal(
    signedIn.calls.submissions[0].reporter.accountId,
    "synthetic-account",
  );
  assert.equal(
    signedIn.calls.submissions[0].reporter.name,
    "Fictional Reporter",
  );
});

test("requires contact email when selected and accepts valid reporter contact", async () => {
  const { document, dom, calls } = createHarness();
  setValidSubmission(document);
  document.getElementById("report-contact-preference").value = "email";
  await submit(document.querySelector("#report-submit form"), dom.window);
  assert.equal(calls.submissions.length, 0);
  assert.match(
    document.getElementById("reporter-email-error").textContent,
    /email/i,
  );
  document.getElementById("reporter-email").value = "reporter@example.invalid";
  await submit(document.querySelector("#report-submit form"), dom.window);
  assert.equal(calls.submissions.length, 1);
  assert.equal(calls.submissions[0].reporter.contactPreference, "email");
  assert.equal(calls.submissions[0].reporter.email, "reporter@example.invalid");
});

test("prevents duplicate submissions while an adapter call is pending", async () => {
  let release;
  const { document, dom, calls } = createHarness({
    adapter: {
      submit: (input) => {
        calls.submissions.push(input);
        return new Promise((resolve) => {
          release = () =>
            resolve({
              reference: "CW-0011223344556677",
              recoveryKey: "b".repeat(64),
            });
        });
      },
    },
  });
  setValidSubmission(document);
  const form = document.querySelector("#report-submit form");
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  assert.equal(calls.submissions.length, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector(".report-receipt").hidden, false);
});

test("reuses its idempotency key after a recoverable adapter failure", async () => {
  const submitted = [];
  let attempts = 0;
  const { document, dom } = createHarness({
    adapter: {
      submit: async (input) => {
        submitted.push(input);
        attempts += 1;
        if (attempts === 1) throw new Error("temporary fixture failure");
        return { reference: "CW-0011223344556677" };
      },
    },
  });
  setValidSubmission(document);
  const form = document.querySelector("#report-submit form");
  await submit(form, dom.window);
  assert.match(
    document.querySelector(".report-status").textContent,
    /couldn't submit/i,
  );
  await submit(form, dom.window);
  assert.equal(submitted.length, 2);
  assert.equal(submitted[0].idempotencyKey, submitted[1].idempotencyKey);
});

test("shows receipt credentials once and clears the recovery key when leaving receipt", async () => {
  const { document, dom } = createHarness();
  setValidSubmission(document);
  await submit(document.querySelector("#report-submit form"), dom.window);
  assert.equal(document.querySelector(".report-receipt").hidden, false);
  assert.equal(
    document.querySelector(".report-receipt code").textContent,
    "CW-0011223344556677",
  );
  assert.equal(
    document.querySelectorAll(".report-receipt code")[1].textContent,
    "a".repeat(64),
  );
  assert.match(
    document.querySelector(".report-receipt").textContent,
    /cannot be retrieved later/i,
  );
  document.getElementById("report-track").scrollIntoView = () => {};
  dom.window.location.hash = "#report-track";
  dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
  assert.equal(dom.window.location.href.includes("a".repeat(64)), false);
  assert.equal(
    document.querySelectorAll(".report-receipt code")[1].textContent,
    "",
  );
  assert.match(
    document.querySelector(".report-receipt").textContent,
    /no longer displayed/i,
  );
  assert.equal(
    document.querySelector('button[aria-label="Copy recovery key"]'),
    null,
  );
  assert.equal(dom.window.localStorage.length, 0);
});

test("handles replay receipts without redisclosing a recovery key", async () => {
  const { document, dom } = createHarness({
    adapter: { submit: async () => ({ reference: "CW-0011223344556677" }) },
  });
  setValidSubmission(document);
  await submit(document.querySelector("#report-submit form"), dom.window);
  assert.equal(document.querySelectorAll(".report-receipt code").length, 2);
  assert.equal(
    document.querySelectorAll(".report-receipt code")[1].textContent,
    "",
  );
  assert.match(
    document.querySelector(".report-receipt").textContent,
    /cannot be shown again/i,
  );
  assert.equal(
    document.querySelector(".report-receipt button:nth-of-type(2)").hidden,
    true,
  );
});

test("tracks with entered credentials and displays only the reporter-safe projection", async () => {
  const { document, dom, calls } = createHarness({
    adapter: {
      track: async (reference, recoveryKey) => {
        calls.tracks.push({ reference, recoveryKey });
        return {
          status: "under-review",
          submittedAt: date,
          history: [
            { from: null, to: "submitted", at: date },
            { from: "submitted", to: "under-review", at: date },
          ],
        };
      },
    },
  });
  dom.window.location.hash = "#report-track";
  dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
  document.getElementById("tracking-reference").value = " cw-0011223344556677 ";
  document.getElementById("tracking-recovery-key").value = "c".repeat(64);
  await submit(document.querySelector("#report-track form"), dom.window);
  assert.deepEqual(calls.tracks, [
    { reference: "CW-0011223344556677", recoveryKey: "c".repeat(64) },
  ]);
  const result = document.querySelector(".report-tracking-result");
  assert.equal(result.hidden, false);
  assert.match(result.textContent, /Under review/);
  assert.match(result.textContent, /Submitted/);
  assert.equal(result.textContent.includes("rpt_internal"), false);
  assert.equal(result.querySelectorAll("li").length, 2);
  assert.equal(document.getElementById("tracking-recovery-key").value, "");
});

test("uses one generic message for invalid or nonexistent tracking credentials", async () => {
  const { document, dom } = createHarness({
    adapter: {
      track: async () => {
        throw new Error("credential not found: secret detail");
      },
    },
  });
  dom.window.location.hash = "#report-track";
  dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
  document.getElementById("tracking-reference").value = "CW-0000000000000000";
  document.getElementById("tracking-recovery-key").value = "d".repeat(64);
  await submit(document.querySelector("#report-track form"), dom.window);
  const message = document.querySelector(".report-tracking-error").textContent;
  assert.equal(
    message,
    "We couldn't verify those credentials. Check them and try again.",
  );
  assert.equal(message.includes("secret detail"), false);
});

test("renders injected values as text and exposes no secret in URLs or browser storage", async () => {
  const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const { document, dom } = createHarness({
    adapter: {
      submit: async () => ({
        reference: attack,
        recoveryKey: "e".repeat(64),
      }),
    },
  });
  setValidSubmission(document, { description: attack });
  document.getElementById("report-demo")?.setAttribute("data-attack", attack);
  await submit(document.querySelector("#report-submit form"), dom.window);
  assert.equal(document.querySelector("img"), null);
  assert.equal(document.querySelector("script"), null);
  assert.equal(
    document.querySelector(".report-receipt code").textContent,
    attack,
  );
  assert.equal(dom.window.location.search.includes("e".repeat(64)), false);
  assert.equal(dom.window.localStorage.length, 0);
});

test("fictional adapter keeps only a credential digest and never rediscloses keys", async () => {
  const adapter = createFictionalReportAdapter(() => new Date(date));
  const input = {
    countyId: "08001",
    description: "Synthetic-only input for the browser memory adapter.",
    evidence: [],
    reporter: {
      attribution: "anonymous",
      confidential: true,
      contactPreference: "none",
    },
    idempotencyKey: "synthetic-demo-request",
  };
  const first = await adapter.submit(input);
  assert.match(first.reference, /^CW-[A-F0-9]{16}$/);
  assert.match(first.recoveryKey, /^[a-f0-9]{64}$/);
  const replay = await adapter.submit(input);
  assert.equal(replay.reference, first.reference);
  assert.equal(replay.recoveryKey, undefined);
  const tracked = await adapter.track(first.reference, first.recoveryKey);
  assert.deepEqual(tracked, projection);
  await assert.rejects(adapter.track(first.reference, "f".repeat(64)));
});

test("includes responsive rules, visible keyboard focus, and no upload control", () => {
  const css = readFileSync(
    new URL("../website/site/report-interface.css", import.meta.url),
    "utf8",
  );
  const siteCss = readFileSync(
    new URL("../website/site/site.css", import.meta.url),
    "utf8",
  );
  const { document } = createHarness({
    demoNotice: "<script>not markup</script>",
  });
  assert.match(css, /@media \(max-width: 40rem\)/);
  assert.match(siteCss, /:focus-visible/);
  assert.equal(document.querySelector("script"), null);
  assert.match(
    document.querySelector(".report-demo-notice").textContent,
    /<script>/,
  );
  assert.equal(document.querySelector('input[type="file"]'), null);
  assert.equal(document.querySelectorAll('a[href^="#"]').length >= 2, true);
});
