import type { ServiceContext } from "./context.ts";

export interface FoundationStatus {
  service: string;
  milestone: string;
  counties: number;
}

export async function foundationStatus(ctx: ServiceContext): Promise<FoundationStatus> {
  const row = await ctx.db.first<{ total: number }>("SELECT count(*) AS total FROM counties");
  return { service: "colorado-watchdog-beta2", milestone: "M0", counties: row?.total ?? 0 };
}
