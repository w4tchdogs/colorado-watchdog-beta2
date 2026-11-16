import { CHALLENGE_ACTION } from "../services/report-challenge.js";
import type { ReportChallenge } from "./report-interface.js";

const SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const LOAD_TIMEOUT_MS = 15_000;
const CHECK_TIMEOUT_MS = 120_000;

export const TURNSTILE_DISCLOSURE =
  "To protect this form from automated abuse, submitting runs a Cloudflare Turnstile check. Cloudflare receives your IP address, browser signals and this page's address to decide whether you are a person. Cloudflare states that it does not receive what you type into this form.";

interface TurnstileApi {
  render(
    container: HTMLElement,
    parameters: Record<string, unknown>,
  ): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * Loads the Turnstile script only when a visitor first submits, so the page
 * makes no request to the provider until then. The script is requested once.
 * A failed load can be retried on the next submit.
 */
export function createTurnstileChallenge(sitekey: string): ReportChallenge {
  let loading: Promise<TurnstileApi> | null = null;
  let widgetId: string | undefined;
  let spent = false;
  let pending: {
    resolve(token: string): void;
    reject(error: Error): void;
  } | null = null;

  function load(): Promise<TurnstileApi> {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (loading) return loading;
    const attempt = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement("script");
      const timer = window.setTimeout(() => fail(), LOAD_TIMEOUT_MS);
      const fail = () => {
        window.clearTimeout(timer);
        script.remove();
        reject(new Error("Challenge script unavailable"));
      };
      script.src = SCRIPT_URL;
      script.async = true;
      script.onload = () => {
        window.clearTimeout(timer);
        if (window.turnstile) resolve(window.turnstile);
        else fail();
      };
      script.onerror = fail;
      document.head.append(script);
    });
    loading = attempt;
    // A failed load is forgotten so the next submit requests the script again.
    attempt.catch(() => {
      if (loading === attempt) loading = null;
    });
    return attempt;
  }

  const settle = (outcome: { token: string } | { error: Error }) => {
    const current = pending;
    pending = null;
    if (!current) return;
    if ("token" in outcome) current.resolve(outcome.token);
    else current.reject(outcome.error);
  };

  return {
    disclosure: TURNSTILE_DISCLOSURE,
    async acquire(container, announce) {
      announce("Loading the human check…");
      const api = await load();
      const token = new Promise<string>((resolve, reject) => {
        pending = { resolve, reject };
      });
      const timer = window.setTimeout(
        () => settle({ error: new Error("Challenge timed out") }),
        CHECK_TIMEOUT_MS,
      );
      try {
        if (widgetId === undefined) {
          widgetId = api.render(container, {
            sitekey,
            action: CHALLENGE_ACTION,
            "refresh-expired": "manual",
            "before-interactive-callback": () =>
              announce(
                "Please complete the human check shown below, then wait for it to finish.",
              ),
            callback: (value: string) => {
              spent = false;
              announce("Human check complete.");
              settle({ token: value });
            },
            "error-callback": () => {
              settle({ error: new Error("Challenge failed") });
              return true;
            },
            "timeout-callback": () =>
              settle({ error: new Error("Challenge timed out") }),
            "expired-callback": () => {
              spent = true;
            },
          });
          if (widgetId === undefined) throw new Error("Challenge unavailable");
        } else if (spent) {
          api.reset(widgetId);
        }
        return await token;
      } finally {
        window.clearTimeout(timer);
        pending = null;
      }
    },
    reset() {
      // The next acquire restarts the widget, so a spent token is never reused.
      spent = true;
      settle({ error: new Error("Challenge reset") });
    },
  };
}
