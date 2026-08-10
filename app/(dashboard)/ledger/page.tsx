import Link from "next/link";
import { BookOpenCheck, Settings } from "lucide-react";

import { getLedgerExplorerPage, verifyLedgerIntegrity } from "@/app/actions/ledger";
import { getSettings } from "@/app/actions/settings";
import { LedgerExplorer } from "@/components/ledger/ledger-explorer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function LedgerPage() {
  const preferences = await getSettings();

  if (!preferences.showLedger) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-2xl items-center">
        <Card className="w-full border-primary/20 bg-gradient-to-br from-card to-muted/30">
          <CardHeader className="text-center">
            <BookOpenCheck className="mx-auto mb-2 h-10 w-10 text-primary" aria-hidden="true" />
            <CardTitle>Ledger explorer is hidden</CardTitle>
            <CardDescription className="mx-auto max-w-lg">
              Your append-only journal is still active. The Settings preference only controls
              whether its read-only technical explorer appears in the app.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button asChild>
              <Link href="/settings">
                <Settings className="mr-2 h-4 w-4" aria-hidden="true" />
                Enable in Settings
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const [pageResult, verificationResult] = await Promise.all([
    getLedgerExplorerPage(),
    verifyLedgerIntegrity(),
  ]);
  const initialPage = "success" in pageResult ? pageResult.data : null;
  const initialVerification = "success" in verificationResult ? verificationResult.data : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Ledger</h1>
          <p className="max-w-3xl text-muted-foreground">
            A read-only view of the durable event and hash chain. Newest events appear first;
            sequence and predecessor hashes preserve the original journal order.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings">Explorer settings</Link>
        </Button>
      </div>
      <LedgerExplorer
        initialPage={initialPage}
        initialVerification={initialVerification}
        initialError={"error" in pageResult ? pageResult.error : null}
        initialVerificationError={
          "error" in verificationResult ? verificationResult.error : null
        }
      />
    </div>
  );
}
