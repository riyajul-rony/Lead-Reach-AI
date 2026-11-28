import { Shield } from "lucide-react";
import { requireUser } from "@/server/auth/guards";
import { db } from "@/server/db";
import { PasswordForm } from "./password-form";
import { GdprControls } from "./gdpr-controls";
import { PageHeader } from "@/components/ui/page-header";
import { SettingsNav } from "@/components/settings/settings-nav";
import { Card, CardContent } from "@/components/ui/card";

export const metadata = {
  title: "Security Settings — Lead Reach AI",
  description: "Manage your password, encryption settings, GDPR data export, and account deletion.",
};

export default async function SecuritySettingsPage() {
  const user = await requireUser();

  const dbUser = await db.users.findUnique({
    where: { id: user.id },
    select: {
      email: true,
      password_hash: true,
    },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-16">
      <PageHeader
        title="Account Settings"
        description="Manage your password, encryption settings, GDPR data export, and account deletion."
      />

      <SettingsNav />

      <div className="space-y-6">
        {/* Encryption Status Card */}
        <Card>
          <CardContent className="p-5 sm:p-6 space-y-2">
            <div className="flex items-center gap-2 font-semibold text-accent-green text-sm">
              <Shield size={16} /> AES-256-GCM Encryption Active
            </div>
            <p className="text-xs text-muted leading-relaxed">
              All your connected API keys, OpenAI tokens, SMTP credentials, and IMAP passwords are encrypted using hardware-accelerated AES-256-GCM authenticated cipher before hitting disk storage.
            </p>
          </CardContent>
        </Card>

        {/* Change Password Form (Client Component) */}
        <PasswordForm hasPassword={Boolean(dbUser?.password_hash)} />

        {/* GDPR Export & Self-Service Account Deletion */}
        <GdprControls
          hasPassword={Boolean(dbUser?.password_hash)}
          userEmail={dbUser?.email ?? user.email}
        />
      </div>
    </div>
  );
}
