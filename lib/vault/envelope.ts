import { createHash } from "node:crypto";

import {
  VaultAuthenticationError,
  VaultEnvelopeError,
  VaultVersionError,
} from "./errors";

const MAGIC = Buffer.from([0x4c, 0x46, 0x56, 0x41, 0x55, 0x4c, 0x54, 0x00]);
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");
const PREFIX_BYTES = MAGIC.length + 1 + 1 + 4;
const VERSION = 1;
const FLAGS = 0;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_CIPHERTEXT_BYTES = 1024 * 1024 * 1024;
const MIN_SQLITE_BYTES = 512;
const ALGORITHM = "xchacha20-poly1305-ietf";
const KDF_ALGORITHM = "argon2id13";
const WRAP_DOMAIN = "localfi-vault-dek-wrap-v1";

type SodiumModule = typeof import("libsodium-wrappers-sumo");
type Sodium = SodiumModule["default"];

type KdfHeader = {
  algorithm: typeof KDF_ALGORITHM;
  salt: string;
  opsLimit: number;
  memLimit: number;
};

type WrappedKeyHeader = {
  algorithm: typeof ALGORITHM;
  nonce: string;
  ciphertext: string;
};

type EnvelopeHeader = {
  format: "localfi-vault";
  version: typeof VERSION;
  kdf: KdfHeader;
  wrappedKeys: { passphrase: WrappedKeyHeader; recovery: WrappedKeyHeader };
  payload: {
    algorithm: typeof ALGORITHM;
    nonce: string;
    ciphertextBytes: number;
  };
};

type KeyState = {
  dataKey: Uint8Array;
  kdf: KdfHeader;
  wrappedKeys: EnvelopeHeader["wrappedKeys"];
  fingerprint: string;
  destroyed: boolean;
};

export class UnlockedVaultKey {
  private constructor() {}

  static create(): UnlockedVaultKey {
    return new UnlockedVaultKey();
  }

  get destroyed(): boolean {
    return keyStates.get(this)?.destroyed ?? true;
  }
}

type VaultKeyRuntimeState = {
  keyStates?: WeakMap<UnlockedVaultKey, KeyState>;
};
const keyRuntimeGlobals = globalThis as typeof globalThis & {
  __localfiVaultKeyRuntime?: VaultKeyRuntimeState;
};
const keyRuntime = (keyRuntimeGlobals.__localfiVaultKeyRuntime ??= {
  keyStates: new WeakMap<UnlockedVaultKey, KeyState>(),
});
const keyStates = (keyRuntime.keyStates ??= new WeakMap<UnlockedVaultKey, KeyState>());
let sodiumPromise: Promise<Sodium> | null = null;

export type VaultEnvelopeInfo = {
  encrypted: true;
  version: number;
  kdfAlgorithm: typeof KDF_ALGORITHM;
  opsLimit: number;
  memLimit: number;
  ciphertextBytes: number;
  plaintextBytes: number;
  recoveryWrapped: true;
};

export type UnlockedVaultGeneration = {
  plaintext: Uint8Array;
  key: UnlockedVaultKey;
};

async function sodiumRuntime(): Promise<Sodium> {
  sodiumPromise ??= import("libsodium-wrappers-sumo").then(async (module) => {
    await module.default.ready;
    return module.default;
  });
  return sodiumPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new VaultEnvelopeError(`${label} has an unsupported shape.`);
  }
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum
  ) {
    throw new VaultEnvelopeError(`${label} is outside the supported range.`);
  }
  return value;
}

function decodeBase64(value: unknown, expectedBytes: number, label: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new VaultEnvelopeError(`${label} is not canonical base64.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.byteLength !== expectedBytes) {
    throw new VaultEnvelopeError(`${label} has an invalid length or encoding.`);
  }
  return Uint8Array.from(decoded);
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function encodeRecoverySecret(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeRecoverySecret(value: string, expectedBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new VaultAuthenticationError();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== expectedBytes || bytes.toString("base64url") !== value) {
    throw new VaultAuthenticationError();
  }
  return Uint8Array.from(bytes);
}

function assertSqliteImage(bytes: Uint8Array): void {
  if (bytes.byteLength < MIN_SQLITE_BYTES) {
    throw new VaultEnvelopeError("Decrypted vault payload is too small to be a SQLite image.");
  }
  if (!Buffer.from(bytes.subarray(0, SQLITE_MAGIC.length)).equals(SQLITE_MAGIC)) {
    throw new VaultEnvelopeError("Decrypted vault payload does not have SQLite magic.");
  }
}

export function isLegacySqliteImage(bytes: Uint8Array): boolean {
  return bytes.byteLength >= SQLITE_MAGIC.length &&
    Buffer.from(bytes.subarray(0, SQLITE_MAGIC.length)).equals(SQLITE_MAGIC);
}

export function isVaultEnvelope(bytes: Uint8Array): boolean {
  return bytes.byteLength >= MAGIC.length &&
    Buffer.from(bytes.subarray(0, MAGIC.length)).equals(MAGIC);
}

function readWrappedKey(
  value: Record<string, unknown>,
  label: string,
  sodium: Sodium,
): { header: WrappedKeyHeader; nonce: Uint8Array; ciphertext: Uint8Array } {
  exactKeys(value, ["algorithm", "nonce", "ciphertext"], label);
  if (value.algorithm !== ALGORITHM) {
    throw new VaultEnvelopeError(`${label} algorithm is unsupported.`);
  }
  const header = value as WrappedKeyHeader;
  return {
    header,
    nonce: decodeBase64(
      value.nonce,
      sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
      `${label} nonce`,
    ),
    ciphertext: decodeBase64(
      value.ciphertext,
      sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES +
        sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES,
      label,
    ),
  };
}

function parseHeader(bytes: Uint8Array, sodium: Sodium): {
  header: EnvelopeHeader;
  headerBytes: Uint8Array;
  ciphertext: Uint8Array;
  salt: Uint8Array;
  passphraseWrap: ReturnType<typeof readWrappedKey>;
  recoveryWrap: ReturnType<typeof readWrappedKey>;
  payloadNonce: Uint8Array;
} {
  if (!isVaultEnvelope(bytes)) {
    throw new VaultEnvelopeError("File is not a LocalFi vault envelope.");
  }
  if (bytes.byteLength < PREFIX_BYTES) throw new VaultEnvelopeError("Vault envelope is truncated.");
  const version = bytes[MAGIC.length];
  if (version !== VERSION) throw new VaultVersionError(version ?? -1);
  if (bytes[MAGIC.length + 1] !== FLAGS) {
    throw new VaultEnvelopeError("Vault envelope flags are unsupported.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(MAGIC.length + 2, false);
  if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) {
    throw new VaultEnvelopeError("Vault envelope header length is invalid.");
  }
  const ciphertextOffset = PREFIX_BYTES + headerLength;
  if (ciphertextOffset > bytes.byteLength) throw new VaultEnvelopeError("Vault header is truncated.");
  const headerBytes = bytes.slice(PREFIX_BYTES, ciphertextOffset);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes));
  } catch (error) {
    throw new VaultEnvelopeError("Vault envelope header is not valid UTF-8 JSON.", { cause: error });
  }
  if (!isRecord(parsed)) throw new VaultEnvelopeError("Vault envelope header is not an object.");
  exactKeys(parsed, ["format", "version", "kdf", "wrappedKeys", "payload"], "Vault header");
  if (parsed.format !== "localfi-vault" || parsed.version !== VERSION) {
    throw new VaultEnvelopeError("Vault envelope header identity is invalid.");
  }
  if (!isRecord(parsed.kdf) || !isRecord(parsed.wrappedKeys) || !isRecord(parsed.payload)) {
    throw new VaultEnvelopeError("Vault envelope cryptographic metadata is invalid.");
  }
  exactKeys(parsed.kdf, ["algorithm", "salt", "opsLimit", "memLimit"], "Vault KDF");
  exactKeys(parsed.wrappedKeys, ["passphrase", "recovery"], "Wrapped keys");
  exactKeys(parsed.payload, ["algorithm", "nonce", "ciphertextBytes"], "Vault payload");
  if (!isRecord(parsed.wrappedKeys.passphrase) || !isRecord(parsed.wrappedKeys.recovery)) {
    throw new VaultEnvelopeError("Vault wrapped-key metadata is invalid.");
  }
  if (parsed.kdf.algorithm !== KDF_ALGORITHM) {
    throw new VaultEnvelopeError("Vault KDF algorithm is unsupported.");
  }
  if (parsed.payload.algorithm !== ALGORITHM) {
    throw new VaultEnvelopeError("Vault payload algorithm is unsupported.");
  }
  const opsLimit = positiveInteger(parsed.kdf.opsLimit, "Argon2id opsLimit");
  const memLimit = positiveInteger(parsed.kdf.memLimit, "Argon2id memLimit");
  if (
    opsLimit !== sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE ||
    memLimit !== sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
  ) {
    throw new VaultEnvelopeError("Vault v1 Argon2id parameters do not match its supported policy.");
  }
  const ciphertextBytes = positiveInteger(
    parsed.payload.ciphertextBytes,
    "Payload ciphertext length",
    MAX_CIPHERTEXT_BYTES,
  );
  const ciphertext = bytes.slice(ciphertextOffset);
  if (ciphertext.byteLength !== ciphertextBytes) {
    throw new VaultEnvelopeError("Vault payload length does not match its authenticated header.");
  }
  if (ciphertextBytes <= sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES) {
    throw new VaultEnvelopeError("Vault payload ciphertext is too short.");
  }
  const kdf: KdfHeader = {
    algorithm: KDF_ALGORITHM,
    salt: String(parsed.kdf.salt),
    opsLimit,
    memLimit,
  };
  const passphraseWrap = readWrappedKey(parsed.wrappedKeys.passphrase, "Passphrase wrap", sodium);
  const recoveryWrap = readWrappedKey(parsed.wrappedKeys.recovery, "Recovery wrap", sodium);
  const header: EnvelopeHeader = {
    format: "localfi-vault",
    version: VERSION,
    kdf,
    wrappedKeys: { passphrase: passphraseWrap.header, recovery: recoveryWrap.header },
    payload: {
      algorithm: ALGORITHM,
      nonce: String(parsed.payload.nonce),
      ciphertextBytes,
    },
  };
  return {
    header,
    headerBytes,
    ciphertext,
    salt: decodeBase64(parsed.kdf.salt, sodium.crypto_pwhash_SALTBYTES, "Argon2id salt"),
    passphraseWrap,
    recoveryWrap,
    payloadNonce: decodeBase64(
      parsed.payload.nonce,
      sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
      "Payload nonce",
    ),
  };
}

function wrapAssociatedData(
  role: "passphrase" | "recovery",
  kdf: KdfHeader,
  wrappedKey: Omit<WrappedKeyHeader, "ciphertext">,
) {
  return new TextEncoder().encode(JSON.stringify({
    domain: WRAP_DOMAIN,
    version: VERSION,
    role,
    kdf,
    wrappedKey,
  }));
}

function keyFingerprint(kdf: KdfHeader, wrappedKeys: EnvelopeHeader["wrappedKeys"]): string {
  return createHash("sha256").update(JSON.stringify({ kdf, wrappedKeys })).digest("hex");
}

function keyState(key: UnlockedVaultKey): KeyState {
  const state = keyStates.get(key);
  if (!state || state.destroyed) throw new VaultAuthenticationError();
  return state;
}

function makeKey(state: Omit<KeyState, "destroyed">): UnlockedVaultKey {
  const key = UnlockedVaultKey.create();
  keyStates.set(key, { ...state, destroyed: false });
  return key;
}

function buildEnvelope(header: EnvelopeHeader, ciphertext: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.byteLength > MAX_HEADER_BYTES) {
    throw new VaultEnvelopeError("Vault envelope header is too large.");
  }
  const output = new Uint8Array(PREFIX_BYTES + headerBytes.byteLength + ciphertext.byteLength);
  output.set(MAGIC, 0);
  output[MAGIC.length] = VERSION;
  output[MAGIC.length + 1] = FLAGS;
  new DataView(output.buffer).setUint32(MAGIC.length + 2, headerBytes.byteLength, false);
  output.set(headerBytes, PREFIX_BYTES);
  output.set(ciphertext, PREFIX_BYTES + headerBytes.byteLength);
  return output;
}

function createWrappedKey(
  sodium: Sodium,
  role: "passphrase" | "recovery",
  dataKey: Uint8Array,
  wrappingKey: Uint8Array,
  kdf: KdfHeader,
): WrappedKeyHeader {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const base = { algorithm: ALGORITHM, nonce: encodeBase64(nonce) } as const;
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    dataKey,
    wrapAssociatedData(role, kdf, base),
    null,
    nonce,
    wrappingKey,
  );
  return { ...base, ciphertext: encodeBase64(ciphertext) };
}

async function wrapDataKey(dataKey: Uint8Array, passphrase: string): Promise<{
  key: UnlockedVaultKey;
  recoverySecret: string;
}> {
  if (passphrase.length === 0) throw new VaultAuthenticationError();
  const sodium = await sodiumRuntime();
  const recoveryKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const kdf: KdfHeader = {
    algorithm: KDF_ALGORITHM,
    salt: encodeBase64(salt),
    opsLimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    memLimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
  };
  const kek = sodium.crypto_pwhash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    passphrase,
    salt,
    kdf.opsLimit,
    kdf.memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    const wrappedKeys = {
      passphrase: createWrappedKey(sodium, "passphrase", dataKey, kek, kdf),
      recovery: createWrappedKey(sodium, "recovery", dataKey, recoveryKey, kdf),
    };
    return {
      key: makeKey({
        dataKey: Uint8Array.from(dataKey),
        kdf,
        wrappedKeys,
        fingerprint: keyFingerprint(kdf, wrappedKeys),
      }),
      recoverySecret: encodeRecoverySecret(recoveryKey),
    };
  } catch (error) {
    throw error;
  } finally {
    sodium.memzero(kek);
    sodium.memzero(recoveryKey);
  }
}

async function createKeyMaterial(passphrase: string): Promise<{
  key: UnlockedVaultKey;
  recoverySecret: string;
}> {
  const sodium = await sodiumRuntime();
  const dataKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  try {
    return await wrapDataKey(dataKey, passphrase);
  } finally {
    sodium.memzero(dataKey);
  }
}

export async function createVaultEnvelope(
  sqliteImage: Uint8Array,
  passphrase: string,
): Promise<{ envelope: Uint8Array; key: UnlockedVaultKey; recoverySecret: string }> {
  assertSqliteImage(sqliteImage);
  const material = await createKeyMaterial(passphrase);
  try {
    return { envelope: await encryptVaultGeneration(sqliteImage, material.key), ...material };
  } catch (error) {
    destroyVaultKey(material.key);
    throw error;
  }
}

export async function encryptVaultGeneration(
  sqliteImage: Uint8Array,
  key: UnlockedVaultKey,
): Promise<Uint8Array> {
  assertSqliteImage(sqliteImage);
  const sodium = await sodiumRuntime();
  const state = keyState(key);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const header: EnvelopeHeader = {
    format: "localfi-vault",
    version: VERSION,
    kdf: state.kdf,
    wrappedKeys: state.wrappedKeys,
    payload: {
      algorithm: ALGORITHM,
      nonce: encodeBase64(nonce),
      ciphertextBytes: sqliteImage.byteLength + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES,
    },
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sqliteImage,
    headerBytes,
    null,
    nonce,
    state.dataKey,
  );
  return buildEnvelope(header, ciphertext);
}

function decryptWrappedDataKey(
  sodium: Sodium,
  parsed: ReturnType<typeof parseHeader>,
  role: "passphrase" | "recovery",
  wrappingKey: Uint8Array,
): Uint8Array {
  const wrapped = role === "passphrase" ? parsed.passphraseWrap : parsed.recoveryWrap;
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      wrapped.ciphertext,
      wrapAssociatedData(role, parsed.header.kdf, {
        algorithm: wrapped.header.algorithm,
        nonce: wrapped.header.nonce,
      }),
      wrapped.nonce,
      wrappingKey,
    );
  } catch (error) {
    throw new VaultAuthenticationError({ cause: error });
  }
}

async function unlockedGeneration(
  envelope: Uint8Array,
  dataKey: Uint8Array,
  parsed: ReturnType<typeof parseHeader>,
): Promise<UnlockedVaultGeneration> {
  const key = makeKey({
    dataKey,
    kdf: parsed.header.kdf,
    wrappedKeys: parsed.header.wrappedKeys,
    fingerprint: keyFingerprint(parsed.header.kdf, parsed.header.wrappedKeys),
  });
  try {
    return { plaintext: await decryptVaultGeneration(envelope, key), key };
  } catch (error) {
    destroyVaultKey(key);
    throw error;
  }
}

export async function unlockVaultEnvelope(
  envelope: Uint8Array,
  passphrase: string,
): Promise<UnlockedVaultGeneration> {
  const sodium = await sodiumRuntime();
  const parsed = parseHeader(envelope, sodium);
  const kek = sodium.crypto_pwhash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    passphrase,
    parsed.salt,
    parsed.header.kdf.opsLimit,
    parsed.header.kdf.memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  try {
    return await unlockedGeneration(
      envelope,
      decryptWrappedDataKey(sodium, parsed, "passphrase", kek),
      parsed,
    );
  } finally {
    sodium.memzero(kek);
  }
}

export async function unlockVaultEnvelopeWithRecovery(
  envelope: Uint8Array,
  recoverySecret: string,
): Promise<UnlockedVaultGeneration> {
  const sodium = await sodiumRuntime();
  const parsed = parseHeader(envelope, sodium);
  const recoveryKey = decodeRecoverySecret(
    recoverySecret,
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
  );
  try {
    return await unlockedGeneration(
      envelope,
      decryptWrappedDataKey(sodium, parsed, "recovery", recoveryKey),
      parsed,
    );
  } finally {
    sodium.memzero(recoveryKey);
  }
}

export async function decryptVaultGeneration(
  envelope: Uint8Array,
  key: UnlockedVaultKey,
): Promise<Uint8Array> {
  const sodium = await sodiumRuntime();
  const state = keyState(key);
  const parsed = parseHeader(envelope, sodium);
  if (keyFingerprint(parsed.header.kdf, parsed.header.wrappedKeys) !== state.fingerprint) {
    throw new VaultAuthenticationError();
  }
  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      parsed.ciphertext,
      parsed.headerBytes,
      parsed.payloadNonce,
      state.dataKey,
    );
  } catch (error) {
    throw new VaultAuthenticationError({ cause: error });
  }
  try {
    assertSqliteImage(plaintext);
    return plaintext;
  } catch (error) {
    plaintext.fill(0);
    throw error;
  }
}

export async function inspectVaultEnvelope(envelope: Uint8Array): Promise<VaultEnvelopeInfo> {
  const sodium = await sodiumRuntime();
  const parsed = parseHeader(envelope, sodium);
  return {
    encrypted: true,
    version: parsed.header.version,
    kdfAlgorithm: parsed.header.kdf.algorithm,
    opsLimit: parsed.header.kdf.opsLimit,
    memLimit: parsed.header.kdf.memLimit,
    ciphertextBytes: parsed.ciphertext.byteLength,
    plaintextBytes: parsed.ciphertext.byteLength -
      sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES,
    recoveryWrapped: true,
  };
}

export async function rewrapVaultEnvelope(
  envelope: Uint8Array,
  currentPassphrase: string,
  nextPassphrase: string,
): Promise<{ envelope: Uint8Array; key: UnlockedVaultKey; recoverySecret: string }> {
  const unlocked = await unlockVaultEnvelope(envelope, currentPassphrase);
  try {
    const material = await wrapDataKey(keyState(unlocked.key).dataKey, nextPassphrase);
    try {
      return {
        envelope: await encryptVaultGeneration(unlocked.plaintext, material.key),
        ...material,
      };
    } catch (error) {
      destroyVaultKey(material.key);
      throw error;
    }
  } finally {
    unlocked.plaintext.fill(0);
    destroyVaultKey(unlocked.key);
  }
}

export async function recoverAndRewrapVaultEnvelope(
  envelope: Uint8Array,
  recoverySecret: string,
  nextPassphrase: string,
): Promise<{ envelope: Uint8Array; key: UnlockedVaultKey; recoverySecret: string }> {
  const unlocked = await unlockVaultEnvelopeWithRecovery(envelope, recoverySecret);
  try {
    const material = await wrapDataKey(keyState(unlocked.key).dataKey, nextPassphrase);
    try {
      return {
        envelope: await encryptVaultGeneration(unlocked.plaintext, material.key),
        ...material,
      };
    } catch (error) {
      destroyVaultKey(material.key);
      throw error;
    }
  } finally {
    unlocked.plaintext.fill(0);
    destroyVaultKey(unlocked.key);
  }
}

export function destroyVaultKey(key: UnlockedVaultKey): void {
  const state = keyStates.get(key);
  if (!state || state.destroyed) return;
  state.dataKey.fill(0);
  state.destroyed = true;
}
