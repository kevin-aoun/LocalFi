import { VaultPanel } from "@/components/vault/vault-panel";
import { vaultStatusForRequest } from "@/lib/vault/access";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function VaultPage() {
  let status;
  try {
    status = await vaultStatusForRequest();
  } catch {
    return (
      <VaultPanel
        initialStatus="locked"
        initialError="The vault could not be inspected safely. Check the LocalFi server logs before retrying."
      />
    );
  }
  if (status === "unlocked") redirect("/");
  return <VaultPanel initialStatus={status} />;
}
