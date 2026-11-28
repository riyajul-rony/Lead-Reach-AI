"use client";

import { useActionState, useEffect, useRef } from "react";
import Link from "next/link";
import { Lock, CheckCircle2, Info } from "lucide-react";
import { changePasswordAction } from "@/server/auth/actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function PasswordForm({ hasPassword = true }: { hasPassword?: boolean }) {
  const [state, formAction, pending] = useActionState(changePasswordAction, undefined);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.message) {
      formRef.current?.reset();
    }
  }, [state]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="text-brand" size={18} /> Change Password
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4 pt-0">
        {!hasPassword ? (
          <div className="rounded-lg border border-border bg-bg-subtle p-4 text-xs text-text-muted space-y-2">
            <div className="flex items-center gap-2 font-semibold text-text">
              <Info size={15} className="text-brand shrink-0" />
              <span>Managed via Google Sign-In</span>
            </div>
            <p className="leading-relaxed">
              Your account was created with Google Sign-In and does not have a local password set. If you would like to add a password as well, you can request a password setup link via{" "}
              <Link href="/forgot-password" className="text-text font-medium underline hover:opacity-80">
                Forgot password
              </Link>
              .
            </p>
          </div>
        ) : (
          <>
            {state?.message && (
              <div
                role="status"
                className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-2"
              >
                <CheckCircle2 size={16} className="shrink-0" /> {state.message}
              </div>
            )}

            {state?.error && (
              <div
                role="alert"
                className="rounded-lg border border-red-500/30 bg-red-500/10 p-3.5 text-xs text-red-700 dark:text-red-400"
              >
                {state.error}
              </div>
            )}

            <form ref={formRef} action={formAction} className="space-y-4 max-w-md">
              <Input
                name="currentPassword"
                label="Current Password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••••••"
                required
              />
              <Input
                name="newPassword"
                label="New Password"
                type="password"
                autoComplete="new-password"
                placeholder="••••••••••••"
                minLength={8}
                required
                helperText="Minimum 8 characters."
              />
              <Button type="submit" size="sm" loading={pending} disabled={pending}>
                {pending ? "Updating Password..." : "Update Password"}
              </Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
