import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import {
  createFileAssets,
  createSitePreview,
} from "../dist/site-dev/preview.js";

export const ORIGIN = "http://127.0.0.1:8790";
export const STATIC_DIRECTORY = fileURLToPath(
  new URL("../website/site/", import.meta.url),
);
export const FIXED_NOW = () => new Date("2026-11-13T12:00:00Z");

export const siteAssets = () => createFileAssets(STATIC_DIRECTORY);

/** Runs a callback against a disposable preview and always closes it. */
export async function withPreview(data, callback) {
  const preview = await createSitePreview({
    staticDirectory: STATIC_DIRECTORY,
    data,
    now: FIXED_NOW,
  });
  try {
    return await callback(preview);
  } finally {
    preview.close();
  }
}

export async function get(handler, path, init = {}) {
  const response = await handler.fetch(new Request(`${ORIGIN}${path}`, init));
  const text = await response.text();
  const isHtml = (response.headers.get("content-type") ?? "").includes("html");
  const dom = isHtml ? new JSDOM(text, { url: `${ORIGIN}${path}` }) : null;
  const document = dom?.window.document ?? null;
  return {
    status: response.status,
    headers: response.headers,
    text,
    document,
    $: (selector) => document?.querySelector(selector) ?? null,
    $$: (selector) => [...(document?.querySelectorAll(selector) ?? [])],
    main: () => document?.querySelector("main")?.textContent ?? "",
  };
}

/** Loads a page in jsdom and runs the real enhancement script against it. */
export async function getEnhanced(handler, path) {
  const response = await handler.fetch(new Request(`${ORIGIN}${path}`));
  const dom = new JSDOM(await response.text(), {
    url: `${ORIGIN}${path}`,
    runScripts: "outside-only",
  });
  dom.window.eval(readFileSync(`${STATIC_DIRECTORY}site.js`, "utf8"));
  const { document } = dom.window;
  return {
    window: dom.window,
    document,
    $: (selector) => document.querySelector(selector),
    $$: (selector) => [...document.querySelectorAll(selector)],
    type(element, value) {
      element.value = value;
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    },
    key(key) {
      document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key, bubbles: true }),
      );
    },
  };
}

export const internalLinks = (page) =>
  page
    .$$("a[href]")
    .map((a) => a.getAttribute("href"))
    .filter((href) => href.startsWith("/"));
