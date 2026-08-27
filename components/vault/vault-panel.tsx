"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { assessPassphrase } from "@/lib/vault/passphrase";
import type { VaultStatus } from "@/lib/vault/session";
import {
  canContinueAfterRecovery,
  initialVaultPanelMode,
  setupCredentialFromFragment,
  type VaultPanelMode,
} from "./vault-panel-logic";

type VaultPanelProps = {
  initialStatus: VaultStatus;
  initialError?: string;
};

async function postVault(endpoint: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/vault/${endpoint}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as {
    error?: string;
    detail?: string;
    recoverySecret?: string;
  };
  if (!response.ok) throw new Error(payload.detail || "That request could not be completed.");
  return payload;
}

export function VaultPanel({ initialStatus, initialError }: VaultPanelProps) {
  const router = useRouter();
  const [mode, setMode] = useState<VaultPanelMode>(initialVaultPanelMode(initialStatus));
  const [passphrase, setPassphrase] = useState("");
  const [bootstrapCredential, setBootstrapCredential] = useState("");
  const [bootstrapCredentialFromLink, setBootstrapCredentialFromLink] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [recoverySecret, setRecoverySecret] = useState("");
  const [nextRecoverySecret, setNextRecoverySecret] = useState<string | null>(null);
  const [acknowledgeWeak, setAcknowledgeWeak] = useState(false);
  const [savedRecovery, setSavedRecovery] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [submitting, setSubmitting] = useState(false);
  const assessment = useMemo(() => assessPassphrase(passphrase), [passphrase]);

  useEffect(() => {
    if (initialStatus !== "uninitialized") return;
    const credential = setupCredentialFromFragment(window.location.hash);
    if (!credential) return;
    setBootstrapCredential(credential);
    setBootstrapCredentialFromLink(true);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, [initialStatus]);

  const continueToLocalFi = () => {
    router.push("/");
    router.refresh();
  };

  const chooseMode = (next: VaultPanelMode) => {
    setMode(next);
    setPassphrase("");
    setBootstrapCredential("");
    setBootstrapCredentialFromLink(false);
    setConfirmation("");
    setRecoverySecret("");
    setAcknowledgeWeak(false);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "unlock") {
        await postVault("unlock", { passphrase });
        continueToLocalFi();
        return;
      }
      const payload = await postVault(mode, {
        ...(mode === "setup" ? { bootstrapCredential } : {}),
        ...(mode === "recovery" ? { recoverySecret } : {}),
        passphrase,
        confirmPassphrase: confirmation,
        acknowledgeWeak,
      });
      if (!payload.recoverySecret) throw new Error("Recovery material was not returned.");
      setNextRecoverySecret(payload.recoverySecret);
      setPassphrase("");
      setConfirmation("");
      setRecoverySecret("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That request could not be completed.");
    } finally {
      setSubmitting(false);
    }
  };

  if (nextRecoverySecret) {
    return (
      <VaultShell>
        <Card className="w-full max-w-lg">
          <CardHeader>
            <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
            <CardTitle>Save your recovery secret</CardTitle>
            <CardDescription>
              This is shown once. Store it somewhere separate from this computer. It can reset
              your passphrase if you forget it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <code className="block break-all rounded-md border bg-muted p-4 text-sm" aria-label="Recovery secret">
              {nextRecoverySecret}
            </code>
            <div className="flex items-start gap-3">
              <Checkbox
                id="saved-recovery"
                checked={savedRecovery}
                onCheckedChange={(checked) => setSavedRecovery(checked === true)}
              />
              <Label htmlFor="saved-recovery" className="leading-5">
                I saved this recovery secret somewhere safe and understand it will not be shown again.
              </Label>
            </div>
            <Button
              className="w-full"
              disabled={!canContinueAfterRecovery(savedRecovery)}
              onClick={continueToLocalFi}
            >
              Continue to LocalFi
            </Button>
          </CardContent>
        </Card>
      </VaultShell>
    );
  }

  return (
    <VaultShell>
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
            {mode === "unlock" ? <LockKeyhole className="h-5 w-5" /> : <KeyRound className="h-5 w-5" />}
          </div>
          <CardTitle>
            {mode === "setup" ? "Protect your LocalFi vault" : mode === "unlock" ? "Unlock LocalFi" : "Recover your vault"}
          </CardTitle>
          <CardDescription>
            {mode === "setup"
              ? "Create a passphrase to encrypt this database and its LocalFi-managed backups."
              : mode === "unlock"
                ? "Enter your passphrase. It stays on this server and is never stored."
                : "Use your saved recovery secret and choose a new passphrase."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            {mode === "setup" && bootstrapCredentialFromLink && (
              <p className="text-sm text-muted-foreground">First-run setup link verified.</p>
            )}
            {mode === "setup" && !bootstrapCredentialFromLink && (
              <div className="space-y-2">
                <Label htmlFor="vault-bootstrap-credential">One-time setup credential</Label>
                <Input
                  id="vault-bootstrap-credential"
                  type="password"
                  autoComplete="off"
                  value={bootstrapCredential}
                  onChange={(event) => setBootstrapCredential(event.target.value)}
                  required
                />
                <p className="text-sm text-muted-foreground">
                  Open the one-time link printed by Docker to fill this automatically.
                </p>
              </div>
            )}
            {mode === "recovery" && (
              <div className="space-y-2">
                <Label htmlFor="recovery-secret">Recovery secret</Label>
                <Input
                  id="recovery-secret"
                  type="password"
                  autoComplete="off"
                  value={recoverySecret}
                  onChange={(event) => setRecoverySecret(event.target.value)}
                  required
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="vault-passphrase">
                {mode === "recovery" ? "New passphrase" : "Passphrase"}
              </Label>
              <Input
                id="vault-passphrase"
                type="password"
                autoComplete={mode === "unlock" ? "current-password" : "new-password"}
                minLength={mode === "unlock" ? undefined : 12}
                maxLength={256}
                value={passphrase}
                onChange={(event) => {
                  setPassphrase(event.target.value);
                  setAcknowledgeWeak(false);
                }}
                required
              />
            </div>
            {mode !== "unlock" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="vault-passphrase-confirmation">Confirm passphrase</Label>
                  <Input
                    id="vault-passphrase-confirmation"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={256}
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    required
                  />
                </div>
                {assessment.warning && (
                  <div className="space-y-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                    <p>{assessment.warning}</p>
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id="acknowledge-weak"
                        checked={acknowledgeWeak}
                        onCheckedChange={(checked) => setAcknowledgeWeak(checked === true)}
                      />
                      <Label htmlFor="acknowledge-weak" className="leading-5">
                        I understand and want to use this passphrase anyway.
                      </Label>
                    </div>
                  </div>
                )}
              </>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" type="submit" disabled={submitting || Boolean(initialError)}>
              {submitting ? "Working…" : mode === "setup" ? "Create encrypted vault" : mode === "unlock" ? "Unlock" : "Reset passphrase"}
            </Button>
          </form>
          {!initialError && initialStatus !== "uninitialized" && (
            <div className="mt-5 text-center text-sm">
              {mode === "unlock" ? (
                <button className="text-muted-foreground underline underline-offset-4" onClick={() => chooseMode("recovery")}>
                  Use a recovery secret
                </button>
              ) : (
                <button className="text-muted-foreground underline underline-offset-4" onClick={() => chooseMode("unlock")}>
                  Back to passphrase unlock
                </button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </VaultShell>
  );
}

function VaultShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <div className="flex w-full flex-col items-center gap-6">
        <div className="text-center">
          <p className="text-2xl font-semibold">LocalFi</p>
          <p className="text-sm text-muted-foreground">Your finances stay encrypted on this machine.</p>
        </div>
        {children}
      </div>
    </main>
  );
}
