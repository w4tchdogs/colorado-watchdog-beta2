import type { StorageProbe } from "../contracts/storage.js";

export interface ApplicationServices {
  health(): Promise<{ status: "ok" }>;
}

export interface ServiceDependencies {
  readonly storage?: StorageProbe;
}

export function createServices(
  dependencies: ServiceDependencies = {},
): ApplicationServices {
  return {
    async health() {
      await dependencies.storage?.check();
      return { status: "ok" };
    },
  };
}
