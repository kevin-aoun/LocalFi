import { DatabaseUpgradeError } from "../db/upgrade";
import { WriterLeaseError } from "../db/writer-lease";
import {
  VaultAuthenticationError,
  VaultLegacyMigrationError,
  VaultPathError,
  VaultPermissionError,
} from "./errors";

export function setupFailureDetail(error: unknown): string | undefined {
  if (error instanceof WriterLeaseError) {
    return "Another LocalFi process is using this database. Stop it and retry setup.";
  }
  if (error instanceof VaultPathError || error instanceof VaultPermissionError) {
    return "The database path or its permissions did not pass LocalFi's safety checks.";
  }
  if (error instanceof VaultAuthenticationError) {
    return "A managed backup was encrypted by an earlier setup attempt. Retry with the same passphrase.";
  }
  if (error instanceof DatabaseUpgradeError || error instanceof VaultLegacyMigrationError) {
    return "The live database could not be verified and upgraded safely. Its original data was not replaced.";
  }
  return undefined;
}
