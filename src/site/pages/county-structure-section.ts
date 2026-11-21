import type {
  PublicCountyStructure,
  PublicUnit,
} from "../../services/county-structure-public.js";
import { emptyState, personLink } from "../components.js";
import { html, type SafeHtml } from "../html.js";

function unitItem(unit: PublicUnit): SafeHtml {
  return html`<li class="structure-unit">
    <div class="structure-unit-head">
      <span class="structure-name">${unit.name}</span>
      <span class="structure-count">${unit.profileCount} ${unit.profileCount === 1 ? "profile" : "profiles"}</span>
    </div>
    ${
      unit.aliases.length > 0
        ? html`<span class="structure-aliases">Also known as ${unit.aliases.join(", ")}</span>`
        : ""
    }
    ${
      unit.people.length > 0
        ? html`<ul class="structure-people">${unit.people.map(
            (person) =>
              html`<li>${personLink(person.personId, person.displayName)}${person.title ? html`, ${person.title}` : ""}</li>`,
          )}</ul>`
        : ""
    }
    ${unit.profileCount > unit.people.length ? html`<p class="quiet">Showing ${unit.people.length} of ${unit.profileCount} profiles. <a href="/officials">Search officials and employees</a></p>` : ""}
    ${
      unit.children.length > 0
        ? html`<ul class="structure-tree">${unit.children.map(unitItem)}</ul>`
        : ""
    }
  </li>`;
}

/**
 * The public County structure section renders names, alternate names, order,
 * counts and linked people. Internal unit types stay in the dashboard. Evidence
 * and source references never reach this function.
 */
export function countyStructureSection(
  title: string,
  structure: PublicCountyStructure,
): SafeHtml {
  if (structure.empty) {
    return html`<section class="section" id="structure" aria-labelledby="structure-heading">
    <h2 id="structure-heading">County structure</h2>
    ${emptyState(
      `No structure recorded for ${title} yet`,
      "The offices and units of this county have not been added to the database. That reflects the state of this project's work, not the county's government.",
      undefined,
      3,
    )}
  </section>`;
  }
  const cards = structure.groups.map((group) => ({
    key: group.layoutKey,
    view: html`<section class="card county-structure-card" aria-labelledby="structure-group-${group.id}">
      <h3 id="structure-group-${group.id}">${group.name}</h3>
      <ul class="structure-tree">${group.units.map(unitItem)}</ul>
    </section>`,
  }));
  if (structure.electedOfficials.length > 0) {
    cards.push({
      key: "listing:elected_officials",
      view: html`<section class="card county-structure-card" aria-labelledby="structure-elected-officials">
        <h3 id="structure-elected-officials">Elected officials</h3>
        <ul class="structure-people">${structure.electedOfficials.map(
          (person) =>
            html`<li>${personLink(person.personId, person.displayName)}${person.title ? html`, ${person.title}` : ""}${person.unitName ? html` (${person.unitName})` : ""}</li>`,
        )}</ul>
      </section>`,
    });
  }
  const pins = new Map(structure.pinnedGroups.map((pin) => [pin.groupId, pin]));
  const orderedPins = (column: "left" | "right") =>
    cards
      .filter((card) => pins.get(card.key)?.column === column)
      .sort(
        (a, b) =>
          (pins.get(a.key)?.position ?? 0) - (pins.get(b.key)?.position ?? 0),
      );
  const leftPins = orderedPins("left");
  const rightPins = orderedPins("right");
  const pinnedIds = new Set(
    [...leftPins, ...rightPins].map((card) => card.key),
  );
  const unpinned = cards.filter((card) => !pinnedIds.has(card.key));
  const hasPins = leftPins.length > 0 || rightPins.length > 0;

  return html`<section class="section" id="structure" aria-labelledby="structure-heading">
    <h2 id="structure-heading">County structure</h2>
    <p class="section-intro">Offices and units of ${title} as recorded in this database. A person can appear under both a unit and an elected listing. It is still one record.</p>
    ${
      hasPins
        ? html`<div class="county-structure-pinned-columns">
      <div class="county-structure-pin-column" aria-label="Pinned left column">${leftPins.map((card) => card.view)}</div>
      <div class="county-structure-pin-column" aria-label="Pinned right column">${rightPins.map((card) => card.view)}</div>
    </div>`
        : ""
    }
    ${unpinned.length > 0 ? html`<div class="county-structure-grid">${unpinned.map((card) => card.view)}</div>` : ""}
  </section>`;
}
