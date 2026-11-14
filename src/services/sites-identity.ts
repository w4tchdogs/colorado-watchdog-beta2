import type { HumanIdentityAdapter, HumanIdentityClaim } from "./security.js";

/**
 * Identity supplied by a hosting adapter only after it verifies the platform's
 * authenticated request context. Do not construct this from Request headers.
 */
export interface VerifiedSitesIdentity {
  readonly userId: string;
}

export type VerifiedSitesContext = (
  request: Request,
) => Promise<VerifiedSitesIdentity | null>;

/** Fail-closed Sites bridge. Without a host supplied verifier it resolves nobody. */
export function createSitesIdentityAdapter(
  context?: VerifiedSitesContext,
): HumanIdentityAdapter {
  return {
    async resolve(request): Promise<HumanIdentityClaim | null> {
      if (!context) return null;
      const identity = await context(request);
      if (
        !identity ||
        typeof identity.userId !== "string" ||
        !identity.userId.trim() ||
        identity.userId.length > 512
      )
        return null;
      return { provider: "chatgpt-sites", subject: identity.userId };
    },
  };
}
