export interface StorageProbe {
  check(): Promise<void>;
}

export class StorageUnavailableError extends Error {
  constructor() {
    super("Storage dependency unavailable");
    this.name = "StorageUnavailableError";
  }
}
