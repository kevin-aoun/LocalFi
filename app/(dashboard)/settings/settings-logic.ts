export function idleTimeoutSecurityWarning(minutes: number): string | null {
  if (minutes <= 30) return null;
  return "A long timeout leaves unlocked financial data available for longer on an unattended device.";
}
