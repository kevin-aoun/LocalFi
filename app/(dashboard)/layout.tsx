import { Sidebar } from "@/components/shared/sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main data-privacy-content className="flex-1 overflow-y-auto p-8">{children}</main>
    </div>
  );
}
