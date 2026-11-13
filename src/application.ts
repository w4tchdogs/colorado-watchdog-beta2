import { StorageUnavailableError } from "./contracts/storage.js";
import type { ApplicationServices } from "./services/index.js";

const HEALTH_PATH = "/_internal/health";

export function createApplication(services: ApplicationServices) {
  return {
    fetch(request: Request): Promise<Response> {
      return dispatch(request, services);
    },
  };
}

async function dispatch(
  request: Request,
  services: ApplicationServices,
): Promise<Response> {
  const url = new URL(request.url);
  let pathname: string;

  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    if (error instanceof URIError) {
      return jsonResponse(400, { error: "malformed_path" });
    }
    throw error;
  }

  if (pathname !== HEALTH_PATH) {
    return jsonResponse(404, { error: "not_found" });
  }

  if (request.method !== "GET") {
    return jsonResponse(405, { error: "method_not_allowed" }, { allow: "GET" });
  }

  if (url.search !== "") {
    return jsonResponse(400, { error: "unexpected_query" });
  }

  try {
    return jsonResponse(200, await services.health());
  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      return jsonResponse(503, { error: "dependency_unavailable" });
    }
    throw error;
  }
}

function jsonResponse(
  status: number,
  body: Readonly<Record<string, string>>,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
