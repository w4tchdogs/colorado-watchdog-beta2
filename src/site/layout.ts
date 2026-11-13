import { html, type SafeHtml, trusted } from "./html.js";
import type { Breadcrumb, Page } from "./types.js";

const NAVIGATION = [
  { key: "counties", label: "Counties", href: "/counties" },
  { key: "people", label: "People", href: "/people" },
  { key: "organizations", label: "Organizations", href: "/organizations" },
  { key: "stories", label: "Stories", href: "/stories" },
  { key: "posts", label: "Posts", href: "/posts" },
  { key: "about", label: "About", href: "/about" },
] as const;

/** The state outline (a rectangle) with one marked survey point. */
const MARK = trusted(
  '<svg class="brand-mark" viewBox="0 0 44 32" width="44" height="32" aria-hidden="true" focusable="false">' +
    '<rect x="1.5" y="1.5" width="41" height="29" fill="none" stroke="currentColor" stroke-width="3"/>' +
    '<path d="M1.5 11.5h41M1.5 21h41M15 1.5v29M29 1.5v29" stroke="currentColor" stroke-width="1" opacity=".45"/>' +
    '<circle class="brand-mark-point" cx="22" cy="16" r="4.5"/></svg>',
);

function breadcrumbs(items: readonly Breadcrumb[] | undefined): SafeHtml {
  if (!items || items.length === 0) return html``;
  return html`<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>
    ${items.map((item, index) =>
      item.href && index < items.length - 1
        ? html`<li><a href="${item.href}">${item.label}</a></li>`
        : html`<li><span aria-current="page">${item.label}</span></li>`,
    )}
  </ol></nav>`;
}

export function renderDocument(page: Page, preview: boolean): string {
  const title =
    page.title === "Colorado Watchdog"
      ? page.title
      : `${page.title} | Colorado Watchdog`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${page.description ? html`<meta name="description" content="${page.description}">` : ""}
${preview ? html`<meta name="robots" content="noindex, nofollow">` : ""}
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/site.css">
<script type="module" src="/assets/site.js"></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
${
  preview
    ? html`<p class="preview-notice" role="note"><strong>Local preview.</strong> Every person, organization, record and article shown here is fictional demonstration data.</p>`
    : ""
}
<header class="site-header">
  <div class="wrap site-header-inner">
    <a class="brand" href="/">${MARK}<span class="brand-name">Colorado Watchdog</span></a>
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" hidden>Menu</button>
    <nav id="site-nav" class="site-nav" aria-label="Main">
      <ul>
        ${NAVIGATION.map(
          (item) =>
            html`<li><a href="${item.href}"${item.key === page.section ? trusted(' aria-current="true"') : ""}>${item.label}</a></li>`,
        )}
      </ul>
    </nav>
  </div>
</header>
<main id="main" tabindex="-1">
${page.lead ?? ""}
<div class="wrap main-column">
${breadcrumbs(page.breadcrumbs)}
${page.body}
</div>
</main>
<footer class="site-footer">
  <div class="wrap footer-grid">
    <div>
      <p class="footer-brand">${MARK}<span>Colorado Watchdog</span></p>
      <p>An independent public-information project documenting Colorado county government from cited public sources.</p>
    </div>
    <nav aria-label="Directories">
      <h2>Directories</h2>
      <ul>
        <li><a href="/counties">All 64 counties</a></li>
        <li><a href="/people">People</a></li>
        <li><a href="/organizations">Organizations</a></li>
      </ul>
    </nav>
    <nav aria-label="Reporting">
      <h2>Reporting</h2>
      <ul>
        <li><a href="/stories">Stories</a></li>
        <li><a href="/posts">Posts</a></li>
      </ul>
    </nav>
    <nav aria-label="About this site">
      <h2>About</h2>
      <ul>
        <li><a href="/about">About Colorado Watchdog</a></li>
        <li><a href="/reading-records">How to read these records</a></li>
      </ul>
    </nav>
  </div>
  <div class="wrap footer-note">
    <p>Records describe what cited public sources stated when they were checked. They are not a statement of current employment and are not a complete roster.</p>
  </div>
</footer>
</body>
</html>
`.value;
}
