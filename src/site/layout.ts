import { html, type SafeHtml, trusted } from "./html.js";
import type { AccountEntry, Breadcrumb, Page } from "./types.js";

const NAVIGATION = [
  { key: "counties", label: "Counties", href: "/counties" },
  { key: "officials", label: "Officials", href: "/officials" },
  { key: "organizations", label: "Organizations", href: "/organizations" },
  { key: "stories", label: "Stories", href: "/stories" },
  { key: "posts", label: "Posts", href: "/posts" },
  { key: "about", label: "About", href: "/about" },
] as const;

/** Same-origin sign-in start that returns the visitor to the dashboard. */
export const DASHBOARD_LOGIN_HREF = "/auth/login?return_to=%2Fdashboard";
export const DASHBOARD_HREF = "/dashboard";

function accountEntry(entry: AccountEntry | null | undefined): SafeHtml {
  if (!entry) return html``;
  if (entry === "signed-in")
    return html`<div class="header-account"><a class="header-login" href="${DASHBOARD_HREF}">Dashboard</a></div>`;
  return html`<div class="header-account"><a class="header-login" href="${DASHBOARD_LOGIN_HREF}" aria-describedby="header-login-note">Log in / Sign up</a><p class="header-login-note" id="header-login-note">Sign-in works only for a Website account that is already linked.</p></div>`;
}

export const TAGLINE = "Accountability Starts with Being Heard";

/** The owner's white dog-and-mountains logo, decorative beside the name. */
function logo(size: number): SafeHtml {
  return html`<img class="brand-logo" src="/assets/brand-logo-white.png" alt="" width="${size}" height="${Math.round((size * 184) / 192)}">`;
}

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

export function renderDocument(
  page: Page,
  preview: boolean,
  entry: AccountEntry | null = null,
): string {
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
<link rel="icon" href="/assets/favicon-light.png" type="image/png" media="(prefers-color-scheme: light)">
<link rel="icon" href="/assets/favicon-dark.png" type="image/png" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="/assets/site.css">
<script type="module" src="/assets/site.js"></script>
${page.head ?? ""}
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
    <a class="brand" href="/">${logo(56)}<span class="brand-text"><span class="brand-name">Colorado Watchdog</span><span class="brand-tagline">${TAGLINE}</span></span></a>${accountEntry(entry)}
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
<p class="site-strip"><strong>Records cite public sources. They are not findings of fact.</strong> <span>Independent</span> <span>Community-run</span></p>
${page.subnav ?? ""}
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
      <p class="footer-brand">${logo(44)}<span class="brand-text"><span class="brand-name">Colorado Watchdog</span><span class="brand-tagline">${TAGLINE}</span></span></p>
      <p>An independent public-information project documenting Colorado county government from cited public sources.</p>
    </div>
    <nav aria-label="Directories">
      <h2>Directories</h2>
      <ul>
        <li><a href="/counties">All 64 counties</a></li>
        <li><a href="/officials">Officials &amp; employees</a></li>
        <li><a href="/officials?directoryView=structure">County structure</a></li>
        <li><a href="/organizations">Organizations</a></li>
      </ul>
    </nav>
    <nav aria-label="Community Voices">
      <h2>Community Voices</h2>
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
