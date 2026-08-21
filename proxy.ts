import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { proxyVaultSessionIsUnlocked } from "@/lib/vault/proxy-session";
import { VAULT_SESSION_COOKIE } from "@/lib/vault/constants";

export async function proxy(request: NextRequest) {
  if (process.env.LOCALFI_VAULT_TEST_MODE === "plaintext") return NextResponse.next();
  const token = request.cookies.get(VAULT_SESSION_COOKIE)?.value;
  if (await proxyVaultSessionIsUnlocked(token)) return NextResponse.next();

  const vaultUrl = request.nextUrl.clone();
  vaultUrl.pathname = "/vault";
  vaultUrl.search = "";
  const response = NextResponse.redirect(vaultUrl);
  response.cookies.delete(VAULT_SESSION_COOKIE);
  return response;
}

export const config = {
  matcher: [
    "/",
    "/accounts/:path*",
    "/transactions/:path*",
    "/recurring/:path*",
    "/budgets/:path*",
    "/reports/:path*",
    "/travel/:path*",
    "/ledger/:path*",
    "/settings/:path*",
  ],
};
