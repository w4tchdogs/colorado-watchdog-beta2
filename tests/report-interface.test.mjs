import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServices } from "../dist/services/index.js";
import { createPublicSite } from "../dist/site/index.js";
import {
  mountReportInterface,
  ReportAccountChangedError,
  ReportChallengeRejectedError,
} from "../dist/site/report-interface.js";
import { createTurnstileChallenge } from "../dist/site/turnstile-widget.js";
import { createFictionalReportAdapter } from "../dist/site-dev/report-demo.js";
import { get, siteAssets, withPreview } from "./site-fixtures.mjs";

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
  const calls = { submissions: [], contexts: [], tracks: [] };
  const adapterOverrides = overrides.adapter ?? {};
  const adapter = {
    async submit(input, context) {
      calls.submissions.push(input);
      calls.contexts.push(context);
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

/** Fills the structured Employee & event and grievance fields for the workflow. */
function fillGrievance(
  document,
  window,
  { county = "08001", year, details } = {},
) {
  const change = (element, value) => {
    element.value = value;
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  const thisYear = new Date().getUTCFullYear();
  document.getElementById("report-unlisted-name").value =
    "Fictional Test Employee";
  document.getElementById("report-unlisted-office").value =
    "Fictional Test Office";
  change(document.getElementById("report-county"), county);
  change(
    document.getElementById("report-event-year"),
    String(year ?? thisYear),
  );
  const checkbox = document.getElementById("report-grievance-1");
  if (!checkbox.checked) {
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  document.getElementById("report-g0-details").value =
    details ?? "A fictional concern described for interface testing.";
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

test("submission chooser exposes only configured, trusted paths and leaves tracking available", async () => {
  await withPreview("empty", async (preview) => {
    const services = createServices({ database: preview.database });
    const disabled = createPublicSite({ services, assets: siteAssets() });
    for (const path of [
      "/submit-report",
      "/submit-report?guest=1",
      "/submit-report?account=1",
    ]) {
      const result = await get(disabled, path);
      assert.match(result.main(), /Report submission is currently unavailable/);
      assert.equal(result.$("#report-interface-root"), null);
      assert.ok(result.$('a[href="/track-report"]'));
    }

    const site = createPublicSite({
      services,
      assets: siteAssets(),
      reportSubmissionsEnabled: true,
      accountEntry: async (request) =>
        request.headers.get("cookie") === "fixture=authenticated"
          ? "signed-in"
          : "signed-out",
      reportAccountId: async () => "synthetic-account",
    });
    const entry = await get(site, "/submit-report");
    assert.ok(entry.$('a[href="/submit-report?guest=1"]'));
    assert.ok(
      entry.$('a[href="/auth/login?return_to=%2Fsubmit-report%3Faccount%3D1"]'),
    );
    const signedOut = await get(site, "/submit-report?account=1");
    assert.equal(signedOut.$("#report-interface-root"), null);
    const init = { headers: { cookie: "fixture=authenticated" } };
    const chooser = await get(site, "/submit-report", init);
    assert.ok(chooser.$('a[href="/submit-report?account=1"]'));
    assert.doesNotMatch(chooser.text, /synthetic-account/);
    const account = await get(site, "/submit-report?account=1", init);
    assert.ok(
      account.$(
        "[data-report-mode=account][data-report-account-id=synthetic-account]",
      ),
    );
    assert.match(account.headers.get("cache-control"), /no-store.*private/);
    const guest = await get(site, "/submit-report?guest=1", init);
    assert.ok(guest.$("[data-report-mode=guest]"));
    assert.doesNotMatch(guest.text, /synthetic-account/);
    assert.equal(
      (await get(site, "/submit-report?account=1&guest=1")).status,
      400,
    );
    assert.equal((await get(site, "/submit-report?guest=0")).status, 400);
  });
});

test("guest steps preserve entries, focus validation errors, certify and issue a private tracking link", async () => {
  const { document, dom, calls } = createHarness({
    submissionFlow: "guest",
    submitHref: "/submit-report",
    trackingHref: "/track-report",
  });
  const step = (number) => document.getElementById(`report-step-${number}`);
  const stepButton = (number) =>
    document.querySelector(`button[aria-controls="report-step-${number}"]`);
  const form = document.querySelector("#report-submit form");
  assert.equal(step(1).hidden, false);
  assert.equal(step(2).hidden, true);
  assert.equal(stepButton(1).getAttribute("aria-current"), "step");
  step(1).querySelector(".report-step-actions button").click();
  assert.equal(document.activeElement.id, "report-step-2-heading");
  stepButton(3).click();
  assert.equal(document.activeElement.id, "report-step-3-heading");
  const firstGrievance = document.getElementById("report-grievance-1");
  firstGrievance.checked = true;
  firstGrievance.dispatchEvent(
    new dom.window.Event("change", { bubbles: true }),
  );
  await submit(form, dom.window);
  assert.equal(calls.submissions.length, 0);
  assert.equal(document.activeElement.className, "report-error-summary");
  assert.equal(step(1).hidden, false);
  document
    .querySelector('.report-error-summary a[href="#report-g0-details"]')
    .click();
  assert.equal(document.activeElement.id, "report-g0-details");
  assert.equal(step(2).hidden, false);
  const descriptionField = document.getElementById("report-g0-details");
  descriptionField.value = "A fictional concern for the synthetic test.";
  descriptionField.dispatchEvent(
    new dom.window.Event("input", { bubbles: true }),
  );
  assert.equal(descriptionField.hasAttribute("aria-invalid"), false);
  assert.equal(
    document.querySelector(
      '.report-error-summary a[href="#report-g0-details"]',
    ),
    null,
  );
  fillGrievance(document, dom.window);
  stepButton(3).click();
  assert.match(step(3).textContent, /A fictional concern/);
  assert.match(step(3).textContent, /No supporting sources supplied/);
  assert.match(step(3).textContent, /Sent without your name/);
  assert.match(step(3).textContent, /allegations, not findings of fact/);
  await submit(form, dom.window);
  assert.equal(calls.submissions.length, 0);
  assert.equal(
    document
      .getElementById("report-certification")
      .getAttribute("aria-invalid"),
    "true",
  );
  assert.equal(document.getElementById("reporter-name").disabled, true);
  document.getElementById("reporter-name").value = "Synthetic private name";
  document.getElementById("report-certification").checked = true;
  document
    .getElementById("report-g0-details")
    .dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(document.getElementById("report-certification").checked, false);
  document.getElementById("report-certification").checked = true;
  await submit(form, dom.window);
  assert.equal(calls.submissions.length, 1);
  assert.equal(calls.submissions[0].reporter.attribution, "anonymous");
  assert.equal(calls.submissions[0].reporter.name, undefined);
  assert.equal(document.activeElement.id, "report-receipt-heading");
  const tracking = document.querySelector(".report-receipt a");
  assert.equal(tracking.getAttribute("href"), "/track-report");
  tracking.addEventListener("click", (event) => event.preventDefault(), {
    once: true,
  });
  tracking.click();
  assert.equal(
    document.querySelectorAll(".report-receipt code")[1].textContent,
    "",
  );
});

test("anonymous-name selection keeps the expected account binding for authenticated submission", async () => {
  const { document, dom, calls } = createHarness({
    submissionFlow: "account",
    account: { accountId: "synthetic-account" },
  });
  fillGrievance(document, dom.window);
  document.querySelector('button[aria-controls="report-step-3"]').click();
  document.getElementById("report-certification").checked = true;
  await submit(document.querySelector("#report-submit form"), dom.window);
  assert.equal(calls.submissions[0].reporter.attribution, "anonymous");
  assert.equal(calls.submissions[0].reporter.accountId, undefined);
  assert.equal(calls.contexts[0].accountExpectation, "synthetic-account");
  assert.equal(calls.submissions[0].reporter.name, undefined);
});

test("anonymous choice sends no name even after one was typed and hidden", async () => {
  for (const flow of ["guest", "account"]) {
    const { document, dom, calls } = createHarness({
      submissionFlow: flow,
      ...(flow === "account"
        ? { account: { accountId: "synthetic-account" } }
        : {}),
    });
    fillGrievance(document, dom.window);
    const anonymous = document.querySelector(
      'input[name="attribution"][value="anonymous"]',
    );
    const name = document.getElementById("reporter-name");
    if (flow === "guest") anonymous.click();
    else anonymous.checked = false;
    anonymous.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(name.disabled, false);
    name.value = "Fictional Name";
    anonymous.click();
    anonymous.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(name.disabled, true);
    document.querySelector('button[aria-controls="report-step-3"]').click();
    document.getElementById("report-certification").checked = true;
    await submit(document.querySelector("#report-submit form"), dom.window);
    assert.equal(calls.submissions.length, 1, flow);
    assert.equal(calls.submissions[0].reporter.name, undefined, flow);
    assert.equal(calls.submissions[0].reporter.attribution, "anonymous", flow);
  }
});

test("guest sharing a name privately is labeled and sent as an optional reviewer-only name", async () => {
  const { document, dom, calls } = createHarness({ submissionFlow: "guest" });
  fillGrievance(document, dom.window);
  assert.match(
    document.querySelector('label[for="reporter-name"]').textContent,
    /shared privately with reviewers/i,
  );
  const anonymous = document.querySelector(
    'input[name="attribution"][value="anonymous"]',
  );
  anonymous.click();
  anonymous.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  document.getElementById("reporter-name").value = "Fictional Name";
  document.querySelector('button[aria-controls="report-step-3"]').click();
  document.getElementById("report-certification").checked = true;
  await submit(document.querySelector("#report-submit form"), dom.window);
  assert.equal(calls.submissions[0].reporter.name, "Fictional Name");
  assert.equal(calls.submissions[0].reporter.accountId, undefined);
  assert.equal(calls.contexts[0], undefined);
});

test("an ended or changed account session shows recovery links and keeps the draft", async () => {
  const { document, dom, calls } = createHarness({
    submissionFlow: "account",
    account: { accountId: "synthetic-account" },
    accountRecovery: {
      signInHref: "/auth/login?return_to=%2Fsubmit-report%3Faccount%3D1",
      reloadHref: "/submit-report?account=1",
    },
    adapter: {
      async submit() {
        throw new ReportAccountChangedError("changed");
      },
    },
  });
  fillGrievance(document, dom.window);
  document.querySelector('button[aria-controls="report-step-3"]').click();
  document.getElementById("report-certification").checked = true;
  await submit(document.querySelector("#report-submit form"), dom.window);
  const links = [...document.querySelectorAll(".report-field-hint a")].map(
    (a) => [a.textContent, a.getAttribute("href")],
  );
  assert.deepEqual(links, [
    ["Sign in again", "/auth/login?return_to=%2Fsubmit-report%3Faccount%3D1"],
    ["Reload the form", "/submit-report?account=1"],
  ]);
  assert.match(
    document.querySelector(".report-status").textContent,
    /nothing was submitted/i,
  );
  assert.equal(document.getElementById("report-county").value, "08001");
  assert.equal(calls.submissions.length, 0);
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
  assert.equal(signedIn.calls.submissions[0].reporter.accountId, undefined);
  assert.equal(
    signedIn.calls.contexts[0].accountExpectation,
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

test("disabled mode shows an unavailable notice and no actionable submission form", () => {
  const { document } = createHarness({ submissionsEnabled: false });
  assert.equal(document.querySelector("#report-submit form"), null);
  assert.equal(document.querySelector("#report-submit button"), null);
  assert.equal(
    document.querySelector(
      "#report-submit input, #report-submit select, #report-submit textarea",
    ),
    null,
  );
  const notice = document.querySelector(".report-disabled-notice");
  assert.ok(notice, "expected a disabled notice element");
  assert.match(notice.textContent, /currently unavailable/i);
  assert.equal(notice.getAttribute("role"), "note");
});

test("disabled mode cannot invoke the submit adapter through synthetic events", async () => {
  const { document, dom, calls } = createHarness({ submissionsEnabled: false });
  const panel = document.getElementById("report-submit");
  panel.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.submissions.length, 0);
});

test("disabled mode still supports Track a Report", async () => {
  const { document, dom, calls } = createHarness({ submissionsEnabled: false });
  dom.window.location.hash = "#report-track";
  dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
  assert.equal(document.getElementById("report-track").hidden, false);
  document.getElementById("tracking-reference").value = "CW-0011223344556677";
  document.getElementById("tracking-recovery-key").value = "a".repeat(64);
  await submit(document.querySelector("#report-track form"), dom.window);
  assert.deepEqual(calls.tracks, [
    { reference: "CW-0011223344556677", recoveryKey: "a".repeat(64) },
  ]);
  const result = document.querySelector(".report-tracking-result");
  assert.equal(result.hidden, false);
});

test("enabled fictional mode preserves the full submission form and validation", async () => {
  const { document, dom, calls } = createHarness({ submissionsEnabled: true });
  assert.ok(document.querySelector("#report-submit form"));
  await submit(document.querySelector("#report-submit form"), dom.window);
  assert.equal(calls.submissions.length, 0);
  assert.equal(
    document.getElementById("report-county").getAttribute("aria-invalid"),
    "true",
  );
  setValidSubmission(document);
  await submit(document.querySelector("#report-submit form"), dom.window);
  assert.equal(calls.submissions.length, 1);
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
  assert.match(
    css,
    /\.report-grievance-table-scroll\s*\{[^}]*overflow-x: auto/s,
  );
  assert.match(
    css,
    /\.report-grievance-catalog-table\s*\{[^}]*min-width: 42rem/s,
  );
  assert.match(siteCss, /:focus-visible/);
  assert.equal(document.querySelector("script"), null);
  assert.match(
    document.querySelector(".report-demo-notice").textContent,
    /<script>/,
  );
  assert.equal(document.querySelector('input[type="file"]'), null);
  assert.equal(document.querySelectorAll('a[href^="#"]').length >= 2, true);
});

function fakeChallenge(behavior = {}) {
  const state = { acquires: 0, resets: 0, containers: [], messages: [] };
  const challenge = {
    disclosure: "Synthetic disclosure about the human check.",
    async acquire(container, announce) {
      state.acquires += 1;
      state.containers.push(container);
      announce("Synthetic widget loading.");
      state.messages.push(
        container.ownerDocument.querySelector("form .report-status")
          .textContent,
      );
      if (behavior.fail) throw new Error("widget failed");
      return `synthetic-token-${state.acquires}`;
    },
    reset() {
      state.resets += 1;
    },
  };
  return { challenge, state };
}

test("challenge: the disclosure is shown before any widget work and nothing runs until a valid submit", async () => {
  const { challenge, state } = fakeChallenge();
  const { document } = createHarness({ challenge });
  assert.match(
    document.body.textContent,
    /Synthetic disclosure about the human check\./,
  );
  assert.equal(document.querySelector(".report-challenge").hidden, true);
  assert.equal(state.acquires, 0);
  await submit(
    document.querySelector("form.report-form"),
    document.defaultView,
  );
  assert.equal(state.acquires, 0, "invalid drafts never start a check");
});

test("challenge: a valid submit runs the check, announces status and sends the token", async () => {
  const { challenge, state } = fakeChallenge();
  const contexts = [];
  const { document, calls } = createHarness({
    challenge,
    adapter: {
      async submit(input, context) {
        calls.submissions.push(input);
        contexts.push(context);
        return {
          reference: "CW-0011223344556677",
          recoveryKey: "b".repeat(64),
        };
      },
    },
  });
  setValidSubmission(document);
  await submit(
    document.querySelector("form.report-form"),
    document.defaultView,
  );
  assert.equal(state.acquires, 1);
  assert.deepEqual(contexts, [{ challengeToken: "synthetic-token-1" }]);
  assert.equal(state.messages[0], "Synthetic widget loading.");
  assert.equal(
    state.containers[0],
    document.querySelector(".report-challenge"),
  );
  const status = document.querySelector("form .report-status");
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.equal(document.querySelector(".report-receipt").hidden, false);
});

test("challenge: a failed check keeps the draft and idempotency key and allows a retry", async () => {
  let fail = true;
  const { challenge, state } = fakeChallenge();
  const acquire = challenge.acquire;
  challenge.acquire = (...args) =>
    fail ? Promise.reject(new Error("widget failed")) : acquire(...args);
  const keys = [];
  const { document, calls } = createHarness({
    challenge,
    createIdempotencyKey: () => {
      keys.push("created");
      return "stable-key";
    },
  });
  setValidSubmission(document, {
    description: "Draft text that must survive the retry.",
  });
  const form = document.querySelector("form.report-form");
  await submit(form, document.defaultView);
  assert.equal(calls.submissions.length, 0);
  assert.equal(state.resets, 1);
  assert.match(
    document.querySelector("form .report-status").textContent,
    /couldn't complete the human check/,
  );
  assert.equal(
    document.getElementById("report-description").value,
    "Draft text that must survive the retry.",
  );
  const button = form.querySelector('button[type="submit"]');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Submit privately for review");
  fail = false;
  await submit(form, document.defaultView);
  assert.equal(calls.submissions.length, 1);
  assert.equal(calls.submissions[0].idempotencyKey, "stable-key");
});

test("challenge: a refused token resets the widget, keeps the draft and reports it accessibly", async () => {
  const { challenge, state } = fakeChallenge();
  let attempts = 0;
  const tokens = [];
  const { document, calls } = createHarness({
    challenge,
    adapter: {
      async submit(input, context) {
        attempts += 1;
        tokens.push(context.challengeToken);
        if (attempts === 1) throw new ReportChallengeRejectedError("refused");
        calls.submissions.push(input);
        return {
          reference: "CW-0011223344556677",
          recoveryKey: "c".repeat(64),
        };
      },
    },
  });
  setValidSubmission(document);
  const form = document.querySelector("form.report-form");
  await submit(form, document.defaultView);
  assert.equal(state.resets, 1);
  assert.match(
    document.querySelector("form .report-status").textContent,
    /human check expired or was not accepted/,
  );
  assert.equal(document.getElementById("report-county").value, "08001");
  await submit(form, document.defaultView);
  assert.deepEqual(tokens, ["synthetic-token-1", "synthetic-token-2"]);
  assert.equal(calls.submissions.length, 1);
});

test("challenge: a service outage after the check resets the token and shows the generic message", async () => {
  const { challenge, state } = fakeChallenge();
  const { document } = createHarness({
    challenge,
    adapter: {
      async submit() {
        throw new Error("unavailable");
      },
    },
  });
  setValidSubmission(document);
  await submit(
    document.querySelector("form.report-form"),
    document.defaultView,
  );
  assert.equal(state.resets, 1);
  assert.match(
    document.querySelector("form .report-status").textContent,
    /couldn't submit this report/,
  );
});

test("without a challenge the adapter receives no context and no widget container exists", async () => {
  const contexts = [];
  const { document } = createHarness({
    adapter: {
      async submit(_input, context) {
        contexts.push(context);
        return {
          reference: "CW-0011223344556677",
          recoveryKey: "d".repeat(64),
        };
      },
    },
  });
  assert.equal(document.querySelector(".report-challenge"), null);
  setValidSubmission(document);
  await submit(
    document.querySelector("form.report-form"),
    document.defaultView,
  );
  assert.deepEqual(contexts, [undefined]);
});

function widgetHarness({ loadScript = true } = {}) {
  const dom = new JSDOM("<!doctype html><main id='app'></main>", {
    url: "https://demo.invalid/",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const rendered = [];
  const resets = [];
  const loads = [];
  const api = {
    render(container, parameters) {
      rendered.push({ container, parameters });
      return "widget-1";
    },
    reset(id) {
      resets.push(id);
    },
    remove() {},
  };
  const head = dom.window.document.head;
  const append = head.append.bind(head);
  head.append = (script) => {
    loads.push(script.src);
    append(script);
    if (loadScript) {
      dom.window.turnstile = api;
      script.onload?.();
    } else {
      script.onerror?.();
    }
  };
  return {
    dom,
    rendered,
    resets,
    loads,
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("widget loader: requests nothing until the first check, then loads the script once", async (t) => {
  const harness = widgetHarness();
  t.after(() => harness.restore());
  const challenge = createTurnstileChallenge("0x4AAAAAAA-synthetic");
  assert.deepEqual(harness.loads, []);
  const container = harness.dom.window.document.createElement("div");
  const messages = [];
  const first = challenge.acquire(container, (message) =>
    messages.push(message),
  );
  await tick();
  assert.deepEqual(harness.loads, [
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  ]);
  const { parameters } = harness.rendered[0];
  assert.equal(parameters.sitekey, "0x4AAAAAAA-synthetic");
  assert.equal(parameters.action, "submit-report");
  assert.equal(parameters["refresh-expired"], "manual");
  parameters["before-interactive-callback"]();
  parameters.callback("token-1");
  assert.equal(await first, "token-1");
  assert.ok(
    messages.some((message) => /complete the human check/.test(message)),
  );
  assert.ok(messages.includes("Human check complete."));

  // A second submit restarts the same widget only after the token was spent.
  challenge.reset();
  const second = challenge.acquire(container, () => {});
  await tick();
  assert.equal(harness.rendered.length, 1);
  assert.deepEqual(harness.resets, ["widget-1"]);
  parameters.callback("token-2");
  assert.equal(await second, "token-2");
  assert.equal(harness.loads.length, 1);
});

test("widget loader: widget errors and timeouts reject so the form can retry", async (t) => {
  const harness = widgetHarness();
  t.after(() => harness.restore());
  const challenge = createTurnstileChallenge("0x4AAAAAAA-synthetic");
  const container = harness.dom.window.document.createElement("div");
  const attempt = challenge.acquire(container, () => {});
  await tick();
  harness.rendered[0].parameters["error-callback"]();
  await assert.rejects(attempt, /Challenge failed/);
  challenge.reset();
  const retry = challenge.acquire(container, () => {});
  await tick();
  harness.rendered[0].parameters["timeout-callback"]();
  await assert.rejects(retry, /timed out/);
});

test("widget loader: a blocked script rejects and is requested again on the next try", async (t) => {
  const harness = widgetHarness({ loadScript: false });
  t.after(() => harness.restore());
  const challenge = createTurnstileChallenge("0x4AAAAAAA-synthetic");
  const container = harness.dom.window.document.createElement("div");
  await assert.rejects(
    challenge.acquire(container, () => {}),
    /unavailable/,
  );
  assert.equal(harness.rendered.length, 0);
  await assert.rejects(
    challenge.acquire(container, () => {}),
    /unavailable/,
  );
  assert.equal(harness.loads.length, 2);
  assert.equal(
    harness.dom.window.document.querySelectorAll("script").length,
    0,
  );
});

test("account-only hosts offer the signed-in form, hide guest intake and show no local-preview notice", async () => {
  await withPreview("empty", async (preview) => {
    const services = createServices({ database: preview.database });
    const site = createPublicSite({
      services,
      assets: siteAssets(),
      reportSubmissionsEnabled: true,
      reportGuestEnabled: false,
      accountEntry: async (request) =>
        request.headers.get("cookie") === "fixture=authenticated"
          ? "signed-in"
          : "signed-out",
      reportAccountId: async () => "synthetic-account",
    });
    const init = { headers: { cookie: "fixture=authenticated" } };
    const chooser = await get(site, "/submit-report", init);
    assert.ok(chooser.$('a[href="/submit-report?account=1"]'));
    assert.equal(chooser.$('a[href="/submit-report?guest=1"]'), null);
    assert.match(chooser.text, /Guest reporting is unavailable/);
    assert.doesNotMatch(chooser.text, /Local preview/);
    const guest = await get(site, "/submit-report?guest=1", init);
    assert.equal(guest.$("#report-interface-root"), null);
    const account = await get(site, "/submit-report?account=1", init);
    const root = account.$("[data-report-mode=account]");
    assert.ok(root);
    assert.equal(root.getAttribute("data-report-demo"), null);
    const signedOut = await get(site, "/submit-report?account=1");
    assert.equal(signedOut.$("#report-interface-root"), null);
  });
});
