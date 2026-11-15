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

function isBannerSlide(slide) {
  if (!slide || typeof slide.src !== "string" || slide.src.length > 2048) {
    return false;
  }
  if (/[\s\\<>"'`]/.test(slide.src)) return false;
  try {
    if (slide.src.startsWith("/")) {
      if (slide.src.startsWith("//")) return false;
    } else {
      const url = new URL(slide.src);
      if (url.protocol !== "https:" || url.username || url.password)
        return false;
    }
  } catch {
    return false;
  }
  return (
    [slide.bannerId, slide.assetVersion, slide.alt].every(
      (value) => typeof value === "string" && value.trim(),
    ) &&
    (slide.countyFips === null ||
      (typeof slide.countyFips === "string" &&
        /^\d{5}$/.test(slide.countyFips))) &&
    typeof slide.caption === "string" &&
    (slide.mode === "cover" || slide.mode === "contain") &&
    [slide.focalX, slide.focalY].every(
      (value) =>
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 100 &&
        value % 5 === 0,
    )
  );
}

function enhanceBanner(frame) {
  let image = frame.querySelector("[data-banner-image]");
  if (!image) return;
  const controls = frame.nextElementSibling?.matches("[data-banner-controls]")
    ? frame.nextElementSibling
    : null;
  const caption = frame.querySelector(".banner-caption");
  const status = controls?.querySelector("[data-banner-status]");
  const play = controls?.querySelector("[data-banner-play]");
  const pause = controls?.querySelector("[data-banner-pause]");
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let slides = [];
  try {
    const data = JSON.parse(frame.dataset.bannerSlides ?? "[]");
    // Keep the server-rendered slide as the anchor for progressive enhancement.
    if (
      Array.isArray(data) &&
      isBannerSlide(data[0]) &&
      data[0].src === image.getAttribute("src") &&
      data[0].bannerId === frame.dataset.bannerId &&
      data[0].assetVersion === frame.dataset.bannerVersion
    ) {
      slides = data.filter(isBannerSlide);
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }

  let index = 0;
  let timer;
  let pageActive = true;
  const interval = Number(frame.dataset.bannerInterval);
  const delay = Number.isFinite(interval)
    ? Math.min(20000, Math.max(3000, interval))
    : 8000;

  function canPlay() {
    return (
      pageActive &&
      !document.hidden &&
      !motion?.matches &&
      frame.dataset.bannerState !== "unavailable"
    );
  }

  function updatePlayback() {
    play?.setAttribute(
      "aria-disabled",
      String(timer !== undefined || !canPlay()),
    );
    pause?.setAttribute("aria-disabled", String(timer === undefined));
  }

  function stop() {
    window.clearInterval(timer);
    timer = undefined;
    updatePlayback();
  }

  function updateStatus() {
    if (!status) return;
    const unavailable = frame.dataset.bannerState === "unavailable";
    status.textContent = `Banner ${index + 1} of ${slides.length}${unavailable ? " · Image unavailable" : ""}`;
  }

  function watchImage(candidate) {
    function settle(available) {
      if (candidate !== image) return;
      candidate.hidden = !available;
      frame.classList.toggle("has-image", available);
      frame.dataset.bannerState = available ? "ready" : "unavailable";
      if (!available) {
        stop();
        updateStatus();
      } else {
        updatePlayback();
      }
    }
    candidate.addEventListener("load", () => settle(true), { once: true });
    candidate.addEventListener("error", () => settle(false), { once: true });
    return () => {
      if (candidate.complete) settle(candidate.naturalWidth > 0);
    };
  }

  function move(offset) {
    index = (index + offset + slides.length) % slides.length;
    const slide = slides[index];
    const nextImage = document.createElement("img");
    nextImage.className = `banner-image fx-${slide.focalX} fy-${slide.focalY}`;
    nextImage.setAttribute("data-banner-image", "");
    nextImage.alt = slide.alt;
    nextImage.decoding = "async";
    nextImage.hidden = true;
    if (
      [slide.width, slide.height].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    ) {
      nextImage.width = slide.width;
      nextImage.height = slide.height;
    }
    frame.classList.remove("has-image");
    frame.classList.toggle("mode-cover", slide.mode === "cover");
    frame.classList.toggle("mode-contain", slide.mode === "contain");
    frame.dataset.bannerId = slide.bannerId;
    frame.dataset.bannerVersion = slide.assetVersion;
    frame.dataset.bannerState = "loading";
    caption.textContent = slide.caption;
    caption.hidden = !slide.caption;

    const checkImage = watchImage(nextImage);
    nextImage.src = slide.src;
    image.replaceWith(nextImage);
    image = nextImage;
    updateStatus();
    updatePlayback();
    checkImage();
  }

  watchImage(image)();
  if (
    !controls ||
    !caption ||
    !status ||
    !play ||
    !pause ||
    slides.length < 2
  ) {
    return;
  }

  controls
    .querySelector("[data-banner-previous]")
    .addEventListener("click", () => move(-1));
  controls
    .querySelector("[data-banner-next]")
    .addEventListener("click", () => move(1));
  pause.addEventListener("click", stop);
  play.addEventListener("click", () => {
    if (timer !== undefined || !canPlay()) return;
    timer = window.setInterval(() => move(1), delay);
    updatePlayback();
  });
  const carousel = frame.parentElement;
  const hero = carousel.closest(".hero") ?? carousel;
  carousel.addEventListener("focusin", stop);
  hero.addEventListener("pointerenter", stop);
  hero.addEventListener("pointerdown", stop);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else updatePlayback();
  });
  motion?.addEventListener("change", stop);
  window.addEventListener("pagehide", () => {
    pageActive = false;
    stop();
  });
  window.addEventListener("pageshow", () => {
    pageActive = true;
    updatePlayback();
  });
  updateStatus();
  updatePlayback();
  controls.hidden = false;
}

for (const frame of document.querySelectorAll("[data-banner-frame]")) {
  enhanceBanner(frame);
}
