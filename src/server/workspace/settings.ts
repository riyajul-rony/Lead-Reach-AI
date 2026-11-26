import { db } from "@/server/db";

export async function getOrCreateDefaultWorkspace(userId: string) {
  let ws = await db.workspaces.findFirst({
    where: { user_id: userId, is_default: true },
    select: { id: true, user_id: true, name: true, is_default: true, business_address: true },
  });

  if (!ws) {
    ws = await db.workspaces.findFirst({
      where: { user_id: userId },
      select: { id: true, user_id: true, name: true, is_default: true, business_address: true },
    });
  }

  if (!ws) {
    ws = await db.workspaces.create({
      data: {
        user_id: userId,
        name: "Default",
        is_default: true,
        business_address: null,
      },
      select: { id: true, user_id: true, name: true, is_default: true, business_address: true },
    });
  }

  return ws;
}

/**
 * Resolves the optional business address for {{business_address}} template rendering.
 * Never auto-injected unless the template contains {{business_address}}.
 */
export async function resolveUserWorkspaceBusinessAddress(userId: string): Promise<string> {
  try {
    const ws = await db.workspaces.findFirst({
      where: { user_id: userId, is_default: true },
      select: { business_address: true },
    });
    const fromWorkspace = typeof ws?.business_address === "string" ? ws.business_address.trim() : "";
    if (fromWorkspace) return fromWorkspace;

    const anyWs = !ws
      ? await db.workspaces.findFirst({
          where: { user_id: userId },
          select: { business_address: true },
        })
      : null;
    const fromAnyWs = typeof anyWs?.business_address === "string" ? anyWs.business_address.trim() : "";
    if (fromAnyWs) return fromAnyWs;

    const user = await db.users.findUnique({
      where: { id: userId },
      select: { sender_address: true },
    });
    return typeof user?.sender_address === "string" ? user.sender_address.trim() : "";
  } catch {
    return "";
  }
}

export async function updateWorkspaceBusinessAddress(
  userId: string,
  businessAddress: string | null
) {
  const normalized = businessAddress?.trim() || null;
  const ws = await getOrCreateDefaultWorkspace(userId);
  const updated = await db.workspaces.update({
    where: { id: ws.id },
    data: { business_address: normalized },
    select: { id: true, name: true, is_default: true, business_address: true },
  });

  await db.users
    .update({
      where: { id: userId },
      data: { sender_address: normalized },
    })
    .catch(() => null);

  return updated;
}
