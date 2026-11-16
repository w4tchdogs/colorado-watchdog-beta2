import type { D1Binding } from "../database/d1.js";
import type { R2BucketLike } from "../services/banner-storage.js";

export interface RuntimeEnvironment {
  readonly APP_ENV?: string;
  /** Test-only switch; ignored outside the disposable local test Worker. */
  readonly REPORTS_TEST_ABUSE_CONTROL?: string;
  readonly DB?: D1Binding;
  /** Optional Sites R2 binding; pages keep their placeholder when absent. */
  readonly BUCKET?: R2BucketLike;
  /** Temporary 256-bit bearer secret for the isolated R2 binding diagnostic. */
  readonly R2_DIAGNOSTIC_TOKEN?: string;
}
