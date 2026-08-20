
import { recordNetWorthToday } from "@/app/actions/accounts";
import { todayKey } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import {
  agentAuthConfigured,
  agentAuthDisabledResponse,
  authorizeAgentRequest,
} from "@/lib/agent/api-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(): Promise<Response> {
  if (!agentAuthConfigured()) return agentAuthDisabledResponse();
  return Response.json({ ok: true, today: todayKey() }, { headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  const auth = authorizeAgentRequest(request);
  if (!auth.ok) return auth.response;

  try {
    const result = await recordNetWorthToday();

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
    console.error("snapshot failed:", cause);
    return Response.json(
      { ok: false, error: (cause as Error).message || "snapshot failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}
