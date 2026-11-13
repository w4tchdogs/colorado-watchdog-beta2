import type { CheckpointService } from "../contracts/checkpoints.js";
import type { DirectoryPageRequest } from "../contracts/directory.js";
import type {
  OrganizationProfilePageRequest,
  OrganizationRolePageRequest,
} from "../contracts/organization-profile.js";
import type { PersonProfilePageRequest } from "../contracts/person-profile.js";
import type { StorageProbe } from "../contracts/storage.js";
import { StorageUnavailableError } from "../contracts/storage.js";
import type { WebsiteDatabase } from "../database/sqlite.js";
import {
  changeAccountRole,
  createAccount,
  createHumanIdentity,
  getAccount,
  issueAgentCredential,
  type NewAccount,
  revokeIdentity,
  updateAccount,
} from "./accounts.js";
import { listAuditEvents } from "./audit.js";
import { listCountyOrganizations, listCountyRoleEntries } from "./directory.js";
import { createOperation } from "./operations.js";
import {
  getOrganizationProfile,
  listOrganizationRoleEntries,
} from "./organization-profile.js";
import { getPersonProfile } from "./person-profile.js";
import {
  type Capability,
  createTestHumanIdentityAdapter,
  type HumanIdentityAdapter,
  hasCapability,
  resolvePrincipal,
  type TrustedPrincipal,
} from "./security.js";

export interface ApplicationServices {
  liveness(): { status: "ok" };
  readiness(): Promise<{ status: "ready" }>;
  health(): Promise<{ status: "ok" }>;
  resolvePrincipal(request: Request): Promise<TrustedPrincipal | null>;
  hasCapability(
    principal: TrustedPrincipal | null,
    capability: string,
  ): boolean;
  createAccount(
    principal: TrustedPrincipal,
    input: NewAccount,
    operationId?: string,
  ): ReturnType<typeof createAccount>;
  getAccount(
    principal: TrustedPrincipal,
    id: string,
  ): ReturnType<typeof getAccount>;
  updateAccount(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    changes: Parameters<typeof updateAccount>[4],
    operationId?: string,
  ): number;
  changeAccountRole(
    principal: TrustedPrincipal,
    id: string,
    expectedVersion: number,
    role: Parameters<typeof changeAccountRole>[4],
    operationId?: string,
  ): number;
  createHumanIdentity(
    principal: TrustedPrincipal,
    accountId: string,
    provider: string,
    subject: string,
    operationId?: string,
  ): string;
  issueAgentCredential(
    principal: TrustedPrincipal,
    accountId: string,
    expiresAt?: string | null,
    operationId?: string,
  ): ReturnType<typeof issueAgentCredential>;
  revokeIdentity(
    principal: TrustedPrincipal,
    identityId: string,
    expectedVersion: number,
    operationId?: string,
  ): number;
  createOperation(
    principal: TrustedPrincipal,
    kind: string,
    id?: string,
  ): string;
  listAuditEvents(
    principal: TrustedPrincipal,
    limit?: number,
  ): ReadonlyArray<Record<string, unknown>>;
  listCountyOrganizations(
    input: DirectoryPageRequest,
  ): ReturnType<typeof listCountyOrganizations>;
  listCountyRoleEntries(
    input: DirectoryPageRequest,
  ): ReturnType<typeof listCountyRoleEntries>;
  getOrganizationProfile(
    input: OrganizationProfilePageRequest,
  ): ReturnType<typeof getOrganizationProfile>;
  listOrganizationRoleEntries(
    input: OrganizationRolePageRequest,
  ): ReturnType<typeof listOrganizationRoleEntries>;
  getPersonProfile(
    input: PersonProfilePageRequest,
  ): ReturnType<typeof getPersonProfile>;
  /** Checkpoint operations. Each call checks its own checkpoint capability. */
  checkpoints(): CheckpointService;
}

export interface ServiceDependencies {
  readonly storage?: StorageProbe;
  readonly database?: WebsiteDatabase;
  readonly humanIdentityAdapter?: HumanIdentityAdapter;
  readonly now?: () => Date;
  /** Local checkpoint implementation. Absent unless the host injects one. */
  readonly checkpoints?: CheckpointService;
}

export function createServices(
  dependencies: ServiceDependencies = {},
): ApplicationServices {
  const database = dependencies.database;
  const requireDatabase = () => {
    if (!database) {
      throw new StorageUnavailableError();
    }
    return database;
  };
  const clock = dependencies.now ?? (() => new Date());
  const readiness = async () => {
    if (database) {
      database.prepare("SELECT 1").get();
    } else if (dependencies.storage) {
      await dependencies.storage.check();
    } else {
      throw new StorageUnavailableError();
    }
    return { status: "ready" as const };
  };

  const services = {
    liveness() {
      return { status: "ok" };
    },
    readiness,
    async health() {
      await readiness();
      return { status: "ok" };
    },
    resolvePrincipal(request) {
      return resolvePrincipal(
        requireDatabase(),
        request,
        dependencies.humanIdentityAdapter,
        clock(),
      );
    },
    hasCapability(principal, capability) {
      return hasCapability(requireDatabase(), principal, capability);
    },
    createAccount(principal, input, operationId) {
      return createAccount(requireDatabase(), principal, input, operationId);
    },
    getAccount(principal, id) {
      return getAccount(requireDatabase(), principal, id);
    },
    updateAccount(principal, id, expectedVersion, changes, operationId) {
      return updateAccount(
        requireDatabase(),
        principal,
        id,
        expectedVersion,
        changes,
        operationId,
      );
    },
    changeAccountRole(principal, id, expectedVersion, role, operationId) {
      return changeAccountRole(
        requireDatabase(),
        principal,
        id,
        expectedVersion,
        role,
        operationId,
      );
    },
    createHumanIdentity(principal, accountId, provider, subject, operationId) {
      return createHumanIdentity(
        requireDatabase(),
        principal,
        accountId,
        provider,
        subject,
        operationId,
      );
    },
    issueAgentCredential(principal, accountId, expiresAt, operationId) {
      return issueAgentCredential(
        requireDatabase(),
        principal,
        accountId,
        expiresAt,
        operationId,
        clock(),
      );
    },
    revokeIdentity(principal, identityId, expectedVersion, operationId) {
      return revokeIdentity(
        requireDatabase(),
        principal,
        identityId,
        expectedVersion,
        clock(),
        operationId,
      );
    },
    createOperation(principal, kind, id) {
      return createOperation(requireDatabase(), principal, kind, id);
    },
    listAuditEvents(principal, limit) {
      return listAuditEvents(requireDatabase(), principal, limit);
    },
    listCountyOrganizations(input) {
      return listCountyOrganizations(requireDatabase(), input);
    },
    listCountyRoleEntries(input) {
      return listCountyRoleEntries(requireDatabase(), input);
    },
    getOrganizationProfile(input) {
      return getOrganizationProfile(requireDatabase(), input);
    },
    listOrganizationRoleEntries(input) {
      return listOrganizationRoleEntries(requireDatabase(), input);
    },
    getPersonProfile(input) {
      return getPersonProfile(requireDatabase(), input);
    },
    checkpoints() {
      if (!dependencies.checkpoints) {
        throw new StorageUnavailableError();
      }
      return dependencies.checkpoints;
    },
  } as ApplicationServices;

  for (const key of Object.keys(services)) {
    Object.defineProperty(services, key, {
      value: services[key as keyof ApplicationServices],
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  return services;
}

export type { Capability, HumanIdentityAdapter, TrustedPrincipal };
export { createTestHumanIdentityAdapter };
