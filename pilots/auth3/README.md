# AUTH-3 isolated sign-in pilot

This is a disposable Worker project for testing Auth0 OIDC on Sites. It is intentionally separate from Alpha-1 and uses its own D1. `AUTH0_ENABLED` must remain `false` until the owner configures the Auth0 tenant and the synthetic identity has been deliberately linked in this pilot D1. No GitHub profile field grants Website access.

Expected pilot origin: `https://colorado-watchdog-auth3-pilot.futureguild2.chatgpt.site`

Runtime settings (set in Sites, never in source): `AUTH0_ENABLED`, `AUTH0_ISSUER`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_REDIRECT_URI`. The redirect URI is the exact origin above plus `/auth/callback`. The fixed provider issuer must be the default Auth0 tenant issuer ending in `/`.

The pilot D1 starts with only a synthetic contributor account and an unlinked sentinel subject. Before a hosted linked-user test, replace that sentinel with the verified `sub` for the synthetic Auth0/GitHub test identity using the Sites D1 editor. Do not use an email or username as the subject. The contributor role has no Website capabilities; the only protected resource is `/auth/test-view`.

Session lifetime: 30 minutes idle, 8 hours absolute. Transaction lifetime: 5 minutes. No refresh tokens are requested or retained.
