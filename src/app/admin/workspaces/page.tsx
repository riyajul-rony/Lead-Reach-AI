import { requirePermission } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/permissions";
import { WorkspacesManager } from "./workspaces-manager";

export const metadata = {
  title: "Workspaces & Sending Controls — Lead Reach AI Admin",
  description: "Admin sending pause, resume controls, and audit log.",
};

export default async function AdminWorkspacesPage() {
  const admin = await requirePermission("users.read");
  const canManage = hasPermission(admin.role, "users.manage");
  return <WorkspacesManager canManage={canManage} />;
}
