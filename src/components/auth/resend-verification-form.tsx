"use client";

import React, { useActionState } from "react";
import { resendVerificationAction } from "@/server/auth/actions";
import { Button, Input } from "@/components/ui";

export function ResendVerificationForm({
  email,
  allowEmailInput = false,
  buttonSize = "md",
  className = "",
}: {
  email?: string;
  allowEmailInput?: boolean;
  buttonSize?: "sm" | "md";
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(resendVerificationAction, undefined);

  return (
    <form action={formAction} className={`space-y-3 ${className}`}>
      {email ? (
        <input type="hidden" name="email" value={email} />
      ) : allowEmailInput ? (
        <Input
          name="email"
          type="email"
          label="Email Address"
          placeholder="you@company.com"
          required
        />
      ) : null}

      {state?.error ? (
        <div
          role="alert"
          className="rounded-[6px] border border-danger/30 bg-danger-bg p-2.5 text-xs text-danger font-medium"
        >
          {state.error}
        </div>
      ) : null}

      {state?.message ? (
        <div
          role="status"
          className="rounded-[6px] border border-success/30 bg-success-bg p-2.5 text-xs text-success font-medium"
        >
          {state.message}
        </div>
      ) : null}

      <Button
        type="submit"
        variant="secondary"
        size={buttonSize}
        loading={pending}
        disabled={pending}
        className="w-full text-xs"
      >
        {pending ? "Sending..." : "Resend Verification Link"}
      </Button>
    </form>
  );
}
