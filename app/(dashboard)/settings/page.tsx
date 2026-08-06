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
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  resolveAccent,
  type AccentApplication,
} from "@/components/ui/color-picker-logic";

export default function SettingsPage() {
  const [loading, setLoading] = useState(false);
  const [userName, setUserName] = useState("");
  // Matches the column default in lib/db/schema/settings.ts, so the picker shows
  // the truthful "Default" rather than a black swatch while settings load.
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT);
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const { theme, setTheme } = useTheme();
  const [saved, setSaved] = useState(false);
  const [mounted, setMounted] = useState(false);
  /** Failure from `updateSettings`; null when there is nothing to report. */
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    loadSettings();
  }, []);

  const loadSettings = async () => {
    const settings = await getSettings();
    setUserName(settings.userName);
    setAccentColor(settings.accentColor);
    setQuickCommands(settings.quickCommands || []);
    // Don't override the current theme - it's already set by next-themes
  };

  /**
   * `updateSettings` reports failure by RETURNING `{ error }`. Every call site
   * here used to discard that, so a rejected save looked exactly like a
   * successful one — including the "Saved!" confirmation.
   */
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
      quickCommands: commands,
    });
  };

  /**
   * `ColorPicker` only ever emits a canonical `#rrggbb` or a preset sentinel,
   * so `resolveAccent` should never fail here. It is still checked: a value can
   * also arrive from the database, and an accent that cannot be rendered must
   * be reported rather than quietly doing nothing.
   */
  const handleAccentColorChange = async (color: string) => {
    const application = resolveAccent(color);
    if (application === null) {
      setError(`"${color}" is not a usable colour. Pick a preset or enter a hex such as #0ea5e9.`);
      return;
    }

    setAccentColor(color);
    applyAccentColorImmediately(application);

    // Auto-save accent color
    await save({
      userName,
      accentColor: color,
      theme: (theme as "light" | "dark" | "system") || "system",
      quickCommands,
    });
  };

  /**
   * The only DOM-touching part of the accent pipeline. Every decision — which
   * properties, which HSL, which foreground — is made by `resolveAccent` in
   * components/ui/color-picker-logic.ts, where it can be unit tested.
   */
  const applyAccentColorImmediately = (application: AccentApplication) => {
    const root = document.documentElement;
    if (application.kind === "reset") {
      // "Default": drop the overrides and let app/globals.css win again.
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

      <div className="grid gap-6 md:grid-cols-2">
        {/* Profile Settings */}
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

        {/* Appearance Settings */}
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

      {/* Quick Commands */}
      <QuickCommandsManager
        quickCommands={quickCommands}
        onSave={handleQuickCommandsSave}
      />

      {/* Save Button */}
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div>
          <h3 className="font-semibold">Save Profile & Appearance</h3>
          <p className="text-sm text-muted-foreground">
            {saved ? "Your settings have been saved!" : "Click save to apply your profile and appearance changes"}
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
