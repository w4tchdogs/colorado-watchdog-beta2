import type { AsyncD1Database } from "../database/d1.js";
import type {
  HumanIdentityAdapter,
  HumanIdentityClaim,
} from "../services/security.js";
import type { HumanSignInState } from "./config.js";
import { handleHash, SESSION_COOKIE, singleHandleCookie } from "./http.js";
import { findLiveSession, refreshIdleExpiry } from "./store.js";

/**
 * Session-backed human identity. It reads only the Website's own `__Host-`
 * session cookie, resolves it against D1 and returns the link the session was
 * issued for. The D1 account service then derives the principal and its
 * capabilities from the live account and identity rows, so role changes,
 * disabling and revocation apply on the next request.
 *
 * Disabling sign-in denies here, before any lookup or idle refresh.
 */
export function createSessionIdentityAdapter(options: {
  readonly database: AsyncD1Database;
  readonly signIn: HumanSignInState;
  readonly now?: () => Date;
}): HumanIdentityAdapter {
  const now = options.now ?? (() => new Date());
  return {
    async resolve(request): Promise<HumanIdentityClaim | null> {
      const { signIn } = options;
      if (signIn.status !== "enabled") return null;
      const { config } = signIn;
      // Human sessions exist only on the canonical origin.
      if (new URL(request.url).origin !== config.canonicalOrigin) return null;
      // Exactly one well-formed cookie. Duplicates are ambiguous, never merged.
      const handle = singleHandleCookie(request, SESSION_COOKIE);
      if (handle === null) return null;
      const current = now();
      const session = await findLiveSession(
        options.database,
        await handleHash(handle),
        config.provider,
        current,
      );
      if (!session) return null;
      await refreshIdleExpiry(options.database, session, current);
      return { provider: session.provider, subject: session.subject };
    },
  };
}
