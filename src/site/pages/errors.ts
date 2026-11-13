import { html } from "../html.js";
import type { Page } from "../types.js";

const HELP_LINKS = html`<ul class="link-list">
  <li><a href="/counties">Browse all 64 counties</a></li>
  <li><a href="/people">Search people</a></li>
  <li><a href="/organizations">Search organizations</a></li>
  <li><a href="/">Go to the homepage</a></li>
</ul>`;

function errorPage(
  status: number,
  title: string,
  detail: string,
  extra = html``,
): Page {
  return {
    status,
    title,
    body: html`<section class="error-page">
      <p class="error-code">Error ${status}</p>
      <h1>${title}</h1>
      <p class="lede">${detail}</p>
      ${extra}
      ${HELP_LINKS}
    </section>`,
  };
}

export function notFoundPage(what: string): Page {
  return errorPage(
    404,
    what === "page" ? "Page not found" : `No ${what} record at this address`,
    what === "page"
      ? "This address does not match a page on Colorado Watchdog. It may have been typed incorrectly."
      : `There is no ${what} with this identifier in the database. The link may be out of date, or the record may not exist.`,
  );
}

export function badRequestPage(restartHref: string): Page {
  return errorPage(
    400,
    "That link can't be used",
    "Part of this address is not valid, often because a page link is out of date or was shortened.",
    html`<p><a class="button" href="${restartHref}">Start again from the first page</a></p>`,
  );
}

export function unavailablePage(): Page {
  return errorPage(
    503,
    "Records are temporarily unavailable",
    "The site could not reach its database. Nothing is wrong with your request. Try again in a few minutes.",
  );
}

export function serverErrorPage(): Page {
  return errorPage(
    500,
    "Something went wrong",
    "The page could not be displayed because of an error on the site. Try again, or use one of the links below.",
  );
}

export function methodNotAllowedPage(): Page {
  return errorPage(
    405,
    "This page is read-only",
    "Colorado Watchdog pages can only be read. This request tried to send data to one.",
  );
}
