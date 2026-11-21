import { SANDBOX_ACCOUNT_HEADER, SANDBOX_TOKEN_HEADER } from "./api-client.js";
import {
  type Dashboard,
  type DashboardOptions,
  type DashboardStripHooks,
  mountDashboard,
} from "./dashboard.js";
import { el } from "./dom.js";

/**
 * Local sandbox only. The synthetic account switch and the sandbox request
 * headers live here so the hosted dashboard bundle, which never imports this
 * file, carries none of them.
 */
export interface DashboardSandboxSwitch {
  readonly draftReview?: boolean;
  readonly accounts: readonly {
    readonly key: string;
    readonly label: string;
  }[];
  current(): string;
  switchTo(key: string): void;
}

/** Headers the sandbox server requires on every request. */
export function sandboxHeaders(connection: {
  readonly token: string;
  readonly account: () => string;
}): () => Record<string, string> {
  return () => ({
    [SANDBOX_TOKEN_HEADER]: connection.token,
    [SANDBOX_ACCOUNT_HEADER]: connection.account(),
  });
}

function buildSandboxBar(
  doc: Document,
  sandbox: DashboardSandboxSwitch,
  hooks: DashboardStripHooks,
): HTMLElement {
  const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Parameters<typeof el>[2] = {},
    ...children: Parameters<typeof el>[3][]
  ) => el(doc, tag, attributes, ...children);
  const select = h("select", { id: "sandbox-account" });
  for (const account of sandbox.accounts) {
    select.appendChild(h("option", { value: account.key }, account.label));
  }
  select.value = sandbox.current();
  select.addEventListener("change", () => {
    if (!hooks.canLeave()) {
      select.value = sandbox.current();
      return;
    }
    sandbox.switchTo(select.value);
    hooks.announce(`Now acting as ${select.selectedOptions[0]?.text ?? ""}`);
    hooks.restart();
  });
  return h(
    "div",
    { class: "dash-sandbox", id: "sandbox-bar" },
    h(
      "p",
      { class: "sandbox-flag", id: "sandbox-flag" },
      sandbox.draftReview
        ? "PRIVATE LOCAL DRAFT REVIEW - changes are saved on this computer"
        : "LOCAL SANDBOX - fictional data only, nothing is published",
    ),
    h(
      "div",
      { class: "account-switch" },
      h("label", { for: "sandbox-account" }, "Acting as"),
      select,
    ),
  );
}

export type SandboxDashboardOptions = Omit<
  DashboardOptions,
  "topStrip" | "titleSuffix" | "signedOutNote" | "signOut"
> & { readonly sandbox: DashboardSandboxSwitch };

export function mountSandboxDashboard(
  root: HTMLElement,
  options: SandboxDashboardOptions,
): Dashboard {
  const { sandbox, ...rest } = options;
  return mountDashboard(root, {
    ...rest,
    topStrip: (hooks) => buildSandboxBar(options.doc, sandbox, hooks),
    titleSuffix: " (local sandbox)",
    signedOutNote: "In this local sandbox, choose an account under Acting as.",
  });
}
