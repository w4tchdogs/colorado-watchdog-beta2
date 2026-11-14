import type { D1Binding } from "../database/d1.js";

export interface RuntimeEnvironment {
  readonly APP_ENV?: string;
  /** Test-only switch; ignored outside the disposable local test Worker. */
  readonly REPORTS_TEST_ABUSE_CONTROL?: string;
  readonly DB?: D1Binding;
}
