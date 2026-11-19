import type {
  PublicCountyStructure,
  PublicUnit,
} from "../../services/county-structure-public.js";
import { emptyState, personLink } from "../components.js";
import { html, type SafeHtml } from "../html.js";

function unitItem(unit: PublicUnit): SafeHtml {
  return html`<li class="structure-unit">
    <span class="structure-name">${unit.name}</span>
    <span class="structure-type">${unit.organizationType}</span>
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
    ${
      unit.children.length > 0
        ? html`<ul class="structure-tree">${unit.children.map(unitItem)}</ul>`
        : ""
    }
  </li>`;
}

/**
 * The public County structure section. It renders only the public fields the
 * service returns: names, types, alternate names, order and linked people.
 * Evidence and source references never reach this function.
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
  return html`<section class="section" id="structure" aria-labelledby="structure-heading">
    <h2 id="structure-heading">County structure</h2>
    <p class="section-intro">Offices and units of ${title} as recorded in this database. A person can appear under both a unit and an elected listing. It is still one record.</p>
    ${
      structure.units.length > 0
        ? html`<ul class="structure-tree">${structure.units.map(unitItem)}</ul>`
        : ""
    }
    ${structure.groups.map(
      (group) => html`<h3 class="subhead">${group.name}</h3>
      <ul class="structure-tree">${group.units.map(unitItem)}</ul>`,
    )}
    ${
      structure.electedOfficials.length > 0
        ? html`<h3 class="subhead">Elected officials</h3>
      <ul class="structure-people">${structure.electedOfficials.map(
        (person) =>
          html`<li>${personLink(person.personId, person.displayName)}${person.title ? html`, ${person.title}` : ""}${person.unitName ? html` (${person.unitName})` : ""}</li>`,
      )}</ul>`
        : ""
    }
  </section>`;
}
