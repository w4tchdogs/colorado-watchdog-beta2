import { createEditorApiClient } from "./api-client.js";
import { mountEditorApp } from "./app.js";

const root = document.getElementById("app");
const token =
  document
    .querySelector('meta[name="editor-token"]')
    ?.getAttribute("content") ?? "";

if (root) {
  const session = { account: "author" };
  const client = createEditorApiClient({
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      }),
    token,
    account: () => session.account,
  });
  mountEditorApp(root, { doc: document, client, session });
}
