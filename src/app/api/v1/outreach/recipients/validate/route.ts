import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { getSessionUser } from "@/server/auth/session";
import { db, scoped } from "@/server/db";
import { validateAndNormalizeRecipients, ColumnMapping } from "@/server/email/recipient-importer";
import { z } from "zod";

const LEAD_VALIDATE_SELECT = {
  id: true,
  email: true,
  company_name: true,
  phone: true,
  phone_raw: true,
  website: true,
  city: true,
  country: true,
  timezone: true,
  extra: true,
} satisfies Prisma.leadsSelect;

const validateRequestSchema = z.object({
  source: z.enum(["leads", "sheet", "csv"]),
  searchId: z.string().optional(),
  onlyWithEmail: z.boolean().optional().default(true),
  onlyEnriched: z.boolean().optional().default(false),
  rawRows: z.array(z.record(z.string(), z.any())).optional(),
  mapping: z
    .object({
      email: z.string(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      full_name: z.string().optional(),
      company: z.string().optional(),
      website: z.string().optional(),
      job_title: z.string().optional(),
      phone: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = validateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid validation payload" },
      { status: 400 }
    );
  }

  const { source, searchId, onlyWithEmail, onlyEnriched, rawRows, mapping } = parsed.data;

  // Case 1: Saved Lead Searches
  if (source === "leads") {
    if (!searchId) {
      return NextResponse.json({ error: "searchId is required for leads source" }, { status: 400 });
    }

    const whereClause: Prisma.leadsWhereInput = scoped(session.user.id, { search_id: searchId });
    if (onlyWithEmail || onlyEnriched) {
      whereClause.email = { not: null };
    }

    const leads = await db.leads.findMany({
      where: whereClause,
      select: LEAD_VALIDATE_SELECT,
      take: 2000,
    });

    const filteredLeads = onlyWithEmail || onlyEnriched
      ? leads.filter((l: any) => typeof l.email === "string" && l.email.trim().length > 0)
      : leads;

    const leadRows = filteredLeads.map((l: any) => {
      const extra = l.extra && typeof l.extra === "object" ? l.extra : {};
      return {
        email: l.email || "",
        first_name: typeof extra.first_name === "string" ? extra.first_name : "",
        last_name: typeof extra.last_name === "string" ? extra.last_name : "",
        full_name:
          typeof extra.full_name === "string"
            ? extra.full_name
            : typeof extra.founder_name === "string"
              ? extra.founder_name
              : typeof extra.manager_name === "string"
                ? extra.manager_name
                : "",
        job_title: typeof extra.job_title === "string" ? extra.job_title : "",
        company: l.company_name || "",
        website: l.website || "",
        phone: l.phone || l.phone_raw || "",
        city: l.city || "",
        country: l.country || "",
        timezone: l.timezone || undefined,
        lead_id: l.id,
      };
    });

    const leadMapping: ColumnMapping = {
      email: "email",
      first_name: "first_name",
      last_name: "last_name",
      full_name: "full_name",
      company: "company",
      website: "website",
      job_title: "job_title",
      phone: "phone",
      timezone: "timezone",
    };

    const result = await validateAndNormalizeRecipients(session.user.id, leadRows, leadMapping);

    return NextResponse.json({ data: result });
  }

  // Case 2: CSV or Google Sheet
  if (!rawRows || !Array.isArray(rawRows)) {
    return NextResponse.json({ error: "rawRows array is required" }, { status: 400 });
  }

  if (!mapping || !mapping.email) {
    return NextResponse.json({ error: "A valid email column mapping is required" }, { status: 400 });
  }

  const result = await validateAndNormalizeRecipients(session.user.id, rawRows, mapping);
  return NextResponse.json({ data: result });
}
