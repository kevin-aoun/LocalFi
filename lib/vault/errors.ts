export type VaultErrorCode =
  | "authentication_failed"
  | "corrupt_envelope"
  | "legacy_migration_failed"
  | "locked"
  | "path_unsafe"
  | "permission_unsafe"
  | "uninitialized"
  | "unsupported_version";

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VaultError";
    this.code = code;
  }
}

export class VaultLockedError extends VaultError {
  constructor(message = "The LocalFi vault is locked.") {
    super("locked", message);
    this.name = "VaultLockedError";
  }
}

export class VaultUninitializedError extends VaultError {
  constructor(message = "The LocalFi vault has not been initialized.") {
    super("uninitialized", message);
    this.name = "VaultUninitializedError";
  }
}

export class VaultAuthenticationError extends VaultError {
  constructor(options?: ErrorOptions) {
    super(
      "authentication_failed",
      "The vault generation could not be authenticated.",
      options,
    );
    this.name = "VaultAuthenticationError";
  }
}

export class VaultEnvelopeError extends VaultError {
  constructor(message: string, options?: ErrorOptions) {
    super("corrupt_envelope", message, options);
    this.name = "VaultEnvelopeError";
  }
}

export class VaultVersionError extends VaultError {
  constructor(version: number) {
    super("unsupported_version", `Unsupported LocalFi vault envelope version: ${version}.`);
    this.name = "VaultVersionError";
  }
}

export class VaultPathError extends VaultError {
  constructor(message: string, options?: ErrorOptions) {
    super("path_unsafe", message, options);
    this.name = "VaultPathError";
  }
}

export class VaultPermissionError extends VaultError {
  constructor(message: string, options?: ErrorOptions) {
    super("permission_unsafe", message, options);
    this.name = "VaultPermissionError";
  }
}

export class VaultLegacyMigrationError extends VaultError {
  constructor(message: string, options?: ErrorOptions) {
    super("legacy_migration_failed", message, options);
    this.name = "VaultLegacyMigrationError";
  }
}
