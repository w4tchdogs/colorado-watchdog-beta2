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

// Live county search: map and grid highlights, results table, counts and sorting.
const filter = document.querySelector("[data-county-filter]");
if (filter) {
  const IDLE_STATUS = "Choose a county";
  const rows = [...document.querySelectorAll("[data-result-row]")];
  const tbody = document.querySelector("[data-county-rows]");
  const searchHighlights = document.querySelectorAll(
    "[data-map-county], #county-directory [data-county]",
  );
  const targets = [...document.querySelectorAll("[data-fips]")];
  const results = document.querySelector("[data-county-results]");
  const empty = document.querySelector("[data-county-empty]");
  const note = document.querySelector("[data-county-note]");
  const status = document.querySelector("[data-map-status]");
  const table = document.querySelector("[data-county-table]");
  const headers = [...document.querySelectorAll("th[data-sort-key]")];
  const sortSelect = document.querySelector("[data-sort-select]");
  const idleNote = note?.dataset.idleNote ?? "";
  const labels = new Map(
    rows.map((row) => [
      row.dataset.fips,
      `${row.querySelector(".county-name-link")?.textContent ?? ""} · FIPS ${row.dataset.fips}`,
    ]),
  );
  const plural = (count, one, many) => (count === 1 ? one : many);
  let hoveredFips = null;
  let focusedFips = null;
  let idleText = status?.textContent ?? IDLE_STATUS;

  const updateActive = () => {
    const active = focusedFips ?? hoveredFips;
    for (const target of targets) {
      target.classList.toggle("is-active", target.dataset.fips === active);
    }
    if (!status) return;
    if (!active) {
      status.textContent = idleText;
    } else {
      const label = labels.get(active) ?? active;
      status.textContent = focusedFips
        ? `${label}. Press Enter to open its county page.`
        : `${label}. Select to open its county page.`;
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
    let shown = 0;
    for (const row of rows) {
      const match =
        needle !== "" &&
        ((row.dataset.name ?? "").includes(needle) ||
          (row.dataset.fips ?? "").includes(needle));
      row.hidden = !match;
      if (match) shown += 1;
    }
    const matched = new Set(
      rows.filter((row) => !row.hidden).map((row) => row.dataset.fips),
    );
    for (const target of searchHighlights) {
      target.classList.toggle("is-match", matched.has(target.dataset.fips));
    }
    for (const row of rows) row.classList.toggle("is-match", !row.hidden);
    if (results) results.hidden = shown === 0;
    if (empty) empty.hidden = needle === "" || shown !== 0;
    const nextNote =
      needle === ""
        ? idleNote
        : `${shown} ${plural(shown, "county matches", "counties match")}`;
    if (note && note.textContent !== nextNote) note.textContent = nextNote;
    idleText =
      needle === ""
        ? IDLE_STATUS
        : `${shown} matching ${plural(shown, "county", "counties")}`;
    updateActive();
    updateUrl(query);
  };

  // Sorting. County sorts alphabetically, count columns numerically, with
  // unavailable counts last in either direction and ties by name then FIPS.
  const sortState = () => {
    const header = headers.find(
      (th) => th.getAttribute("aria-sort") !== "none",
    );
    return {
      key: header?.dataset.sortKey ?? "county",
      direction:
        header?.getAttribute("aria-sort") === "descending" ? "desc" : "asc",
    };
  };
  const nameThenFips = (left, right) =>
    (left.dataset.sortName ?? "").localeCompare(
      right.dataset.sortName ?? "",
      "en",
    ) || (left.dataset.fips ?? "").localeCompare(right.dataset.fips ?? "");
  const applySort = (key, direction) => {
    const sign = direction === "asc" ? 1 : -1;
    const value = (row) => {
      const raw = row.dataset[key];
      return raw === undefined || raw === "" ? null : Number(raw);
    };
    const ordered = [...rows].sort((left, right) => {
      if (key === "county") return sign * nameThenFips(left, right);
      const a = value(left);
      const b = value(right);
      if (a === null && b !== null) return 1;
      if (a !== null && b === null) return -1;
      if (a !== null && b !== null && a !== b) return sign * (a - b);
      return nameThenFips(left, right);
    });
    for (const row of ordered) tbody.appendChild(row);
    for (const th of headers) {
      th.setAttribute(
        "aria-sort",
        th.dataset.sortKey !== key
          ? "none"
          : direction === "asc"
            ? "ascending"
            : "descending",
      );
    }
    if (sortSelect) sortSelect.value = `${key}:${direction}`;
  };
  // Headings are plain text without JavaScript. Turn them into sort buttons.
  for (const th of headers) {
    const key = th.dataset.sortKey;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "county-sort-button";
    button.dataset.sort = key;
    button.append(th.textContent.trim());
    const arrow = document.createElement("span");
    arrow.className = "county-sort-arrow";
    arrow.setAttribute("aria-hidden", "true");
    button.append(arrow);
    th.textContent = "";
    th.append(button);
    th.classList.add("is-sortable");
    th.setAttribute("aria-sort", key === "county" ? "ascending" : "none");
    button.addEventListener("click", () => {
      const current = sortState();
      const direction =
        current.key === key
          ? current.direction === "asc"
            ? "desc"
            : "asc"
          : key === "county"
            ? "asc"
            : "desc";
      applySort(key, direction);
    });
  }
  table?.classList.add("is-enhanced");
  if (sortSelect) {
    sortSelect.closest("[data-sort-select-wrap]")?.removeAttribute("hidden");
    sortSelect.addEventListener("change", () => {
      const [key, direction] = sortSelect.value.split(":");
      applySort(key, direction);
    });
  }
  if (tbody) {
    // The whole row opens the county. Links and controls keep their own action.
    tbody.addEventListener("click", (event) => {
      if (event.target.closest("a, button, select, input")) return;
      const link = event.target
        .closest("[data-result-row]")
        ?.querySelector(".county-name-link");
      if (link) link.click();
    });
  }

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
  const announce = controls?.querySelector("[data-banner-announce]");
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

  function watchImage(candidate, settle) {
    function loaded() {
      if (typeof candidate.decode === "function") {
        candidate.decode().then(
          () => settle(true),
          () => settle(candidate.naturalWidth > 0),
        );
      } else {
        settle(true);
      }
    }
    candidate.addEventListener("load", loaded, { once: true });
    candidate.addEventListener("error", () => settle(false), { once: true });
    return () => {
      if (!candidate.getAttribute("src") || !candidate.complete) return;
      if (candidate.naturalWidth > 0) loaded();
      else settle(false);
    };
  }

  function setImageAvailability(available) {
    image.hidden = !available;
    frame.classList.toggle("has-image", available);
    frame.dataset.bannerState = available ? "ready" : "unavailable";
  }

  if (!controls || !caption || !status || !play || !pause || slides.length < 2) {
    watchImage(image, setImageAvailability)();
    return;
  }

  frame.setAttribute("data-banner-gallery", "");
  const dwell = 7000;
  const failed = new Set();
  let index = 0;
  let pending;
  let incoming;
  let playing = false;
  let pageActive = true;
  let remaining = dwell;
  let deadline;
  let timer;

  function canPlay() {
    return (
      pageActive &&
      !document.hidden &&
      !motion?.matches &&
      frame.dataset.bannerState === "ready" &&
      failed.size < slides.length - 1
    );
  }

  function updatePlayback() {
    frame.toggleAttribute("data-banner-playing", playing);
    play.setAttribute("aria-disabled", String(playing || !canPlay()));
    pause.setAttribute("aria-disabled", String(!playing));
  }

  // Position and playback use separate polite regions.
  function say(message) {
    if (announce) announce.textContent = message;
  }

  function stop(spoken = false) {
    if (timer !== undefined) {
      remaining = Math.max(0, deadline - performance.now());
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (playing) say(spoken === true ? "Banner rotation paused" : "");
    playing = false;
    updatePlayback();
  }

  function updateStatus(
    unavailable = frame.dataset.bannerState === "unavailable",
  ) {
    status.textContent = `Banner ${index + 1} of ${slides.length}${unavailable ? " · Image unavailable" : ""}`;
  }

  function nextIndex(offset, from = index) {
    for (let step = 1; step < slides.length; step++) {
      const next = (from + offset * step + slides.length) % slides.length;
      if (!failed.has(next)) return next;
    }
  }

  function preloadNext() {
    if (pending || incoming || frame.dataset.bannerState !== "ready") return;
    const next = nextIndex(1);
    if (next !== undefined) loadCandidate(next);
    else if (playing) stop();
  }

  function scheduleDwell() {
    if (!playing || incoming || !pending?.ready || timer !== undefined) return;
    deadline = performance.now() + remaining;
    timer = window.setTimeout(() => {
      timer = undefined;
      showCandidate();
    }, remaining);
  }

  function promote(candidate) {
    const oldImage = image;
    const slide = slides[candidate.index];
    image = candidate.image;
    index = candidate.index;
    incoming = undefined;
    image.removeAttribute("aria-hidden");
    image.removeAttribute("data-banner-incoming");
    image.setAttribute("data-banner-image", "");
    if (image.parentNode === frame) oldImage.remove();
    else oldImage.replaceWith(image);
    frame.classList.toggle("mode-cover", slide.mode === "cover");
    frame.classList.toggle("mode-contain", slide.mode === "contain");
    frame.dataset.bannerId = slide.bannerId;
    frame.dataset.bannerVersion = slide.assetVersion;
    setImageAvailability(true);
    caption.textContent = slide.caption;
    caption.hidden = !slide.caption;
    remaining = dwell;
    updateStatus();
    updatePlayback();
    preloadNext();
  }

  function showCandidate() {
    const candidate = pending;
    pending = undefined;
    if (!playing || motion?.matches || frame.dataset.bannerState !== "ready") {
      promote(candidate);
      return;
    }
    incoming = candidate;
    const nextImage = candidate.image;
    nextImage.setAttribute("data-banner-zoom", "");
    nextImage.setAttribute("data-banner-incoming", "");
    nextImage.setAttribute("aria-hidden", "true");
    nextImage.addEventListener("animationend", (event) => {
      if (event.animationName === "banner-crossfade" && incoming === candidate) {
        promote(candidate);
      }
    });
    image.after(nextImage);
  }

  function loadCandidate(next, manual = false) {
    if (pending?.index === next) {
      pending.manual ||= manual;
      if (manual && pending.ready) showCandidate();
      return;
    }
    const slide = slides[next];
    const nextImage = document.createElement("img");
    nextImage.className = `banner-image fx-${slide.focalX} fy-${slide.focalY}`;
    nextImage.alt = slide.alt;
    nextImage.decoding = "async";
    if (
      [slide.width, slide.height].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    ) {
      nextImage.width = slide.width;
      nextImage.height = slide.height;
    }
    const candidate = { index: next, image: nextImage, manual, ready: false };
    pending = candidate;
    const checkImage = watchImage(nextImage, (available) => {
      if (pending !== candidate) return;
      if (!available) {
        pending = undefined;
        failed.add(next);
        if (candidate.manual) updateStatus(true);
        preloadNext();
        updatePlayback();
        return;
      }
      candidate.ready = true;
      if (candidate.manual) showCandidate();
      else scheduleDwell();
    });
    nextImage.src = slide.src;
    checkImage();
  }

  function move(offset) {
    // A manual selection interrupts an active fade and navigates from its
    // intended destination. A late load from an earlier click is ignored.
    if (incoming) promote(incoming);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    const next = nextIndex(offset, pending?.manual ? pending.index : index);
    remaining = dwell;
    if (next === index) {
      pending = undefined;
      preloadNext();
    } else if (next !== undefined) {
      loadCandidate(next, true);
    }
  }

  const initial = image;
  controls
    .querySelector("[data-banner-previous]")
    .addEventListener("click", () => move(-1));
  controls
    .querySelector("[data-banner-next]")
    .addEventListener("click", () => move(1));
  pause.addEventListener("click", () => stop(true));
  function start(spoken) {
    if (playing || !canPlay()) return;
    playing = true;
    image.setAttribute("data-banner-zoom", "");
    updatePlayback();
    if (spoken) say("Banner rotation playing");
    preloadNext();
    scheduleDwell();
  }
  play.addEventListener("click", () => start(true));

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else updatePlayback();
  });
  motion?.addEventListener("change", () => {
    stop();
    if (motion.matches && incoming) promote(incoming);
  });
  window.addEventListener("pagehide", () => {
    pageActive = false;
    stop();
  });
  window.addEventListener("pageshow", () => {
    pageActive = true;
    updatePlayback();
  });
  watchImage(initial, (available) => {
    if (initial !== image) return;
    setImageAvailability(available);
    if (available) {
      preloadNext();
      start(false);
    } else {
      failed.add(index);
      stop();
    }
    updateStatus();
    updatePlayback();
  })();
  updateStatus();
  updatePlayback();
  controls.hidden = false;
}

for (const frame of document.querySelectorAll("[data-banner-frame]")) {
  enhanceBanner(frame);
}
