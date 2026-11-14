import type { D1Binding } from "../database/d1.js";

export interface RuntimeEnvironment {
  readonly APP_ENV?: string;
  readonly DB?: D1Binding;
}
