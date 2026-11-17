import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createEditorApiClient } from "../dist/editor/api-client.js";
import { mountEditorApp } from "../dist/editor/app.js";
import { createEditorSandbox } from "../dist/editor-dev/sandbox.js";

export const HOST = "127.0.0.1:8788";
export const ORIGIN = `http://${HOST}`;

export function startSandbox(extra = {}) {
  return createEditorSandbox({
    staticDirectory: fileURLToPath(
      new URL("../website/editor/", import.meta.url),
    ),
    scriptDirectory: fileURLToPath(new URL("../dist/editor/", import.meta.url)),
    allowedHosts: [HOST],
    ...extra,
  });
}

/** An in-process fetch that behaves like a same-origin browser request. */
export function sandboxFetch(sandbox, hook) {
  return async (path, init) => {
    const headers = { origin: ORIGIN, ...init.headers };
    const call = { path, init: { ...init, headers } };
    const replacement = hook?.(call);
    if (replacement) return replacement;
    return sandbox.fetch(
      new Request(`${ORIGIN}${call.path}`, {
        method: call.init.method,
        headers: call.init.headers,
        ...(call.init.body === undefined ? {} : { body: call.init.body }),
        ...(call.init.signal ? { signal: call.init.signal } : {}),
      }),
    );
  };
}

export function makeClient(sandbox, session, hook) {
  return createEditorApiClient({
    fetch: sandboxFetch(sandbox, hook),
    token: sandbox.token,
    account: () => session.account,
  });
}

export async function waitFor(check, label = "condition", timeout = 4000) {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Mounts the real UI over the real sandbox in jsdom. */
export async function mountWorkspace({
  hash = "#/",
  hook,
  pageSize = 10,
  confirmLeave,
  sandbox: given,
} = {}) {
  const sandbox = given ?? (await startSandbox());
  const dom = new JSDOM("<!doctype html><body><div id=app></div></body>", {
    url: `${ORIGIN}/${hash}`,
  });
  const { window } = dom;
  const session = { account: "author" };
  const client = makeClient(sandbox, session, hook);
  const root = window.document.getElementById("app");
  const app = mountEditorApp(root, {
    doc: window.document,
    client,
    session,
    pageSize,
    previewDelayMs: 0,
    searchDelayMs: 0,
    ...(confirmLeave ? { confirmLeave } : {}),
  });
  const $ = (selector) => window.document.querySelector(selector);
  const $$ = (selector) => [...window.document.querySelectorAll(selector)];
  const type = (element, value) => {
    element.value = value;
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const click = (target) => {
    const element = typeof target === "string" ? $(target) : target;
    if (!element) throw new Error(`Missing element: ${target}`);
    element.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  };
  const change = (element) =>
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  const text = (selector) => $(selector)?.textContent ?? "";
  const titleInput = () => $("input[id$=-title]");
  const bodyInput = () => $("textarea[id$=-body]");
  const summaryInput = () => $("textarea[id$=-summary]");
  return {
    sandbox,
    dom,
    window,
    session,
    client,
    app,
    $,
    $$,
    type,
    click,
    change,
    text,
    titleInput,
    bodyInput,
    summaryInput,
    async close() {
      app.destroy();
      window.close();
      sandbox.close();
    },
  };
}
