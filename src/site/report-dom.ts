/** Small DOM helpers shared by the report form modules. */

export function node<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  return result;
}

export function setText(element: Element, value: string): void {
  element.textContent = value;
}

export function button(
  document: Document,
  label: string,
  className = "report-button",
): HTMLButtonElement {
  const result = node(document, "button", className);
  result.type = "button";
  result.textContent = label;
  return result;
}

export function fieldError(
  document: Document,
  id: string,
): HTMLParagraphElement {
  const error = node(document, "p", "report-field-error");
  error.id = `${id}-error`;
  error.hidden = true;
  return error;
}

export function connectError(
  control: HTMLElement,
  hint: HTMLElement | null,
  error: HTMLElement,
): void {
  control.setAttribute(
    "aria-describedby",
    [hint?.id, error.id].filter(Boolean).join(" "),
  );
}
