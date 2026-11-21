import {
  PROFILE_NO_COUNTY,
  type ProfileFacets,
} from "../contracts/profiles.js";
import { el } from "./dom.js";

export function createProfileOfficeFilters(doc: Document) {
  const countySelect = el(doc, "select", { id: "profiles-county" });
  const officeSelect = el(doc, "select", { id: "profiles-office" });
  const countyNames = new Map<string, string>();
  let offices: ProfileFacets["offices"] = [];

  function labelFor(county: string | null): string {
    return county ? (countyNames.get(county) ?? county) : "No county";
  }

  function showOffices(): void {
    const county = countySelect.value;
    const previous = officeSelect.value;
    const choices = county
      ? offices.filter((office) => office.countyFips === county)
      : offices;
    officeSelect.replaceChildren(
      el(doc, "option", { value: "" }, "All offices"),
      ...choices.map(({ name, countyFips }) =>
        el(
          doc,
          "option",
          {
            value: JSON.stringify([countyFips, name]),
            "data-office": name,
            "data-county": countyFips ?? PROFILE_NO_COUNTY,
          },
          county ? name : `${name} (${labelFor(countyFips)})`,
        ),
      ),
    );
    officeSelect.value = previous;
    if (officeSelect.selectedIndex < 0) officeSelect.selectedIndex = 0;
  }

  countySelect.appendChild(el(doc, "option", { value: "" }, "All counties"));
  countySelect.addEventListener("change", showOffices);
  showOffices();
  return {
    countySelect,
    officeSelect,
    fill(facets: ProfileFacets): void {
      const previous = countySelect.value;
      countyNames.clear();
      for (const county of facets.counties)
        countyNames.set(county.fips, county.name);
      countySelect.replaceChildren(
        el(doc, "option", { value: "" }, "All counties"),
        ...facets.counties.map(({ fips, name }) =>
          el(doc, "option", { value: fips }, name),
        ),
      );
      countySelect.value = previous;
      if (countySelect.selectedIndex < 0) countySelect.selectedIndex = 0;
      const collator = new Intl.Collator("en");
      offices = [...facets.offices].sort(
        (a, b) =>
          collator.compare(a.name, b.name) ||
          collator.compare(labelFor(a.countyFips), labelFor(b.countyFips)),
      );
      showOffices();
    },
    clear(): void {
      countySelect.value = officeSelect.value = "";
      showOffices();
    },
    scope(): { countyFips: string | null; office: string | null } {
      const option = officeSelect.selectedOptions[0];
      return {
        countyFips: option?.dataset.county ?? (countySelect.value || null),
        office: option?.dataset.office ?? null,
      };
    },
  };
}
