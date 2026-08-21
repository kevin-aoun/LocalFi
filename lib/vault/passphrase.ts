export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 256;

const COMMON = new Set([
  "password",
  "password123",
  "letmein",
  "qwerty",
  "qwerty123",
  "123456789012",
  "correcthorsebatterystaple",
  "localfi",
  "localfipassword",
]);
const COMMON_FRAGMENTS = ["password", "localfi", "letmein", "qwerty", "123456"];
const OBVIOUS_RUNS = [
  "0123456789",
  "9876543210",
  "abcdefghijklmnopqrstuvwxyz",
  "zyxwvutsrqponmlkjihgfedcba",
  "qwertyuiop",
  "poiuytrewq",
];

export type PassphraseAssessment = {
  valid: boolean;
  warning: string | null;
  error: string | null;
};

export function assessPassphrase(value: unknown): PassphraseAssessment {
  if (typeof value !== "string") {
    return { valid: false, warning: null, error: "Enter a passphrase." };
  }
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    return {
      valid: false,
      warning: null,
      error: `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    };
  }
  if (value.length > MAX_PASSPHRASE_LENGTH) {
    return {
      valid: false,
      warning: null,
      error: `Use no more than ${MAX_PASSPHRASE_LENGTH} characters.`,
    };
  }

  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const unique = new Set(value.toLowerCase()).size;
  const repeated = /^(.)\1+$/.test(value) || Array.from(
    { length: Math.floor(value.length / 2) },
    (_, index) => index + 1,
  ).some((size) => value.length % size === 0 && value.slice(0, size).repeat(value.length / size) === value);
  const sequence = OBVIOUS_RUNS.some((run) =>
    normalized.length >= 4 && (run.includes(normalized) || normalized.includes(run.slice(0, 6)))
  );
  const commonTerm = COMMON.has(normalized) ||
    COMMON_FRAGMENTS.some((fragment) => normalized.includes(fragment));
  const shortSingleClass = value.length < 16 && (/^[a-z]+$/.test(value) || /^\d+$/.test(value));
  const weak = commonTerm || repeated || sequence || unique < 6 || shortSingleClass;

  return {
    valid: true,
    warning: weak
      ? "This passphrase looks simple or repetitive. You may continue only after acknowledging the risk."
      : null,
    error: null,
  };
}

export function validatePassphraseSubmission(
  passphrase: unknown,
  acknowledgedWeak: unknown,
): PassphraseAssessment {
  const assessment = assessPassphrase(passphrase);
  if (!assessment.valid || !assessment.warning) return assessment;
  if (acknowledgedWeak !== true) {
    return {
      ...assessment,
      valid: false,
      error: "Acknowledge the weak-passphrase warning to continue.",
    };
  }
  return assessment;
}

export function parseInactivityTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 120) {
    throw new Error("Inactivity timeout must be an integer from 1 to 120 minutes.");
  }
  return value;
}
