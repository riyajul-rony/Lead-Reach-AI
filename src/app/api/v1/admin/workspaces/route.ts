import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { hasPermission } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { logger } from "@/server/logger";

export async function GET(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasPermission(session.user.role, "users.read")) {
    return NextResponse.json(
      { error: "Forbidden: users.read admin permission required" },
      { status: 403 }
    );
  }

  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const limit = Math.min(50, Math.max(1, Number(sp.get("limit")) || 20));
  const skip = (page - 1) * limit;
  const q = sp.get("q")?.trim() || "";
  const statusFilter = sp.get("status")?.trim() || "";

  const where: any = {};
  if (statusFilter === "active" || statusFilter === "paused_by_admin") {
    where.sending_status = statusFilter;
  }
  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { user: { email: { contains: q, mode: "insensitive" } } },
      { user: { name: { contains: q, mode: "insensitive" } } },
    ];
  }

  try {
    const [items, total, recentActions] = await Promise.all([
      db.workspaces.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "desc" },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              plan: true,
              status: true,
            },
          },
        },
      }),
      db.workspaces.count({ where }),
      db.admin_actions?.findMany
        ? db.admin_actions.findMany({
            take: 25,
            orderBy: { created_at: "desc" },
            select: {
              id: true,
              admin_id: true,
              action: true,
              reason: true,
              target_user_id: true,
              workspace_id: true,
              account_id: true,
              metadata: true,
              created_at: true,
            },
          })
        : Promise.resolve([]),
    ]);

    return NextResponse.json({
      data: {
        items,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
        recentActions,
      },
    });
  } catch (err: any) {
    logger.error({ err: err?.message }, "Failed to load admin workspaces");
    return NextResponse.json(
      { error: "Failed to load workspaces" },
      { status: 500 }
    );
  }
}
