import { createFictionalReportAdapter } from "/assets/report-demo.js";
import { mountReportInterface } from "/assets/report-interface.js";

const root = document.getElementById("report-demo");
if (root) {
  try {
    const response = await fetch("/demo/counties.json", { cache: "no-store" });
    if (!response.ok) throw new Error("The county registry is unavailable.");
    const counties = await response.json();
    mountReportInterface(root, {
      counties,
      adapter: createFictionalReportAdapter(),
      account: {
        accountId: "synthetic-demo-account",
        name: "Fictional Reporter",
        email: "reporter@example.invalid",
      },
      demoNotice:
        "Do not enter real personal or report information. This fixture keeps generated credentials and a status projection only in browser memory; nothing is sent to a reporting service or saved after reload.",
    });
  } catch {
    root.textContent =
      "The fictional report demonstration could not start. No report data was sent.";
  }
}
