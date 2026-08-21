import { Sidebar } from "@/components/shared/sidebar";
import { requireVaultRequestAuthorization } from "@/lib/vault/access";
import { redirect } from "next/navigation";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await requireVaultRequestAuthorization();
  } catch {
    redirect("/vault");
  }
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main data-privacy-content className="flex-1 overflow-y-auto p-8">{children}</main>
    </div>
  );
}
