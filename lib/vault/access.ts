import { AsyncLocalStorage } from "node:async_hooks";
import { cookies } from "next/headers";

import {
  installDatabaseVaultAuthorizationProvider,
  plaintextFixtureAccessAllowed,
  type DatabaseVaultAuthorization,
} from "../db/client";
import { VaultLockedError } from "./errors";
import {
  VAULT_SESSION_COOKIE,
  vaultSessionManager,
  type VaultStatus,
} from "./session";

const contextGlobals = globalThis as typeof globalThis & {
  __localfiVaultAuthorizationContext?: AsyncLocalStorage<DatabaseVaultAuthorization>;
};
const authorizationContext =
  (contextGlobals.__localfiVaultAuthorizationContext ??=
    new AsyncLocalStorage<DatabaseVaultAuthorization>());

async function requestToken(): Promise<string | null> {
  try {
    return (await cookies()).get(VAULT_SESSION_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

function fixtureAccess(): boolean {
  try {
    return plaintextFixtureAccessAllowed();
  } catch {
    return false;
  }
}

export async function databaseVaultAuthorizationForRequest(): Promise<
  DatabaseVaultAuthorization | null
> {
  const contextual = authorizationContext.getStore();
  if (contextual) return contextual;
  return vaultSessionManager.authorizationForToken(await requestToken());
}

export async function vaultStatusForRequest(
  options: { touch?: boolean } = {},
): Promise<VaultStatus> {
  if (fixtureAccess()) return "unlocked";
  const status = await vaultSessionManager.status();
  if (status === "uninitialized") return status;
  return (await vaultSessionManager.authorizationForToken(
    await requestToken(),
    options.touch ?? false,
  ))
    ? "unlocked"
    : "locked";
}

export async function requireVaultRequestAuthorization(): Promise<void> {
  if (fixtureAccess()) return;
  if (!await databaseVaultAuthorizationForRequest()) throw new VaultLockedError();
}

export async function withActiveVaultAuthorization<T>(
  task: () => Promise<T>,
  options: { touch?: boolean } = {},
): Promise<T> {
  if (fixtureAccess()) return task();
  const authorization = await vaultSessionManager.authorizationForActiveVault(
    options.touch ?? true,
  );
  if (!authorization) throw new VaultLockedError();
  return authorizationContext.run(authorization, task);
}

export async function withVaultSessionToken<T>(
  token: string,
  task: () => Promise<T>,
): Promise<T> {
  const authorization = await vaultSessionManager.authorizationForToken(token);
  return withDatabaseVaultAuthorization(authorization, task);
}

export function withDatabaseVaultAuthorization<T>(
  authorization: DatabaseVaultAuthorization | null,
  task: () => Promise<T>,
): Promise<T> {
  if (!authorization) throw new VaultLockedError();
  return authorizationContext.run(authorization, task);
}

export function assertSameOriginJsonPost(request: Request): void {
  if (request.method !== "POST") throw new Error("method_not_allowed");
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new Error("invalid_content_type");
  const origin = request.headers.get("origin");
  let originUrl: URL;
  try {
    originUrl = new URL(origin ?? "");
  } catch {
    throw new Error("invalid_origin");
  }
  const host = (request.headers.get("host") ?? new URL(request.url).host).trim().toLowerCase();
  if (
    !host ||
    /[\s/@]/.test(host) ||
    originUrl.host.toLowerCase() !== host ||
    !allowedVaultOrigin(originUrl.origin)
  ) throw new Error("invalid_origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") throw new Error("invalid_origin");
}

function allowedVaultOrigin(value: string): boolean {
  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    return false;
  }
  const explicit = process.env.LOCALFI_APP_ORIGIN?.trim();
  if (explicit) {
    try {
      if (candidate.origin === new URL(explicit).origin) return true;
    } catch {
      return false;
    }
  }
  const loopback = candidate.hostname === "localhost" ||
    candidate.hostname === "127.0.0.1" ||
    candidate.hostname === "[::1]";
  if (!loopback || (candidate.protocol !== "http:" && candidate.protocol !== "https:")) {
    return false;
  }
  const configuredPort = process.env.PORT?.trim() || "1313";
  const effectivePort = candidate.port || (candidate.protocol === "https:" ? "443" : "80");
  return effectivePort === configuredPort;
}

export class VaultFailureRateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  blocked(key: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.failures.get(key) ?? []).filter((time) => time > cutoff);
    if (recent.length === 0) this.failures.delete(key);
    else this.failures.set(key, recent);
    return recent.length >= this.limit;
  }

  fail(key: string): void {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.failures.get(key) ?? []).filter((time) => time > cutoff);
    recent.push(this.now());
    this.failures.set(key, recent);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}

export function rateLimitKey(request: Request, operation: string): string {
  void request;
  return operation;
}

export function vaultCookie(token: string, request: Request): string {
  const secure = secureRequest(request) ? "; Secure" : "";
  return `${VAULT_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

export function clearVaultCookie(request: Request): string {
  const secure = secureRequest(request) ? "; Secure" : "";
  return `${VAULT_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function secureRequest(request: Request): boolean {
  if (new URL(request.url).protocol === "https:") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).protocol === "https:";
  } catch {
    return false;
  }
}

export async function currentVaultToken(): Promise<string | null> {
  return requestToken();
}

const accessGlobals = globalThis as typeof globalThis & {
  __localfiVaultRequestProviderInstalled?: boolean;
};
if (!accessGlobals.__localfiVaultRequestProviderInstalled) {
  installDatabaseVaultAuthorizationProvider(databaseVaultAuthorizationForRequest);
  accessGlobals.__localfiVaultRequestProviderInstalled = true;
}
