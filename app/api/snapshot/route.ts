
import { recordNetWorthToday } from "@/app/actions/accounts";
import { todayKey } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import {
  authorizeSnapshotRequest,
  snapshotAuthConfigured,
  snapshotAuthDisabledResponse,
} from "@/lib/snapshot/api-auth";
import { withActiveVaultAuthorization } from "@/lib/vault/access";
import { VaultLockedError } from "@/lib/vault/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(): Promise<Response> {
  if (!snapshotAuthConfigured()) return snapshotAuthDisabledResponse();
  try {
    return await withActiveVaultAuthorization(
      async () => Response.json({ ok: true, today: todayKey() }, { headers: NO_STORE }),
      { touch: false },
    );
  } catch (error) {
    if (error instanceof VaultLockedError) {
      return Response.json({ ok: false, error: "vault_locked" }, { status: 423, headers: NO_STORE });
    }
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeSnapshotRequest(request);
  if (!auth.ok) return auth.response;

  try {
    const result = await withActiveVaultAuthorization(() => recordNetWorthToday());

    if ("error" in result) {
      return Response.json({ ok: false, error: result.error }, { status: 400, headers: NO_STORE });
    }

    const snap = result.data;

    return Response.json(
      {
        ok: true,
        date: snap.date,
        netWorthCents: snap.netWorthCents,
        prices: snap.prices,

        summary:
          `${snap.date}: net worth ${formatMoney(snap.netWorthCents)} ` +
          `(assets ${formatMoney(snap.totalAssetsCents)}, ` +
          `liabilities ${formatMoney(snap.totalLiabilitiesCents)}). ${snap.priceSummary}`,
      },
      { headers: NO_STORE },
    );
  } catch (cause) {
    if (cause instanceof VaultLockedError) {
      return Response.json({ ok: false, error: "vault_locked" }, { status: 423, headers: NO_STORE });
    }
    console.error("snapshot failed:", cause);
    return Response.json(
      { ok: false, error: (cause as Error).message || "snapshot failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}
