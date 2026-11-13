// Worker entry point. Builds the service context from platform bindings and delegates.
import { handleRequest } from "./app.ts";
import { type D1DatabaseLike, d1Db } from "./db/d1.ts";
import { serviceContext } from "./services/context.ts";

interface Env {
  DB?: D1DatabaseLike;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.DB) {
      return new Response(JSON.stringify({ error: "Database binding is not configured." }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return handleRequest(request, serviceContext(d1Db(env.DB)));
  },
};
