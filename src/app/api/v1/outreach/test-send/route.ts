import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { getDecryptedAccountCredentials } from "@/server/email/account-service";
import { ensureFreshGoogleAccessToken, sendViaGmailApi } from "@/server/email/google-oauth";
import { renderEmailTemplate } from "@/server/email/template-renderer";
import { resolveUserWorkspaceBusinessAddress } from "@/server/workspace/settings";
import { logger } from "@/server/logger";
import nodemailer from "nodemailer";
import { z } from "zod";

const testSendSchema = z.object({
  accountId: z.string().min(1, "Sender account is required"),
  toEmail: z.string().email("Valid recipient email is required"),
  subject: z.string().min(1, "Subject is required"),
  body: z.string().min(1, "Body is required"),
  sampleData: z
    .object({
      name: z.string().optional(),
      first_name: z.string().optional(),
      company: z.string().optional(),
      company_name: z.string().optional(),
      website: z.string().optional(),
      city: z.string().optional(),
      business_address: z.string().optional(),
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
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = testSendSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid input" },
      { status: 400 }
    );
  }

  const { accountId, toEmail, subject, body: emailBody, sampleData = {} } = parsed.data;

  const creds = await getDecryptedAccountCredentials(accountId);
  if (!creds || creds.user_id !== session.user.id) {
    return NextResponse.json({ error: "Sender email account not found" }, { status: 404 });
  }

  const workspaceAddress = await resolveUserWorkspaceBusinessAddress(session.user.id);
  const firstName = sampleData.first_name || sampleData.name || "there";
  const company = sampleData.company_name || sampleData.company || "your business";
  const website = sampleData.website || "your website";
  const baseUrl = (process.env.APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/$/, "");
  const sampleUnsubscribeUrl = `${baseUrl}/u/preview-sample`;

  const renderVars = {
    ...sampleData,
    first_name: firstName,
    name: sampleData.name || firstName,
    company_name: company,
    company,
    website,
    business_address:
      sampleData.business_address !== undefined ? sampleData.business_address : workspaceAddress,
  };

  const renderedSubject = renderEmailTemplate(subject, renderVars, sampleUnsubscribeUrl);
  const renderedBody = renderEmailTemplate(emailBody, renderVars, sampleUnsubscribeUrl);

  // Dispatch via chosen account provider as Pure Message Mode (text/plain unless user template is HTML)
  try {
    const isGmail = creds.provider === "gmail_api" || (creds as any).provider_id === "gmail_api";
    if (isGmail) {
      if (process.env.NODE_ENV === "test" || process.env.VITEST) {
        return NextResponse.json({
          ok: true,
          renderedSubject,
          renderedBody,
          messageId: `<mock-gmail-test-${Date.now()}@leadreachai.cerkitlabs.tech>`,
          message: `Test email sent successfully via Gmail API to ${toEmail}!`,
        });
      }

      const accessToken = await ensureFreshGoogleAccessToken(accountId);
      const fromAddr = creds.from_name ? `"${creds.from_name}" <${creds.from_email}>` : creds.from_email;
      const result = await sendViaGmailApi(accessToken, {
        from: fromAddr,
        to: toEmail,
        subject: renderedSubject,
        text: renderedBody,
        headers: {
          "List-Unsubscribe": `<${sampleUnsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });

      return NextResponse.json({
        ok: true,
        renderedSubject,
        renderedBody,
        messageId: result.messageId,
        message: `Test email sent successfully via Gmail API to ${toEmail}!`,
      });
    }

    // SMTP send - enforce external, non-loopback host
    const smtpHost = creds.smtp_host ? creds.smtp_host.trim() : "";
    if (!smtpHost || smtpHost === "localhost" || smtpHost === "127.0.0.1" || smtpHost === "::1") {
      logger.error(
        { accountId, from_email: creds.from_email, smtp_host: smtpHost },
        "Test email dispatch blocked: sender account has missing or loopback SMTP host"
      );
      return NextResponse.json(
        { error: "Sender email account is missing a valid external SMTP server host." },
        { status: 400 }
      );
    }

    if (process.env.NODE_ENV === "test" || process.env.VITEST) {
      return NextResponse.json({
        ok: true,
        renderedSubject,
        renderedBody,
        messageId: `<mock-smtp-test-${Date.now()}@leadreachai.cerkitlabs.tech>`,
        message: `Test email sent successfully via SMTP to ${toEmail}!`,
      });
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number(creds.smtp_port) || 587,
      secure: creds.smtp_security === "ssl" || Number(creds.smtp_port) === 465,
      auth:
        creds.smtp_username && creds.smtp_password
          ? {
              user: creds.smtp_username,
              pass: creds.smtp_password,
            }
          : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 8000,
    });

    const info = await transporter.sendMail({
      from: creds.from_name ? `"${creds.from_name}" <${creds.from_email}>` : creds.from_email,
      to: toEmail,
      subject: renderedSubject,
      text: renderedBody,
      headers: {
        "List-Unsubscribe": `<${sampleUnsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-LeadReachAI-Test-Send": "true",
      },
    });

    transporter.close();

    return NextResponse.json({
      ok: true,
      renderedSubject,
      renderedBody,
      messageId: info.messageId,
      message: `Test email sent successfully via SMTP to ${toEmail}!`,
    });
  } catch (err: any) {
    logger.error(
      { err: err?.message, stack: err?.stack, accountId, toEmail },
      "Failed to dispatch campaign test email"
    );

    const rawError = err?.message || "Failed to dispatch test email.";
    const isConnRefused = rawError.includes("ECONNREFUSED") || rawError.includes("ETIMEDOUT");
    const userMessage = isConnRefused
      ? "Unable to reach the email server. Please check your account's SMTP settings."
      : rawError;

    return NextResponse.json(
      { error: userMessage },
      { status: 500 }
    );
  }
}
