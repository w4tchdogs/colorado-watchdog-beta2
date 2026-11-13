// Everything a service function needs. Routes, the dashboard, the API and later the MCP
// endpoint all build one of these and call the same service functions. Later M0 work adds
// the acting account and the capability check here.
import type { Db } from "../db/client.ts";

export interface ServiceContext {
  db: Db;
  now: () => string;
  newId: () => string;
}

export function serviceContext(db: Db): ServiceContext {
  return {
    db,
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  };
}
