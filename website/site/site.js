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
  const mapRegions = [...document.querySelectorAll("[data-map-county]")];
  const targets = [...document.querySelectorAll("[data-fips]")];
  const groups = [...document.querySelectorAll("[data-county-group]")];
  const count = document.querySelector("[data-county-count]");
  const empty = document.querySelector("[data-county-empty]");
  const status = document.querySelector("[data-map-status]");
  let hoveredFips = null;
  let focusedFips = null;
  const updateActive = () => {
    const active = focusedFips ?? hoveredFips;
    for (const target of targets) {
      target.classList.toggle("is-active", target.dataset.fips === active);
    }
    if (status) {
      if (!active) {
        status.textContent = "Select a county, or search the directory below.";
      } else {
        const region = mapRegions.find((item) => item.dataset.fips === active);
        const countyName =
          region?.querySelector("title")?.textContent ?? active;
        status.textContent = focusedFips
          ? `${countyName}. Press Enter to open its county page.`
          : `${countyName}. Select to open its county page.`;
      }
    }
  };
  const updateUrl = (query) => {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  };
  const apply = () => {
    const query = filter.value.trim().slice(0, 40);
    const needle = query.toLowerCase();
    if (filter.value !== query) filter.value = query;
    let shown = 0;
    for (const item of items) {
      const match =
        needle === "" ||
        (item.dataset.name ?? "").includes(needle) ||
        (item.dataset.fips ?? "").includes(needle);
      item.hidden = !match;
      item.classList.toggle("is-match", match && needle !== "");
      if (match) shown += 1;
    }
    for (const region of mapRegions) {
      const mapLabel = (
        region.querySelector("title")?.textContent ?? ""
      ).toLowerCase();
      const match =
        needle !== "" &&
        (mapLabel.includes(needle) ||
          (region.dataset.fips ?? "").includes(needle));
      region.classList.toggle("is-match", match);
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
        query === ""
          ? `Showing all ${items.length} counties.`
          : `Showing ${shown} of ${items.length} counties for "${query}".`;
    }
    updateUrl(query);
  };
  for (const target of targets) {
    target.addEventListener("pointerenter", () => {
      hoveredFips = target.dataset.fips ?? null;
      updateActive();
    });
    target.addEventListener("pointerleave", () => {
      if (hoveredFips === target.dataset.fips) hoveredFips = null;
      updateActive();
    });
    target.addEventListener("focusin", () => {
      focusedFips = target.dataset.fips ?? null;
      updateActive();
    });
    target.addEventListener("focusout", () => {
      if (focusedFips === target.dataset.fips) focusedFips = null;
      updateActive();
    });
  }
  filter.addEventListener("input", () => apply());
  window.addEventListener("popstate", () => {
    filter.value = new URL(window.location.href).searchParams.get("q") ?? "";
    apply();
  });
  apply();
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
