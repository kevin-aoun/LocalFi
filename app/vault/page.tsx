import { VaultPanel } from "@/components/vault/vault-panel";
import { vaultStatusForRequest } from "@/lib/vault/access";
import { VaultPermissionError } from "@/lib/vault/errors";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function VaultPage() {
  let status;
  try {
    status = await vaultStatusForRequest();
  } catch (error) {
    return (
      <VaultPanel
        initialStatus="locked"
        initialError={error instanceof VaultPermissionError
          ? "The vault file is not restricted to your user. Make the database file owner-only (mode 0600, folder 0700) and owned by the LocalFi user, then reload."
          : "The vault could not be inspected safely. Check the LocalFi server logs before retrying."}
      />
    );
  }
  if (status === "unlocked") redirect("/");
  return <VaultPanel initialStatus={status} />;
}
