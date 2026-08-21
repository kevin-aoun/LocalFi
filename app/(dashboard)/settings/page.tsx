"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getSettings, updateSettings, type QuickCommand } from "@/app/actions/settings";
import { Loader2 } from "lucide-react";
import { useTheme } from "next-themes";
import { QuickCommandsManager } from "@/components/settings/quick-commands-manager";
import { ColorPicker } from "@/components/ui/color-picker";
import { Switch } from "@/components/ui/switch";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  resolveAccent,
  type AccentApplication,
} from "@/components/ui/color-picker-logic";
import { idleTimeoutSecurityWarning } from "./settings-logic";

export default function SettingsPage() {
  const [loading, setLoading] = useState(false);
  const [userName, setUserName] = useState("");

  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT);
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const [showLedger, setShowLedger] = useState(false);
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(15);
  const [ledgerSaving, setLedgerSaving] = useState(false);
  const { theme, setTheme } = useTheme();
  const [saved, setSaved] = useState(false);
  const [mounted, setMounted] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const idleTimeoutWarning = idleTimeoutSecurityWarning(idleTimeoutMinutes);

  useEffect(() => {
    setMounted(true);
    loadSettings();
  }, []);

  const loadSettings = async () => {
    const settings = await getSettings();
    setUserName(settings.userName);
    setAccentColor(settings.accentColor);
    setShowLedger(settings.showLedger);
    setIdleTimeoutMinutes(settings.idleTimeoutMinutes);
    setQuickCommands(settings.quickCommands || []);

  };

  const save = async (next: Parameters<typeof updateSettings>[0]): Promise<boolean> => {
    const result = await updateSettings(next);
    if (result && "error" in result && result.error) {
      setError(result.error);
      return false;
    }
    setError(null);
    return true;
  };

  const handleSave = async () => {
    setLoading(true);
    setSaved(false);

    try {
      const ok = await save({
        userName,
        accentColor,
        theme: (theme as "light" | "dark" | "system") || "system",
        showLedger,
        idleTimeoutMinutes,
        quickCommands,
      });
      if (!ok) return;

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error("Failed to save settings:", err);
      setError(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setLoading(false);
    }
  };

  const handleQuickCommandsSave = async (commands: QuickCommand[]) => {
    setQuickCommands(commands);
    await save({
      userName,
      accentColor,
      theme: (theme as "light" | "dark" | "system") || "system",
      showLedger,
      idleTimeoutMinutes,
      quickCommands: commands,
    });
  };

  const handleAccentColorChange = async (color: string) => {
    const application = resolveAccent(color);
    if (application === null) {
      setError(`"${color}" is not a usable colour. Pick a preset or enter a hex such as #0ea5e9.`);
      return;
    }

    setAccentColor(color);
    applyAccentColorImmediately(application);

    await save({
      userName,
      accentColor: color,
      theme: (theme as "light" | "dark" | "system") || "system",
      showLedger,
      idleTimeoutMinutes,
      quickCommands,
    });
  };

  const handleLedgerVisibilityChange = async (next: boolean) => {
    const previous = showLedger;
    setShowLedger(next);
    setLedgerSaving(true);
    setSaved(false);

    try {
      const ok = await save({
        userName,
        accentColor,
        theme: (theme as "light" | "dark" | "system") || "system",
        showLedger: next,
        idleTimeoutMinutes,
        quickCommands,
      });
      if (!ok) {
        setShowLedger(previous);
        return;
      }

      const persisted = await getSettings();
      setShowLedger(persisted.showLedger);
      window.dispatchEvent(new Event("localfi:settings-updated"));
    } catch (err) {
      setShowLedger(previous);
      setError(err instanceof Error ? err.message : "Failed to update Ledger visibility.");
    } finally {
      setLedgerSaving(false);
    }
  };

  const applyAccentColorImmediately = (application: AccentApplication) => {
    const root = document.documentElement;
    if (application.kind === "reset") {

      for (const property of application.remove) root.style.removeProperty(property);
      return;
    }
    for (const [property, cssValue] of Object.entries(application.set)) {
      root.style.setProperty(property, cssValue);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your personal preferences and app configuration
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>{error}</span>
          <button type="button" className="underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Vault security</CardTitle>
          <CardDescription>
            Control how quickly an unattended unlocked session locks itself.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="idle-timeout">Lock after inactivity</Label>
          <div className="flex max-w-sm items-center gap-2">
            <Input
              id="idle-timeout"
              type="number"
              min={1}
              max={120}
              step={1}
              value={idleTimeoutMinutes}
              onChange={(event) => setIdleTimeoutMinutes(Number(event.target.value))}
              aria-describedby={
                idleTimeoutWarning
                  ? "idle-timeout-guidance idle-timeout-warning"
                  : "idle-timeout-guidance"
              }
            />
            <span className="shrink-0 text-sm text-muted-foreground">minutes</span>
          </div>
          <p id="idle-timeout-guidance" className="text-sm text-muted-foreground">
            Choose 1–120 minutes. Activity extends the session; saving a shorter timeout applies it
            to this session immediately.
          </p>
          {idleTimeoutWarning && (
            <p
              id="idle-timeout-warning"
              role="status"
              className="text-sm text-amber-700 dark:text-amber-400"
            >
              {idleTimeoutWarning}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-card to-muted/30">
        <CardHeader>
          <CardTitle>Developer tools</CardTitle>
          <CardDescription>
            Inspect LocalFi&apos;s append-only journal without changing financial records.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start justify-between gap-6 rounded-lg border bg-background/70 p-4">
            <div className="space-y-1">
              <Label htmlFor="show-ledger" className="text-base font-medium">
                Show Ledger explorer
              </Label>
              <p id="show-ledger-description" className="max-w-2xl text-sm text-muted-foreground">
                Adds Ledger to the sidebar and reveals the read-only event and hash-chain explorer.
                This controls visibility only—the journal keeps recording confirmed financial events
                whether this switch is on or off.
              </p>
              {ledgerSaving && (
                <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Saving preference…
                </p>
              )}
            </div>
            <Switch
              id="show-ledger"
              checked={showLedger}
              onCheckedChange={handleLedgerVisibilityChange}
              disabled={ledgerSaving}
              aria-describedby="show-ledger-description"
              aria-label="Show Ledger explorer"
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {}
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>
              Update your personal information
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="userName">Display Name</Label>
              <Input
                id="userName"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Your name"
              />
              <p className="text-xs text-muted-foreground">
                This name will be displayed in the sidebar and dashboard
              </p>
            </div>
          </CardContent>
        </Card>

        {}
        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>
              Customize the look and feel of your app
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="theme">Theme</Label>
              {!mounted ? (
                <div className="flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                  Loading...
                </div>
              ) : (
                <Select
                  value={theme}
                  onValueChange={(value) => setTheme(value)}
                >
                  <SelectTrigger id="theme">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="system">System</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">
                Choose your preferred color scheme
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="accentColor">Accent Color</Label>
              <ColorPicker
                id="accentColor"
                aria-label="Accent color"
                value={accentColor}
                onValueChange={handleAccentColorChange}
                presets={ACCENT_PRESETS}
                columns={4}
                customLabel="Custom color"
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Select your preferred accent color for charts, buttons, and UI elements. Any hex
                color works, not just the presets.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {}
      <QuickCommandsManager
        quickCommands={quickCommands}
        onSave={handleQuickCommandsSave}
      />

      {}
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div>
          <h3 className="font-semibold">Save profile, security &amp; appearance</h3>
          <p className="text-sm text-muted-foreground">
            {saved
              ? "Your settings have been saved!"
              : "Apply your profile, vault timeout, and appearance changes"}
          </p>
        </div>
        <Button onClick={handleSave} disabled={loading}>
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {saved ? "Saved!" : "Save Settings"}
        </Button>
      </div>
    </div>
  );
}
