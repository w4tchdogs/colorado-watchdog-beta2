// Progressive enhancement for the public site. Every page works without it.
const root = document.documentElement;
root.classList.add("js");

// Mobile navigation toggle.
const toggle = document.querySelector(".nav-toggle");
const nav = document.getElementById("site-nav");
if (toggle && nav) {
  toggle.hidden = false;
  const setOpen = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("is-open", open);
  };
  toggle.addEventListener("click", () => {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      toggle.getAttribute("aria-expanded") === "true"
    ) {
      setOpen(false);
      toggle.focus();
    }
  });
}

// Live county filter on the county directory.
const filter = document.querySelector("[data-county-filter]");
if (filter) {
  const items = [...document.querySelectorAll("[data-county]")];
  const groups = [...document.querySelectorAll("[data-county-group]")];
  const count = document.querySelector("[data-county-count]");
  const empty = document.querySelector("[data-county-empty]");
  const apply = () => {
    const needle = filter.value.trim().toLowerCase();
    let shown = 0;
    for (const item of items) {
      const match =
        needle === "" ||
        (item.dataset.name ?? "").includes(needle) ||
        (item.dataset.fips ?? "").includes(needle);
      item.hidden = !match;
      if (match) shown += 1;
    }
    for (const group of groups) {
      const visible = group.querySelector("[data-county]:not([hidden])");
      group.hidden = !visible;
      const link = document.querySelector(
        `[data-letter-link="${group.dataset.letter}"]`,
      );
      if (link?.parentElement) link.parentElement.hidden = !visible;
    }
    if (empty) empty.hidden = shown !== 0;
    if (count) {
      count.textContent =
        needle === ""
          ? `Showing all ${items.length} counties.`
          : `Showing ${shown} of ${items.length} counties for "${filter.value.trim()}".`;
    }
  };
  filter.addEventListener("input", apply);
}

// Banner artwork: if an image is missing or fails to load, drop it and let the
// branded placeholder underneath show. The 3:1 frame keeps its size either way.
for (const image of document.querySelectorAll("[data-banner-image]")) {
  const frame = image.closest("[data-banner-frame]");
  const useFallback = () => {
    image.hidden = true;
    frame?.classList.remove("has-image");
    frame?.setAttribute("data-banner-state", "unavailable");
  };
  if (image.complete && image.naturalWidth === 0) {
    useFallback();
  } else {
    image.addEventListener("error", useFallback, { once: true });
  }
}
