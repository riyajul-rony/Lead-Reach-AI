import { db } from "@/server/db";
import { logger } from "@/server/logger";

export class WorkspaceSendingPausedError extends Error {
  status = 423;
  code = "WORKSPACE_SENDING_PAUSED" as const;
  reason: string;

  constructor(reason?: string | null) {
    const clean =
      reason?.trim() ||
      "Sending for this workspace is temporarily paused by an administrator.";
    super(`Workspace sending paused: ${clean}`);
    this.name = "WorkspaceSendingPausedError";
    this.reason = clean;
  }
}

export async function isUserWorkspaceSendingPaused(userId: string): Promise<{
  paused: boolean;
  workspaceId?: string;
  reason?: string | null;
  pausedAt?: Date | string | null;
}> {
  if (!userId || !db.workspaces?.findFirst) {
    return { paused: false };
  }

  const pausedWs = await db.workspaces.findFirst({
    where: { user_id: userId, sending_status: "paused_by_admin" },
    select: { id: true, pause_reason: true, paused_at: true },
  });

  if (!pausedWs) {
    return { paused: false };
  }

  return {
    paused: true,
    workspaceId: pausedWs.id,
    reason: pausedWs.pause_reason ?? null,
    pausedAt: pausedWs.paused_at ?? null,
  };
}

export async function getPausedUserIdsSet(): Promise<Set<string>> {
  if (!db.workspaces?.findMany) return new Set();
  const paused = await db.workspaces.findMany({
    where: { sending_status: "paused_by_admin" },
    select: { user_id: true },
  });
  return new Set((paused || []).map((w: any) => w.user_id).filter(Boolean));
}

export async function assertUserWorkspaceSendingActive(userId: string): Promise<void> {
  const status = await isUserWorkspaceSendingPaused(userId);
  if (status.paused) {
    throw new WorkspaceSendingPausedError(status.reason);
  }
}

export async function pauseWorkspaceSending(params: {
  adminId: string;
  workspaceId: string;
  reason: string;
}) {
  const cleanReason = params.reason.trim();
  if (!cleanReason) {
    throw new Error("A pause reason is required.");
  }

  const ws = await db.workspaces.findUnique({ where: { id: params.workspaceId } });
  if (!ws) {
    throw new Error("Workspace not found");
  }

  const now = new Date();
  const updated = await db.workspaces.update({
    where: { id: ws.id },
    data: {
      sending_status: "paused_by_admin",
      pause_reason: cleanReason,
      paused_at: now,
      paused_by: params.adminId,
    },
  });

  if (db.admin_actions?.create) {
    await db.admin_actions.create({
      data: {
        admin_id: params.adminId,
        action: "workspace_sending_pause",
        reason: cleanReason,
        target_user_id: ws.user_id,
        workspace_id: ws.id,
        metadata: {
          previousStatus: ws.sending_status || "active",
          newStatus: "paused_by_admin",
          pausedAt: now.toISOString(),
        },
      },
    });
  }

  logger.warn(
    { adminId: params.adminId, workspaceId: ws.id, userId: ws.user_id, reason: cleanReason },
    "Admin paused workspace sending"
  );

  return updated;
}

export async function resumeWorkspaceSending(params: {
  adminId: string;
  workspaceId: string;
  reason?: string;
}) {
  const ws = await db.workspaces.findUnique({ where: { id: params.workspaceId } });
  if (!ws) {
    throw new Error("Workspace not found");
  }

  const cleanReason = params.reason?.trim() || "Workspace sending resumed by administrator";

  const updated = await db.workspaces.update({
    where: { id: ws.id },
    data: {
      sending_status: "active",
      pause_reason: null,
      paused_at: null,
      paused_by: null,
    },
  });

  if (db.admin_actions?.create) {
    await db.admin_actions.create({
      data: {
        admin_id: params.adminId,
        action: "workspace_sending_resume",
        reason: cleanReason,
        target_user_id: ws.user_id,
        workspace_id: ws.id,
        metadata: {
          previousStatus: ws.sending_status || "paused_by_admin",
          newStatus: "active",
          previousReason: ws.pause_reason || null,
        },
      },
    });
  }

  logger.info(
    { adminId: params.adminId, workspaceId: ws.id, userId: ws.user_id, reason: cleanReason },
    "Admin resumed workspace sending"
  );

  return updated;
}
