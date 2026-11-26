import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { getDecryptedAccountCredentials } from "@/server/email/account-service";
import { classifyReplyIntent } from "@/server/ai/reply-classifier";
import { handleIncomingWarmupEmail, isWarmupMessageHeaders } from "@/server/email/warmup-pool-service";

export interface PollResult {
  checked: number;
  repliesFound: number;
  bouncesFound: number;
  autoRepliesFound: number;
}

/**
 * Checks if incoming subject or headers indicate an automated Out-of-Office auto-responder.
 */
export function isAutoReplyMessage(subject = "", bodyText = ""): boolean {
  const cleanSubject = subject.toLowerCase().trim();
  const isSubjectAuto =
    cleanSubject.startsWith("automatic reply:") ||
    cleanSubject.startsWith("auto-reply:") ||
    cleanSubject.startsWith("out of office:") ||
    cleanSubject.startsWith("autoreply:") ||
    cleanSubject.includes("i am away from the office") ||
    cleanSubject.includes("out of the office until");

  const cleanBody = bodyText.toLowerCase();
  const isBodyAuto =
    cleanBody.includes("i am out of the office") ||
    cleanBody.includes("i am currently out of office") ||
    cleanBody.includes("this is an automated response");

  return isSubjectAuto || isBodyAuto;
}

/**
 * Checks if incoming sender or subject indicates a bounce / delivery failure.
 */
export function isBounceMessage(fromAddress = "", subject = ""): boolean {
  const cleanFrom = fromAddress.toLowerCase().trim();
  const cleanSubj = subject.toLowerCase().trim();

  return (
    cleanFrom.includes("mailer-daemon") ||
    cleanFrom.includes("postmaster") ||
    cleanFrom.includes("bounce") ||
    cleanSubj.includes("delivery status notification") ||
    cleanSubj.includes("undeliverable") ||
    cleanSubj.includes("mail delivery failed") ||
    cleanSubj.includes("returned mail")
  );
}

/**
 * Records stop-on-reply FIRST, then safely runs AI reply categorization.
 * Any AI error/timeout leaves reply_category as 'uncategorized' without affecting stop-on-reply
 * and NEVER auto-adds leads to global suppressions based on an AI guess.
 */
export async function recordHumanReplyAndClassify(input: {
  recipient: { id: string; user_id: string; campaign_id: string; status: string };
  accountId: string;
  messageId: string;
  inReplyTo?: string | null;
  subject: string;
  bodyText: string;
  sentAt?: Date | string;
}): Promise<{ recorded: boolean; category: string }> {
  if (input.recipient.status === "replied") {
    return { recorded: false, category: "uncategorized" };
  }

  // 1. CRITICAL: Execute Stop-on-Reply BEFORE any AI call
  await db.campaign_recipients.update({
    where: { id: input.recipient.id },
    data: {
      status: "replied",
      replied_at: new Date(),
      next_followup_at: null, // Permanently stops followup sequence
      reply_category: "uncategorized",
    },
  });

  const savedMessage = await db.email_messages.create({
    data: {
      user_id: input.recipient.user_id,
      recipient_id: input.recipient.id,
      email_account_id: input.accountId,
      direction: "in",
      kind: "reply",
      message_id: input.messageId,
      in_reply_to: input.inReplyTo || null,
      subject: input.subject,
      snippet: input.bodyText.slice(0, 150),
      status: "received",
      reply_category: "uncategorized",
      reply_category_source: "fallback",
      sent_at: input.sentAt ? new Date(input.sentAt) : new Date(),
    },
  });

  // 2. Non-blocking safe AI classification after stop-on-reply is persisted
  let finalCategory = "uncategorized";
  try {
    const classification = await classifyReplyIntent({
      userId: input.recipient.user_id,
      subject: input.subject,
      bodyText: input.bodyText,
    });
    finalCategory = classification.category;

    if (classification.category !== "uncategorized" || classification.source === "ai") {
      if (savedMessage?.id && db.email_messages?.update) {
        await db.email_messages.update({
          where: { id: savedMessage.id },
          data: {
            reply_category: classification.category as any,
            reply_category_confidence: classification.confidence,
            reply_category_source: classification.source,
          },
        });
      }
      await db.campaign_recipients.update({
        where: { id: input.recipient.id },
        data: { reply_category: classification.category as any },
      });
    }
  } catch (aiErr: any) {
    logger.warn(
      { recipientId: input.recipient.id, err: aiErr?.message },
      "Post-reply AI categorization failed; reply kept as uncategorized"
    );
  }

  return { recorded: true, category: finalCategory };
}

/**
 * Polls active IMAP inboxes for replies, bounces, and auto-responders.
 * Immediately stops followup sequence when a genuine reply is detected.
 * Optimized for VPS with short timeouts and fast socket cleanup.
 */
export async function pollInboxesForReplies(): Promise<PollResult> {
  const activeAccounts = await db.email_accounts.findMany({
    where: { status: "active" },
  });

  let checkedCount = 0;
  let repliesFound = 0;
  let bouncesFound = 0;
  let autoRepliesFound = 0;

  for (const account of activeAccounts) {
    if (!account.imap_host) continue;

    checkedCount++;
    let client: ImapFlow | null = null;

    try {
      const creds = await getDecryptedAccountCredentials(account.id);
      if (!creds || !creds.imap_host) continue;

      client = new ImapFlow({
        host: creds.imap_host,
        port: creds.imap_port || 993,
        secure: creds.imap_security === "ssl" || creds.imap_port === 993,
        auth: {
          user: creds.imap_username || account.from_email,
          pass: creds.imap_password,
        },
        logger: false,
      });

      // Strict timeout (8 seconds)
      const connectPromise = client.connect();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("IMAP Connection timeout")), 8000)
      );
      await Promise.race([connectPromise, timeoutPromise]);

      const lock = await client.getMailboxLock("INBOX");

      // Monitored sender accounts: this inbox + any inboxes forwarding replies here
      let monitoredAccountIds: string[] = [account.id];
      try {
        const forwarding = await db.email_accounts.findMany({
          where: {
            user_id: account.user_id,
            OR: [
              { reply_inbox_account_id: account.id },
              { reply_to: account.from_email },
            ],
          },
          select: { id: true },
        });
        if (forwarding && forwarding.length > 0) {
          monitoredAccountIds = [account.id, ...forwarding.map((f: any) => f.id)];
        }
      } catch {}

      try {
        // Fetch last 25 messages
        const status = await client.status("INBOX", { messages: true });
        const totalMsgs = status && typeof status === "object" && status.messages ? status.messages : 0;
        if (totalMsgs > 0) {
          const fetchRange = `${Math.max(1, totalMsgs - 24)}:*`;

          for await (const message of client.fetch(fetchRange, { envelope: true, source: true, uid: true })) {
            try {
              const envelope = message.envelope;
              if (!envelope || !message.source) continue;

              const fromAddress = envelope.from?.[0]?.address?.toLowerCase().trim() || "";
              const inReplyTo = (envelope.inReplyTo || "").trim();
              const subject = envelope.subject || "";

              if (!fromAddress) continue;

              // 0. Intercept Self Warm-up Pool messages BEFORE bounce or campaign lead matching
              const sourcePeek = Buffer.isBuffer(message.source)
                ? message.source.subarray(0, 8192).toString("utf8").toLowerCase()
                : String(message.source).slice(0, 8192).toLowerCase();
              if (sourcePeek.includes("x-leadreachai-warmup")) {
                const warmupParsed = await (simpleParser as any)(message.source);
                if (isWarmupMessageHeaders(warmupParsed.headers)) {
                  const rawRefs = warmupParsed.headers?.get("references");
                  const refIds: string[] = [];
                  if (typeof rawRefs === "string") {
                    const m = rawRefs.match(/<[^>]+>/g);
                    if (m) refIds.push(...m);
                  } else if (Array.isArray(rawRefs)) {
                    for (const item of rawRefs) {
                      const m = typeof item === "string" ? item.match(/<[^>]+>/g) : null;
                      if (m) refIds.push(...m);
                    }
                  }

                  await handleIncomingWarmupEmail({
                    receivingAccount: account,
                    fromAddress,
                    messageId: envelope.messageId || "",
                    inReplyTo,
                    references: refIds,
                    subject,
                    headers: warmupParsed.headers,
                  });

                  try {
                    if (message.uid) {
                      await client.messageFlagsAdd(String(message.uid), ["\\Seen"], { uid: true });
                    }
                  } catch {}
                  continue;
                }
              }

              // 1. Check for Bounce (mailer-daemon / postmaster)
              if (isBounceMessage(fromAddress, subject)) {
                const parsed = await (simpleParser as any)(message.source);
                const bounceBody = parsed.text || "";
                const emailMatch = bounceBody.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                if (emailMatch) {
                  const bouncedEmail = emailMatch[0].toLowerCase();
                  const rec = await db.campaign_recipients.findFirst({
                    where: {
                      email: bouncedEmail,
                      assigned_account_id: { in: monitoredAccountIds },
                    },
                    orderBy: { last_sent_at: "desc" },
                  });
                  if (rec && rec.status !== "bounced") {
                    await db.campaign_recipients.update({
                      where: { id: rec.id },
                      data: {
                        status: "bounced",
                        error: "Delivery failed / bounced",
                        next_followup_at: null,
                      },
                    });

                    // Permanently suppress recipient
                    const existingSup = await db.suppressions.findFirst({
                      where: { user_id: rec.user_id, email: bouncedEmail },
                    });
                    if (!existingSup) {
                      await db.suppressions.create({
                        data: {
                          user_id: rec.user_id,
                          email: bouncedEmail,
                          reason: "bounced",
                          source_campaign_id: rec.campaign_id,
                        },
                      });
                    }
                    bouncesFound++;
                  }
                }
                continue;
              }

              // 2. Parse body to inspect for Auto-Reply / Out of Office
              const parsed = await (simpleParser as any)(message.source);
              const bodyText = parsed.text || "";

              // 3. Match against campaign recipients:
              // Priority 1: exact Message-ID (In-Reply-To / References) across this user's campaigns
              let matchingRecipient: any = null;
              const refCandidates: string[] = [];
              if (inReplyTo) {
                refCandidates.push(inReplyTo);
              }
              const headerRefs = parsed.headers?.get("references");
              if (typeof headerRefs === "string") {
                const matches = headerRefs.match(/<[^>]+>/g);
                if (matches) {
                  refCandidates.push(...matches);
                }
              } else if (Array.isArray(headerRefs)) {
                for (const r of headerRefs) {
                  if (typeof r === "string") {
                    const matches = r.match(/<[^>]+>/g);
                    if (matches) refCandidates.push(...matches);
                  }
                }
              }

              if (refCandidates.length > 0) {
                matchingRecipient = await db.campaign_recipients.findFirst({
                  where: {
                    thread_message_id: { in: refCandidates },
                    user_id: account.user_id,
                  },
                });
              }

              // Priority 2: fromAddress belonging to monitored senders
              if (!matchingRecipient) {
                matchingRecipient = await db.campaign_recipients.findFirst({
                  where: {
                    email: fromAddress,
                    assigned_account_id: { in: monitoredAccountIds },
                  },
                  orderBy: { last_sent_at: "desc" },
                });
              }

              // Priority 3: subject match on recent dispatches
              if (!matchingRecipient && subject) {
                const cleanSubj = subject.replace(/^(re|fwd|fw):\s*/i, "").trim().toLowerCase();
                if (cleanSubj.length > 3) {
                  const candidates = await db.campaign_recipients.findMany({
                    where: {
                      email: fromAddress,
                      user_id: account.user_id,
                    },
                    orderBy: { last_sent_at: "desc" },
                    take: 5,
                  });
                  matchingRecipient =
                    candidates.find((c: any) => {
                      const gen = (c.generated_subject || "").toLowerCase().trim();
                      return gen && (gen.includes(cleanSubj) || cleanSubj.includes(gen));
                    }) || candidates[0];
                }
              }

              if (matchingRecipient) {
                // Check if this is an automated Out of Office reply
                if (isAutoReplyMessage(subject, bodyText)) {
                  await db.email_messages.create({
                    data: {
                      user_id: matchingRecipient.user_id,
                      recipient_id: matchingRecipient.id,
                      email_account_id: account.id,
                      direction: "in",
                      kind: "auto_reply",
                      message_id: envelope.messageId || `autoreply_${Date.now()}`,
                      in_reply_to: inReplyTo || null,
                      subject,
                      snippet: bodyText.slice(0, 150),
                      status: "received",
                      reply_category: "out_of_office",
                      reply_category_source: "rule",
                      sent_at: envelope.date || new Date(),
                    },
                  });
                  autoRepliesFound++;
                  logger.info(
                    { email: fromAddress, campaignId: matchingRecipient.campaign_id },
                    "Detected out-of-office auto-reply, followups maintained"
                  );
                  continue;
                }

                // 4. Genuine human reply: STOP-ON-REPLY GUARANTEE + safe AI classification
                if (matchingRecipient.status !== "replied") {
                  const handled = await recordHumanReplyAndClassify({
                    recipient: matchingRecipient,
                    accountId: account.id,
                    messageId: envelope.messageId || `reply_${Date.now()}`,
                    inReplyTo,
                    subject,
                    bodyText,
                    sentAt: envelope.date || new Date(),
                  });

                  if (handled.recorded) {
                    repliesFound++;
                    logger.info(
                      {
                        email: fromAddress,
                        campaignId: matchingRecipient.campaign_id,
                        accountId: account.id,
                        category: handled.category,
                      },
                      "Detected human reply from recipient, stop-on-reply activated"
                    );
                  }
                }
              }
            } catch (msgErr) {
              // Ignore single message parse error
            }
          }
        }
      } finally {
        lock.release();
      }

      await db.email_accounts.update({
        where: { id: account.id },
        data: { last_polled_at: new Date() },
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ accountId: account.id, error: errorMsg }, "Error polling IMAP inbox");

      if (
        errorMsg.includes("EAUTH") ||
        errorMsg.includes("AUTHENTICATIONFAILED") ||
        errorMsg.includes("Invalid credentials") ||
        errorMsg.includes("BadCredentials")
      ) {
        await db.email_accounts.update({
          where: { id: account.id },
          data: {
            status: "needs_attention",
            last_error: `IMAP authorization failed: ${errorMsg}`,
          },
        });
      }
    } finally {
      if (client) {
        try {
          await client.logout();
        } catch {}
      }
    }
  }

  return { checked: checkedCount, repliesFound, bouncesFound, autoRepliesFound };
}
