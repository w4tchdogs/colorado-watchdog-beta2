// HTTP surface. Routes parse the request and call a service function. They hold no
// business logic. M0 exposes two read-only routes so the skeleton can be exercised.
import type { ServiceContext } from "./services/context.ts";
import { getCounty, listCounties } from "./services/counties.ts";
import { foundationStatus } from "./services/status.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });

export async function handleRequest(request: Request, ctx: ServiceContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
  if (pathname === "/api/v1/status") return json(await foundationStatus(ctx));
  if (pathname === "/api/v1/counties") return json({ counties: await listCounties(ctx) });
  const match = /^\/api\/v1\/counties\/(\d{5})$/.exec(pathname);
  if (match?.[1]) {
    const county = await getCounty(ctx, match[1]);
    return county ? json(county) : json({ error: "County not found." }, 404);
  }
  return json({ error: "Not found." }, 404);
}
