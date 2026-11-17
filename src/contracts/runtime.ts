import type { HumanSignInEnvironment } from "../auth/config.js";
import type { D1Binding } from "../database/d1.js";
import type { R2BucketLike } from "../services/banner-storage.js";

export interface RuntimeEnvironment extends HumanSignInEnvironment {
  readonly APP_ENV?: string;
  /** Test-only switch; ignored outside the disposable local test Worker. */
  readonly REPORTS_TEST_ABUSE_CONTROL?: string;
  /** Default-off switch for Turnstile-protected guest intake. Exactly "enabled". */
  readonly REPORTS_TURNSTILE?: string;
  /** Public widget sitekey, exposed to the report page. */
  readonly REPORTS_TURNSTILE_SITEKEY?: string;
  /** Worker-only widget secret. Never rendered, logged or returned. */
  readonly REPORTS_TURNSTILE_SECRET?: string;
  /** Exact public origin that hosts the report page. */
  readonly REPORTS_TURNSTILE_ORIGIN?: string;
  /** Test-only Siteverify substitute. Honored only for loopback under APP_ENV=test. */
  readonly REPORTS_TEST_TURNSTILE_VERIFY_URL?: string;
  /**
   * AI proposals are off unless set. `fixture` is deterministic and offline.
   * `openai` also needs `OPENAI_API_KEY` and `AI_MODEL`, set as Worker secrets.
   */
  readonly AI_PROVIDER?: string;
  readonly AI_MODEL?: string;
  readonly OPENAI_API_KEY?: string;
  readonly DB?: D1Binding;
  /** Optional Sites R2 binding; pages keep their placeholder when absent. */
  readonly BUCKET?: R2BucketLike;
}
