import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { rateLimit } from "@/server/security/rate-limit";
import {
  manualSubmitSchema,
  ManualPaymentError,
  submitManualPaymentDetails,
} from "@/server/billing/manual-payments";

export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimit(`manual_payment_submit:${session.user.id}`, 10, 15 * 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many payment submission attempts. Please wait a few minutes and try again." },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = manualSubmitSchema.safeParse(body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return NextResponse.json(
      { error: firstIssue?.message || "Invalid payment details." },
      { status: 422 }
    );
  }

  try {
    const res = await submitManualPaymentDetails({
      userId: session.user.id,
      paymentId: parsed.data.paymentId,
      method: parsed.data.method,
      transactionId: parsed.data.transactionId,
      senderNumber: parsed.data.senderNumber,
      note: parsed.data.note || undefined,
    });

    return NextResponse.json({
      success: true,
      data: {
        paymentId: res.payment.id,
        invoiceNumber: res.payment.invoice_number,
        status: "waiting_review",
        method: res.details.method,
        transactionId: res.details.transaction_id,
        senderNumber: res.details.sender_number,
        bdtAmount: res.details.bdt_amount,
      },
    });
  } catch (err: any) {
    if (err instanceof ManualPaymentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err?.message || "Failed to submit payment details." },
      { status: 500 }
    );
  }
}
