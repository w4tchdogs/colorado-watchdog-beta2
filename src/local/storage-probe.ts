import type { StorageProbe } from "../contracts/storage.js";

export function createLocalStorageProbe(): StorageProbe {
  return {
    async check() {},
  };
}
