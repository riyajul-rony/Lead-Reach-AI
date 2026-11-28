import { NextResponse } from "next/server";
import { TrialExpiredError, isTrialExpiredError } from "@/server/billing/trial";

export function toTrialExpiredPayload(err?: unknown) {
  const typed = isTrialExpiredError(err) ? err : new TrialExpiredError();
  return {
    error: typed.message,
    code: "trial_expired" as const,
    upgradeUrl: "/app/settings/billing" as const,
    endsAt: typed.endsAt ?? null,
  };
}

export function trialExpiredJsonResponse(err?: unknown) {
  return NextResponse.json(toTrialExpiredPayload(err), { status: 402 });
}
