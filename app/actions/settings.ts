"use server";

import { readDb, withDb } from "@/lib/db/client";
import { settings, quickCommands } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { assertCents, type Cents } from "@/lib/money";
import { revalidate } from "@/lib/revalidate";

export type QuickCommand = {
  id: number;
  command: string;
  categoryName: string;

  amountCents: Cents;
  comment: string;
};

export type Settings = {
  userName: string;
  accentColor: string;
  theme: "light" | "dark" | "system";
  showLedger: boolean;
  quickCommands: QuickCommand[];
};

export async function getSettings(): Promise<Settings> {
  const { settingsRow, commands } = await readDb(async (db) => {
    const settingsRows = await db.select().from(settings).limit(1);
    return {
      settingsRow:
        settingsRows[0] ||
        {
          userName: "",
          accentColor: "default",
          theme: "system" as const,
          showLedger: false,
        },
      commands: await db.select().from(quickCommands),
    };
  });

  return {
    userName: settingsRow.userName,
    accentColor: settingsRow.accentColor,
    theme: settingsRow.theme,
    showLedger: settingsRow.showLedger,
    quickCommands: commands.map(cmd => ({
      id: cmd.id,
      command: cmd.command,
      categoryName: cmd.categoryName,
      amountCents: cmd.amountCents,
      comment: cmd.comment,
    })),
  };
}

export async function updateSettings(newSettings: Settings) {
  try {

    for (const cmd of newSettings.quickCommands) {
      assertCents(cmd.amountCents, `quick command "${cmd.command}" amount`);
    }

    await withDb(async (db) => {
      const existingSettings = await db.select().from(settings).limit(1);

      if (existingSettings.length > 0) {
        await db
          .update(settings)
          .set({
            userName: newSettings.userName,
            accentColor: newSettings.accentColor,
            theme: newSettings.theme,
            showLedger: newSettings.showLedger,
            updatedAt: new Date(),
          })
          .where(eq(settings.id, existingSettings[0].id));
      } else {
        await db.insert(settings).values({
          userName: newSettings.userName,
          accentColor: newSettings.accentColor,
          theme: newSettings.theme,
          showLedger: newSettings.showLedger,
        });
      }

      await db.delete(quickCommands);

      if (newSettings.quickCommands.length > 0) {

        await db.insert(quickCommands).values(
          newSettings.quickCommands.map((cmd) => ({
            command: cmd.command,
            categoryName: cmd.categoryName,
            amountCents: cmd.amountCents,
            comment: cmd.comment,
          })),
        );
      }
    });

    revalidate("/", "/settings", "/ledger");
    return { success: true };
  } catch (error) {
    console.error("Failed to update settings:", error);
    return {
      error:
        error instanceof Error
          ? `Failed to update settings: ${error.message}`
          : "Failed to update settings.",
    };
  }
}
