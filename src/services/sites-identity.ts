import type { HumanIdentityAdapter, HumanIdentityClaim } from "./security.js";

/** Identity decoded by the trusted Sites host boundary, not by request headers. */
export interface VerifiedSitesIdentity {
  readonly userId: string;
  readonly email: string;
  readonly fullName?: string | null;
}

export type VerifiedSitesContext = (
  request: Request,
) => Promise<VerifiedSitesIdentity | null>;

export interface SitesIdentityAdapterOptions {
  /** Opaque Sites project identifier; Sites user IDs are scoped to this value. */
  readonly siteId: string;
  /** Must be supplied by the trusted Sites runtime boundary. */
  readonly context?: VerifiedSitesContext;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

/**
 * Sites identity bridge. It never reads headers itself; without a trusted host
 * context, it fails closed. Email/name are claim metadata and never authorize.
 */
export function createSitesIdentityAdapter(
  options: SitesIdentityAdapterOptions,
): HumanIdentityAdapter {
  const siteId = options.siteId.trim();
  if (!siteId || siteId.length > 256 || hasControlCharacters(siteId)) {
    throw new TypeError("A valid Sites project identifier is required");
  }
  const provider = `chatgpt-sites:${siteId}`;

  return {
    async resolve(request): Promise<HumanIdentityClaim | null> {
      if (!options.context) return null;
      let identity: VerifiedSitesIdentity | null;
      try {
        identity = await options.context(request);
      } catch {
        return null;
      }
      if (
        !identity ||
        typeof identity.userId !== "string" ||
        !identity.userId.trim() ||
        identity.userId.length > 512 ||
        typeof identity.email !== "string" ||
        !identity.email.trim() ||
        identity.email.length > 320 ||
        hasControlCharacters(identity.userId + identity.email)
      ) {
        return null;
      }
      const fullName =
        typeof identity.fullName === "string" &&
        identity.fullName.trim() &&
        identity.fullName.length <= 512 &&
        !hasControlCharacters(identity.fullName)
          ? identity.fullName.trim()
          : null;
      return {
        provider,
        subject: identity.userId.trim(),
        email: identity.email.trim(),
        displayName: fullName ?? identity.email.trim(),
      };
    },
  };
}
