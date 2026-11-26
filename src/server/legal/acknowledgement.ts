import { db } from "@/server/db";
import { getOrCreateDefaultWorkspace } from "@/server/workspace/settings";

export const DEFAULT_LEGAL_TERMS_VERSION = "2026-11-v1";

export function getCurrentLegalTermsVersion(): string {
  return process.env.LEGAL_TERMS_VERSION?.trim() || DEFAULT_LEGAL_TERMS_VERSION;
}

export class LegalAcknowledgementRequiredError extends Error {
  readonly status = 422;
  readonly code = "LEGAL_ACKNOWLEDGEMENT_REQUIRED";
  readonly termsVersion: string;

  constructor(termsVersion: string, message?: string) {
    super(
      message ||
        "Please accept the legal outreach compliance acknowledgement before launching your first campaign in this workspace."
    );
    this.name = "LegalAcknowledgementRequiredError";
    this.termsVersion = termsVersion;
  }
}

export async function getWorkspaceLegalAcknowledgementStatus(
  userId: string,
  termsVersion: string = getCurrentLegalTermsVersion()
) {
  const workspace = await getOrCreateDefaultWorkspace(userId);
  const existing = await db.workspace_legal_acknowledgements.findFirst({
    where: {
      workspace_id: workspace.id,
      terms_version: termsVersion,
    },
    select: {
      id: true,
      workspace_id: true,
      terms_version: true,
      accepted_at: true,
    },
  });

  return {
    workspaceId: workspace.id as string,
    termsVersion,
    accepted: Boolean(existing),
    acceptedAt: existing?.accepted_at ? new Date(existing.accepted_at).toISOString() : null,
  };
}

export async function recordWorkspaceLegalAcknowledgement(
  userId: string,
  termsVersion: string = getCurrentLegalTermsVersion()
) {
  const workspace = await getOrCreateDefaultWorkspace(userId);
  const now = new Date();
  const saved = await db.workspace_legal_acknowledgements.upsert({
    where: {
      workspace_id_terms_version: {
        workspace_id: workspace.id,
        terms_version: termsVersion,
      },
    },
    create: {
      user_id: userId,
      workspace_id: workspace.id,
      terms_version: termsVersion,
      accepted_at: now,
    },
    update: {
      user_id: userId,
      accepted_at: now,
    },
  });

  return {
    workspaceId: workspace.id as string,
    termsVersion,
    accepted: true,
    acceptedAt: saved?.accepted_at ? new Date(saved.accepted_at).toISOString() : now.toISOString(),
  };
}

export async function assertWorkspaceLegalAcknowledgement(
  userId: string,
  termsVersion: string = getCurrentLegalTermsVersion()
) {
  const status = await getWorkspaceLegalAcknowledgementStatus(userId, termsVersion);
  if (!status.accepted) {
    throw new LegalAcknowledgementRequiredError(termsVersion);
  }
  return status;
}
