import type { ServiceContext } from "./context.ts";

export interface County {
  fips: string;
  name: string;
  slug: string;
}

export function listCounties(ctx: ServiceContext): Promise<County[]> {
  return ctx.db.all<County & Record<string, string>>(
    "SELECT fips, name, slug FROM counties ORDER BY fips",
  );
}

export function getCounty(ctx: ServiceContext, fips: string): Promise<County | null> {
  return ctx.db.first<County & Record<string, string>>(
    "SELECT fips, name, slug FROM counties WHERE fips = ?",
    [fips],
  );
}
