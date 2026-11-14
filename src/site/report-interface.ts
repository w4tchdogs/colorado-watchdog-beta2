import type { CountyRegistryEntry } from "../contracts/county-registry.js";
import type {
  ReportStatus,
  ReportSubmission,
} from "../contracts/report-intake.js";

export interface ReportUiReceipt {
  readonly reference: string;
  /** Returned only for the first successful issuance. */
  readonly recoveryKey?: string;
}

export interface ReportTrackingProjection {
  readonly status: ReportStatus;
  readonly submittedAt: string;
  readonly history: ReadonlyArray<{
    readonly from: ReportStatus | null;
    readonly to: ReportStatus;
    readonly at: string;
  }>;
}

/** Host integration boundary. The host binds the authenticated actor server-side. */
export interface ReportUiAdapter {
  submit(input: ReportSubmission): Promise<ReportUiReceipt>;
  track(
    reference: string,
    recoveryKey: string,
  ): Promise<ReportTrackingProjection>;
}

export interface ReportUiAccount {
  readonly accountId: string;
  readonly name?: string;
  readonly email?: string;
}

export interface ReportInterfaceOptions {
  readonly counties: readonly CountyRegistryEntry[];
  readonly adapter: ReportUiAdapter;
  /** Supplied only by a trusted host after account authentication. */
  readonly account?: ReportUiAccount;
  readonly demoNotice?: string;
  readonly trackingHref?: string;
  readonly createIdempotencyKey?: () => string;
}

type FieldErrors = Readonly<Record<string, string>>;

const STATUS_LABELS: Readonly<Record<ReportStatus, string>> = {
  submitted: "Submitted",
  triage: "In triage",
  "under-review": "Under review",
  "needs-information": "Needs information",
  accepted: "Accepted",
  declined: "Declined",
  closed: "Closed",
};

function node<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  return result;
}

function setText(element: Element, value: string): void {
  element.textContent = value;
}

function button(
  document: Document,
  label: string,
  className = "report-button",
): HTMLButtonElement {
  const result = node(document, "button", className);
  result.type = "button";
  result.textContent = label;
  return result;
}

function fieldError(document: Document, id: string): HTMLParagraphElement {
  const error = node(document, "p", "report-field-error");
  error.id = `${id}-error`;
  error.hidden = true;
  return error;
}

function connectError(
  control: HTMLElement,
  hint: HTMLElement | null,
  error: HTMLElement,
): void {
  control.setAttribute(
    "aria-describedby",
    [hint?.id, error.id].filter(Boolean).join(" "),
  );
}

function requiredHint(document: Document, id: string): HTMLSpanElement {
  const hint = node(document, "span", "report-field-hint");
  hint.id = `${id}-hint`;
  hint.textContent = "Required";
  return hint;
}

function validateEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validHttpsUrl(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      !/\s/.test(value)
    );
  } catch {
    return false;
  }
}

function validateForm(
  values: {
    countyId: string;
    description: string;
    subjectKind: string;
    subjectId: string;
    name: string;
    email: string;
    attribution: string;
    contactPreference: string;
  },
  counties: readonly CountyRegistryEntry[],
  evidence: ReadonlyArray<{
    key: string;
    title: string;
    url: string;
    note: string;
  }>,
  signedIn: boolean,
): FieldErrors {
  const errors: Record<string, string> = {};
  if (!counties.some((county) => county.fips === values.countyId)) {
    errors.county = "Choose a county from the list.";
  }
  if (values.description.trim().length < 20) {
    errors.description = "Enter at least 20 characters describing the concern.";
  } else if (values.description.length > 12000) {
    errors.description = "Use 12,000 characters or fewer.";
  }
  if (
    (values.subjectKind !== "" &&
      values.subjectKind !== "person" &&
      values.subjectKind !== "organization") ||
    (values.subjectKind !== "" &&
      !/^[a-zA-Z0-9_-]{1,100}$/.test(values.subjectId))
  ) {
    errors.subject =
      "Enter a valid directory record ID, or clear the subject type.";
  }
  if (values.name.length > 200) errors.name = "Use 200 characters or fewer.";
  if (
    values.email.length > 254 ||
    (values.email && !validateEmail(values.email))
  ) {
    errors.email = "Enter a valid email address (254 characters or fewer).";
  }
  if (values.attribution === "signed" && !signedIn) {
    errors.attribution = "Sign in before choosing signed-in reporting.";
  } else if (
    values.attribution === "signed" &&
    values.name.trim().length === 0
  ) {
    errors.name = "Enter your name for signed-in reporting.";
  }
  if (values.contactPreference === "email" && !values.email) {
    errors.email = "Enter an email address to request email contact.";
  }
  if (
    values.contactPreference !== "none" &&
    values.contactPreference !== "email"
  ) {
    errors.contact = "Choose a contact preference.";
  }
  evidence.forEach((item) => {
    const id = `report-evidence-${item.key}`;
    if (item.title.length > 200) {
      errors[`${id}-title`] = "Use 200 characters or fewer.";
    } else if ((item.url || item.note) && !item.title.trim()) {
      errors[`${id}-title`] = "Describe this source or evidence item.";
    }
    if (item.note.length > 2000) {
      errors[`${id}-note`] = "Use 2,000 characters or fewer.";
    }
    if (item.url && !validHttpsUrl(item.url)) {
      errors[`${id}-url`] =
        "Enter a valid HTTPS URL without embedded credentials.";
    }
  });
  return errors;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function defaultIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Mounts the independently embeddable submission and tracking screens.
 * User-provided values are assigned only as DOM text or form values.
 */
export function mountReportInterface(
  root: HTMLElement,
  options: ReportInterfaceOptions,
): { destroy(): void } {
  const document = root.ownerDocument;
  const window = document.defaultView;
  const section = node(document, "section", "report-interface");
  section.setAttribute("aria-label", "Private report submission and tracking");

  if (options.demoNotice) {
    const notice = node(document, "p", "report-demo-notice");
    notice.setAttribute("role", "note");
    const strong = node(document, "strong");
    strong.textContent = "Fictional-data demonstration. ";
    notice.append(strong, document.createTextNode(options.demoNotice));
    section.append(notice);
  }

  const tabs = node(document, "nav", "report-tabs");
  tabs.setAttribute("aria-label", "Report services");
  const submitTab = node(document, "a");
  submitTab.href = "#report-submit";
  submitTab.textContent = "Submit a Report";
  const trackTab = node(document, "a");
  trackTab.href = "#report-track";
  trackTab.textContent = "Track a Report";
  tabs.append(submitTab, trackTab);

  const submitPanel = node(document, "section", "report-panel");
  submitPanel.id = "report-submit";
  submitPanel.setAttribute("aria-labelledby", "report-submit-heading");
  const trackPanel = node(document, "section", "report-panel");
  trackPanel.id = "report-track";
  trackPanel.setAttribute("aria-labelledby", "report-track-heading");

  const submitHeading = node(document, "h1", "report-heading");
  submitHeading.id = "report-submit-heading";
  submitHeading.textContent = "Submit a Report";
  const submitIntro = node(document, "p", "report-intro");
  submitIntro.textContent =
    "Share a concern or incident for private review. A submission is an allegation, not a verified finding, and is never published automatically.";

  const errorSummary = node(document, "div", "report-error-summary");
  errorSummary.setAttribute("role", "alert");
  errorSummary.tabIndex = -1;
  errorSummary.hidden = true;
  const errorHeading = node(document, "h2");
  errorHeading.textContent = "Please correct the following";
  const errorList = node(document, "ul");
  errorSummary.append(errorHeading, errorList);

  const form = node(document, "form", "report-form");
  form.noValidate = true;
  const formStatus = node(document, "p", "report-status");
  formStatus.setAttribute("role", "status");
  formStatus.setAttribute("aria-live", "polite");

  const countyField = node(document, "div", "report-field");
  const countyLabel = node(document, "label");
  countyLabel.htmlFor = "report-county";
  countyLabel.textContent = "Colorado county ";
  countyLabel.append(requiredHint(document, "report-county"));
  const countySelect = node(document, "select");
  countySelect.id = "report-county";
  countySelect.name = "countyId";
  countySelect.required = true;
  const countyPlaceholder = node(document, "option");
  countyPlaceholder.value = "";
  countyPlaceholder.textContent = "Choose a county";
  countySelect.append(countyPlaceholder);
  for (const county of options.counties) {
    const option = node(document, "option");
    option.value = county.fips;
    option.textContent = county.name;
    countySelect.append(option);
  }
  const countyError = fieldError(document, countySelect.id);
  connectError(countySelect, null, countyError);
  countyField.append(countyLabel, countySelect, countyError);

  const subjectField = node(
    document,
    "fieldset",
    "report-field report-subject",
  );
  const subjectLegend = node(document, "legend");
  subjectLegend.textContent = "Optional person or organization reference";
  const subjectKind = node(document, "select");
  subjectKind.id = "report-subject-kind";
  subjectKind.name = "subjectKind";
  const noSubject = node(document, "option");
  noSubject.value = "";
  noSubject.textContent = "No directory reference";
  const personSubject = node(document, "option");
  personSubject.value = "person";
  personSubject.textContent = "Person";
  const organizationSubject = node(document, "option");
  organizationSubject.value = "organization";
  organizationSubject.textContent = "Organization";
  subjectKind.append(noSubject, personSubject, organizationSubject);
  const subjectKindLabel = node(document, "label");
  subjectKindLabel.htmlFor = subjectKind.id;
  subjectKindLabel.textContent = "Reference type";
  const subjectIdLabel = node(document, "label");
  subjectIdLabel.htmlFor = "report-subject-id";
  subjectIdLabel.textContent = "Directory record ID";
  const subjectId = node(document, "input");
  subjectId.id = "report-subject-id";
  subjectId.name = "subjectId";
  subjectId.type = "text";
  subjectId.maxLength = 100;
  subjectId.autocomplete = "off";
  subjectId.disabled = true;
  const subjectHint = node(document, "span", "report-field-hint");
  subjectHint.id = "report-subject-hint";
  subjectHint.textContent =
    "Use an existing person or organization record ID; this is optional.";
  subjectIdLabel.append(subjectHint);
  const subjectError = fieldError(document, subjectId.id);
  connectError(subjectId, subjectHint, subjectError);
  subjectField.append(
    subjectLegend,
    subjectKindLabel,
    subjectKind,
    subjectIdLabel,
    subjectId,
    subjectError,
  );
  subjectKind.addEventListener("change", () => {
    subjectId.disabled = subjectKind.value === "";
    if (!subjectId.disabled) subjectId.focus();
  });

  const descriptionField = node(document, "div", "report-field");
  const descriptionLabel = node(document, "label");
  descriptionLabel.htmlFor = "report-description";
  descriptionLabel.textContent = "Description of the concern or incident ";
  descriptionLabel.append(requiredHint(document, "report-description"));
  const description = node(document, "textarea");
  description.id = "report-description";
  description.name = "description";
  description.required = true;
  description.minLength = 20;
  description.maxLength = 12000;
  description.rows = 7;
  description.autocomplete = "off";
  const descriptionHint = node(document, "span", "report-field-hint");
  descriptionHint.id = "report-description-hint";
  descriptionHint.textContent =
    "20 to 12,000 characters. Include only information relevant to review.";
  descriptionLabel.append(descriptionHint);
  const descriptionError = fieldError(document, description.id);
  connectError(description, descriptionHint, descriptionError);
  descriptionField.append(descriptionLabel, description, descriptionError);

  const evidenceField = node(document, "fieldset", "report-field");
  const evidenceLegend = node(document, "legend");
  evidenceLegend.textContent =
    "Supporting source URLs and evidence descriptions (optional)";
  const evidenceList = node(document, "div", "report-evidence-list");
  const addEvidence = button(
    document,
    "Add a source",
    "report-button report-button-quiet",
  );
  let evidenceSequence = 0;
  const evidenceRows: Array<{
    key: string;
    row: HTMLElement;
    title: HTMLInputElement;
    url: HTMLInputElement;
    note: HTMLTextAreaElement;
    errors: HTMLElement[];
  }> = [];
  const addEvidenceRow = () => {
    if (evidenceRows.length >= 10) return;
    const index = evidenceSequence++;
    const row = node(document, "fieldset", "report-evidence-row");
    const legend = node(document, "legend");
    legend.textContent = `Source ${index + 1}`;
    const titleLabel = node(document, "label");
    titleLabel.htmlFor = `report-evidence-${index}-title`;
    titleLabel.textContent = "Source or evidence description";
    const title = node(document, "input");
    title.id = titleLabel.htmlFor;
    title.type = "text";
    title.maxLength = 200;
    title.autocomplete = "off";
    const titleError = fieldError(document, title.id);
    connectError(title, null, titleError);
    const urlLabel = node(document, "label");
    urlLabel.htmlFor = `report-evidence-${index}-url`;
    urlLabel.textContent = "HTTPS source URL (optional)";
    const url = node(document, "input");
    url.id = urlLabel.htmlFor;
    url.type = "url";
    url.maxLength = 2048;
    url.setAttribute("autocomplete", "url");
    const urlError = fieldError(document, url.id);
    connectError(url, null, urlError);
    const noteLabel = node(document, "label");
    noteLabel.htmlFor = `report-evidence-${index}-note`;
    noteLabel.textContent = "Evidence note (optional)";
    const note = node(document, "textarea");
    note.id = noteLabel.htmlFor;
    note.maxLength = 2000;
    note.rows = 3;
    note.autocomplete = "off";
    const noteError = fieldError(document, note.id);
    connectError(note, null, noteError);
    const remove = button(
      document,
      "Remove source",
      "report-button report-button-quiet",
    );
    remove.addEventListener("click", () => {
      const position = evidenceRows.findIndex((entry) => entry.row === row);
      if (position >= 0) evidenceRows.splice(position, 1);
      row.remove();
      refreshEvidenceControls();
    });
    row.append(
      legend,
      titleLabel,
      title,
      titleError,
      urlLabel,
      url,
      urlError,
      noteLabel,
      note,
      noteError,
      remove,
    );
    evidenceRows.push({
      key: String(index),
      row,
      title,
      url,
      note,
      errors: [titleError, urlError, noteError],
    });
    evidenceList.append(row);
    refreshEvidenceControls();
    title.focus();
  };
  const refreshEvidenceControls = () => {
    addEvidence.disabled = evidenceRows.length >= 10;
    addEvidence.textContent =
      evidenceRows.length >= 10 ? "Maximum of 10 sources" : "Add a source";
  };
  addEvidence.addEventListener("click", addEvidenceRow);
  evidenceField.append(evidenceLegend, evidenceList, addEvidence);

  const reporterField = node(document, "fieldset", "report-field");
  const reporterLegend = node(document, "legend");
  reporterLegend.textContent = "Reporter preferences";
  const attributionGroup = node(document, "div", "report-radio-group");
  const anonymousLabel = node(document, "label", "report-radio-label");
  const anonymous = node(document, "input");
  anonymous.type = "radio";
  anonymous.name = "attribution";
  anonymous.value = "anonymous";
  anonymous.checked = true;
  anonymousLabel.append(anonymous, document.createTextNode(" Anonymous"));
  const signedLabel = node(document, "label", "report-radio-label");
  const signed = node(document, "input");
  signed.type = "radio";
  signed.name = "attribution";
  signed.value = "signed";
  signed.disabled = !options.account;
  signedLabel.append(
    signed,
    document.createTextNode(
      options.account
        ? ` Signed in${options.account.name ? ` as ${options.account.name}` : ""}`
        : " Signed-in reporting (sign in to use this option)",
    ),
  );
  attributionGroup.append(anonymousLabel, signedLabel);
  signed.addEventListener("change", () => {
    if (!signed.checked || !options.account) return;
    if (!nameInput.value && options.account.name) {
      nameInput.value = options.account.name;
    }
    if (!emailInput.value && options.account.email) {
      emailInput.value = options.account.email;
    }
  });
  const attributionError = fieldError(document, "report-attribution");
  attributionError.id = "report-attribution-error";

  const nameLabel = node(document, "label");
  nameLabel.htmlFor = "reporter-name";
  nameLabel.textContent = "Name (optional unless reporting signed in)";
  const nameInput = node(document, "input");
  nameInput.id = nameLabel.htmlFor;
  nameInput.name = "reporterName";
  nameInput.type = "text";
  nameInput.maxLength = 200;
  nameInput.autocomplete = "name";
  const nameError = fieldError(document, nameInput.id);
  connectError(nameInput, null, nameError);

  const emailLabel = node(document, "label");
  emailLabel.htmlFor = "reporter-email";
  emailLabel.textContent = "Email (optional)";
  const emailInput = node(document, "input");
  emailInput.id = emailLabel.htmlFor;
  emailInput.name = "reporterEmail";
  emailInput.type = "email";
  emailInput.maxLength = 254;
  emailInput.autocomplete = "email";
  const emailError = fieldError(document, emailInput.id);
  connectError(emailInput, null, emailError);

  const contactLabel = node(document, "label");
  contactLabel.htmlFor = "report-contact-preference";
  contactLabel.textContent = "Contact preference";
  const contactPreference = node(document, "select");
  contactPreference.id = contactLabel.htmlFor;
  contactPreference.name = "contactPreference";
  const noContact = node(document, "option");
  noContact.value = "none";
  noContact.textContent = "Do not contact me";
  const emailContact = node(document, "option");
  emailContact.value = "email";
  emailContact.textContent = "Email me if more information is needed";
  contactPreference.append(noContact, emailContact);
  const contactError = fieldError(document, contactPreference.id);
  connectError(contactPreference, null, contactError);

  const confidentiality = node(document, "p", "report-confidentiality");
  confidentiality.textContent =
    "Reports are private and reviewed before any possible publication. No submission is published automatically. Do not include information you are not authorized to share.";
  const signedInRequired = node(document, "p", "report-field-hint");
  signedInRequired.textContent =
    "Signed-in reporting uses the authenticated account provided by this site; it does not sign you in here.";
  reporterField.append(
    reporterLegend,
    attributionGroup,
    attributionError,
    nameLabel,
    nameInput,
    nameError,
    emailLabel,
    emailInput,
    emailError,
    contactLabel,
    contactPreference,
    contactError,
    confidentiality,
    signedInRequired,
  );

  const submitButton = node(document, "button", "report-button");
  submitButton.type = "submit";
  submitButton.textContent = "Submit privately for review";
  const noUploads = node(document, "p", "report-field-hint");
  noUploads.textContent =
    "File uploads are not available. Add source URLs and descriptions instead.";
  form.append(
    errorSummary,
    countyField,
    subjectField,
    descriptionField,
    evidenceField,
    reporterField,
    formStatus,
    submitButton,
    noUploads,
  );

  const receiptPanel = node(document, "section", "report-receipt");
  receiptPanel.setAttribute("aria-labelledby", "report-receipt-heading");
  receiptPanel.hidden = true;
  const receiptHeading = node(document, "h2");
  receiptHeading.id = "report-receipt-heading";
  receiptHeading.tabIndex = -1;
  receiptHeading.textContent = "Keep your private tracking credentials";
  const receiptIntro = node(document, "p");
  receiptIntro.textContent =
    "Your report is awaiting private review. Save both values securely. The recovery key is shown only once and cannot be retrieved later.";
  const receiptReference = node(document, "code");
  const receiptRecoveryCode = node(document, "code");
  const referenceLabel = node(document, "p");
  referenceLabel.append(
    document.createTextNode("Tracking reference: "),
    receiptReference,
  );
  const keyLabel = node(document, "p");
  keyLabel.append(
    document.createTextNode("Recovery key: "),
    receiptRecoveryCode,
  );
  const receiptStatus = node(document, "p", "report-status");
  receiptStatus.setAttribute("role", "status");
  receiptStatus.setAttribute("aria-live", "polite");
  const copyReference = button(
    document,
    "Copy tracking reference",
    "report-button report-button-quiet",
  );
  const copyKey = button(
    document,
    "Copy recovery key",
    "report-button report-button-quiet",
  );
  const trackingLink = node(document, "a", "report-button");
  trackingLink.href = options.trackingHref ?? "#report-track";
  trackingLink.textContent = "Go to Track a Report";
  const copyValue = async (value: string, label: string) => {
    try {
      if (!window?.navigator.clipboard)
        throw new Error("Clipboard unavailable");
      await window.navigator.clipboard.writeText(value);
      receiptStatus.textContent = `${label} copied.`;
    } catch {
      receiptStatus.textContent = `Couldn't copy the ${label.toLowerCase()}. Select it and copy it manually.`;
    }
  };
  copyReference.addEventListener("click", () => {
    void copyValue(receiptReference.textContent ?? "", "Tracking reference");
  });
  copyKey.addEventListener("click", () => {
    void copyValue(receiptRecoveryCode.textContent ?? "", "Recovery key");
  });
  receiptPanel.append(
    receiptHeading,
    receiptIntro,
    referenceLabel,
    keyLabel,
    copyReference,
    copyKey,
    trackingLink,
    receiptStatus,
  );

  submitPanel.append(submitHeading, submitIntro, form, receiptPanel);

  const trackHeading = node(document, "h1", "report-heading");
  trackHeading.id = "report-track-heading";
  trackHeading.textContent = "Track a Report";
  const trackIntro = node(document, "p", "report-intro");
  trackIntro.textContent =
    "Enter the tracking reference and recovery key you received when you submitted the report.";
  const trackForm = node(document, "form", "report-form");
  trackForm.noValidate = true;
  const trackingError = node(document, "p", "report-tracking-error");
  trackingError.setAttribute("role", "alert");
  trackingError.hidden = true;
  const trackingStatus = node(document, "p", "report-status");
  trackingStatus.setAttribute("role", "status");
  trackingStatus.setAttribute("aria-live", "polite");

  const referenceLabelInput = node(document, "label");
  referenceLabelInput.htmlFor = "tracking-reference";
  referenceLabelInput.textContent = "Tracking reference";
  const referenceInput = node(document, "input");
  referenceInput.id = referenceLabelInput.htmlFor;
  referenceInput.name = "reference";
  referenceInput.type = "text";
  referenceInput.required = true;
  referenceInput.autocomplete = "off";
  referenceInput.maxLength = 19;
  referenceInput.spellcheck = false;
  const referenceInputError = fieldError(document, referenceInput.id);
  connectError(referenceInput, null, referenceInputError);
  const keyLabelInput = node(document, "label");
  keyLabelInput.htmlFor = "tracking-recovery-key";
  keyLabelInput.textContent = "Recovery key";
  const keyInput = node(document, "input");
  keyInput.id = keyLabelInput.htmlFor;
  keyInput.name = "recoveryKey";
  keyInput.type = "password";
  keyInput.required = true;
  keyInput.autocomplete = "off";
  keyInput.maxLength = 64;
  keyInput.spellcheck = false;
  const keyInputError = fieldError(document, keyInput.id);
  connectError(keyInput, null, keyInputError);
  const trackButton = node(document, "button", "report-button");
  trackButton.type = "submit";
  trackButton.textContent = "View private status";
  const trackingResult = node(document, "section", "report-tracking-result");
  trackingResult.setAttribute("aria-live", "polite");
  trackingResult.setAttribute("aria-label", "Private report status");
  trackingResult.hidden = true;
  trackForm.append(
    trackingError,
    referenceLabelInput,
    referenceInput,
    referenceInputError,
    keyLabelInput,
    keyInput,
    keyInputError,
    trackingStatus,
    trackButton,
    trackingResult,
  );
  trackPanel.append(trackHeading, trackIntro, trackForm);

  section.append(tabs, submitPanel, trackPanel);
  root.replaceChildren(section);

  let submitting = false;
  let tracking = false;
  let pendingIdempotencyKey: string | null = null;
  let issuedRecoveryKey: string | null = null;
  let receiptDisclosed = false;
  const fields: ReadonlyArray<{
    id: string;
    error: HTMLElement;
    getMessage: (errors: FieldErrors) => string | undefined;
  }> = [
    {
      id: countySelect.id,
      error: countyError,
      getMessage: (errors) => errors.county,
    },
    {
      id: subjectId.id,
      error: subjectError,
      getMessage: (errors) => errors.subject,
    },
    {
      id: description.id,
      error: descriptionError,
      getMessage: (errors) => errors.description,
    },
    { id: nameInput.id, error: nameError, getMessage: (errors) => errors.name },
    {
      id: emailInput.id,
      error: emailError,
      getMessage: (errors) => errors.email,
    },
    {
      id: contactPreference.id,
      error: contactError,
      getMessage: (errors) => errors.contact,
    },
    {
      id: referenceInput.id,
      error: referenceInputError,
      getMessage: (errors) => errors["tracking-reference"],
    },
    {
      id: keyInput.id,
      error: keyInputError,
      getMessage: (errors) => errors["tracking-recovery-key"],
    },
  ];

  const clearRecoveryDisclosure = () => {
    if (!receiptDisclosed) return;
    issuedRecoveryKey = null;
    setText(receiptRecoveryCode, "");
    copyKey.hidden = true;
    keyLabel.hidden = true;
    receiptIntro.textContent =
      "The recovery key is no longer displayed and cannot be retrieved. Use the tracking reference with the key you saved.";
    receiptDisclosed = false;
  };
  const updateView = () => {
    const trackView = window?.location.hash === "#report-track";
    submitPanel.hidden = trackView;
    trackPanel.hidden = !trackView;
    submitTab.setAttribute("aria-current", String(!trackView));
    trackTab.setAttribute("aria-current", String(trackView));
    if (trackView) clearRecoveryDisclosure();
  };
  const onHashChange = () => updateView();
  window?.addEventListener("hashchange", onHashChange);
  trackingLink.addEventListener("click", () => clearRecoveryDisclosure());
  form.addEventListener("input", () => {
    if (formStatus.textContent) {
      pendingIdempotencyKey = null;
      formStatus.textContent = "";
    }
  });
  updateView();

  const applyErrors = (errors: FieldErrors) => {
    errorList.replaceChildren();
    let firstInvalid: HTMLElement | undefined;
    for (const field of fields) {
      const control = document.getElementById(field.id);
      if (!control) continue;
      const message = field.getMessage(errors);
      if (field.id.startsWith("tracking-")) continue;
      control.removeAttribute("aria-invalid");
      field.error.hidden = true;
      if (message) {
        control.setAttribute("aria-invalid", "true");
        field.error.textContent = message;
        field.error.hidden = false;
        const item = node(document, "li");
        const link = node(document, "a");
        link.href = `#${field.id}`;
        link.textContent = message;
        item.append(link);
        errorList.append(item);
        firstInvalid ??= control;
      }
    }
    for (const entry of evidenceRows) {
      for (const [index, control] of [
        entry.title,
        entry.url,
        entry.note,
      ].entries()) {
        const error = entry.errors[index];
        if (!error) continue;
        const message = errors[control.id];
        control.removeAttribute("aria-invalid");
        error.hidden = true;
        if (message) {
          control.setAttribute("aria-invalid", "true");
          error.textContent = message;
          error.hidden = false;
          const item = node(document, "li");
          const link = node(document, "a");
          link.href = `#${control.id}`;
          link.textContent = message;
          item.append(link);
          errorList.append(item);
          firstInvalid ??= control;
        }
      }
    }
    const attributionMessage = errors.attribution;
    attributionError.hidden = !attributionMessage;
    if (attributionMessage) {
      attributionError.textContent = attributionMessage;
      const item = node(document, "li");
      item.textContent = attributionMessage;
      errorList.append(item);
    }
    errorSummary.hidden = errorList.childElementCount === 0;
    if (!errorSummary.hidden) errorSummary.focus();
    return firstInvalid;
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || form.hidden || receiptDisclosed) return;
    formStatus.textContent = "";
    const evidence = evidenceRows.map(({ key, title, url, note }) => ({
      key,
      title: title.value.trim(),
      url: url.value.trim(),
      note: note.value.trim(),
    }));
    const values = {
      countyId: countySelect.value,
      description: description.value,
      subjectKind: subjectKind.value,
      subjectId: subjectId.value.trim(),
      name: nameInput.value.trim(),
      email: emailInput.value.trim(),
      attribution: signed.checked ? "signed" : "anonymous",
      contactPreference: contactPreference.value,
    };
    const errors = validateForm(
      values,
      options.counties,
      evidence,
      Boolean(options.account),
    );
    const firstInvalid = applyErrors(errors);
    if (
      firstInvalid ||
      !countySelect.value ||
      description.value.trim().length < 20
    ) {
      if (!firstInvalid) errorSummary.focus();
      return;
    }

    const idempotencyKey =
      pendingIdempotencyKey ??
      (options.createIdempotencyKey ?? defaultIdempotencyKey)();
    pendingIdempotencyKey = idempotencyKey;
    const submission: ReportSubmission = {
      countyId: values.countyId,
      ...(values.subjectKind
        ? {
            subject: {
              kind: values.subjectKind === "person" ? "person" : "organization",
              id: values.subjectId,
            },
          }
        : {}),
      description: values.description.trim(),
      evidence: evidence
        .filter((item) => item.title || item.url || item.note)
        .map((item) => ({
          title: item.title,
          ...(item.url ? { url: item.url } : {}),
          ...(item.note ? { note: item.note } : {}),
        })),
      reporter: {
        ...(signed.checked && options.account
          ? {
              accountId: options.account.accountId,
              ...(values.name ? { name: values.name } : {}),
              ...(values.email ? { email: values.email } : {}),
            }
          : {
              ...(values.name ? { name: values.name } : {}),
              ...(values.email ? { email: values.email } : {}),
            }),
        attribution: signed.checked ? "signed" : "anonymous",
        confidential: true,
        contactPreference:
          values.contactPreference === "email" ? "email" : "none",
      },
      idempotencyKey,
    };

    submitting = true;
    submitButton.disabled = true;
    submitButton.textContent = "Submitting privately…";
    try {
      const receipt = await options.adapter.submit(submission);
      pendingIdempotencyKey = null;
      setText(receiptReference, receipt.reference);
      issuedRecoveryKey = receipt.recoveryKey ?? null;
      receiptDisclosed = Boolean(issuedRecoveryKey);
      if (issuedRecoveryKey) {
        setText(receiptRecoveryCode, issuedRecoveryKey);
        keyLabel.hidden = false;
        copyKey.hidden = false;
        receiptIntro.textContent =
          "Your report is awaiting private review. Save both values securely. The recovery key is shown only once and cannot be retrieved later.";
      } else {
        keyLabel.hidden = true;
        copyKey.hidden = true;
        receiptIntro.textContent =
          "This receipt was previously issued. Its recovery key cannot be shown again; use the key you saved to track the report.";
      }
      form.hidden = true;
      receiptPanel.hidden = false;
      receiptHeading.focus();
    } catch {
      formStatus.textContent =
        "We couldn't submit this report. Your entries remain here; try again when the service is available.";
    } finally {
      submitting = false;
      submitButton.disabled = false;
      submitButton.textContent = "Submit privately for review";
    }
  });

  trackForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (tracking) return;
    trackingError.hidden = true;
    trackingStatus.textContent = "";
    trackingResult.hidden = true;
    trackingResult.replaceChildren();
    referenceInputError.hidden = true;
    keyInputError.hidden = true;
    referenceInput.removeAttribute("aria-invalid");
    keyInput.removeAttribute("aria-invalid");
    const reference = referenceInput.value.trim().toUpperCase();
    const recoveryKey = keyInput.value.trim();
    const errors: Record<string, string> = {};
    if (!reference || !recoveryKey) {
      if (!reference)
        errors["tracking-reference"] = "Enter your tracking reference.";
      if (!recoveryKey)
        errors["tracking-recovery-key"] = "Enter your recovery key.";
      for (const field of fields.slice(-2)) {
        const message = field.getMessage(errors);
        if (!message) continue;
        const control = document.getElementById(field.id);
        control?.setAttribute("aria-invalid", "true");
        field.error.textContent = message;
        field.error.hidden = false;
      }
      return;
    }
    tracking = true;
    trackButton.disabled = true;
    trackButton.textContent = "Checking credentials…";
    try {
      const projection = await options.adapter.track(reference, recoveryKey);
      const heading = node(document, "h2");
      heading.textContent = "Private report status";
      const status = node(document, "p");
      const currentStatus = node(document, "strong");
      currentStatus.textContent =
        STATUS_LABELS[projection.status] ?? "Status unavailable";
      status.append(document.createTextNode("Current status: "), currentStatus);
      const submitted = node(document, "p");
      submitted.textContent = `Submitted: ${formatDate(projection.submittedAt)}`;
      const historyHeading = node(document, "h3");
      historyHeading.textContent = "Status history";
      const historyList = node(document, "ol");
      for (const entry of projection.history) {
        const item = node(document, "li");
        const previous = entry.from ? `${STATUS_LABELS[entry.from]} → ` : "";
        item.textContent = `${previous}${STATUS_LABELS[entry.to] ?? "Status updated"} — ${formatDate(entry.at)}`;
        historyList.append(item);
      }
      trackingResult.append(
        heading,
        status,
        submitted,
        historyHeading,
        historyList,
      );
      trackingResult.hidden = false;
      trackingStatus.textContent =
        "Credentials verified. This is the reporter-safe status view.";
      keyInput.value = "";
    } catch {
      trackingError.textContent =
        "We couldn't verify those credentials. Check them and try again.";
      trackingError.hidden = false;
    } finally {
      tracking = false;
      trackButton.disabled = false;
      trackButton.textContent = "View private status";
    }
  });

  return {
    destroy() {
      window?.removeEventListener("hashchange", onHashChange);
      clearRecoveryDisclosure();
      root.replaceChildren();
    },
  };
}
