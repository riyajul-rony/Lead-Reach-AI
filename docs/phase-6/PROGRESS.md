# Phase 6: Deliverability, Pure Message Mode, Adaptive Limits and Admin Controls — Progress Log

**Branch:** `feat/phase-6-deliverability` (branched from `main` at `09b7780` after Phase 5 merge)

---

## Task 0 — Baseline Gate & Codebase Map

**Status:** Completed

### Baseline Gate Results (on clean `main` / initial `feat/phase-6-deliverability`)
- `npm.cmd test`: **PASS** — 48 test files passed (48), 288 tests passed (288)
- `npx.cmd tsc --noEmit`: **PASS** — exit code 0
- `npm.cmd run lint`: **PASS** — 0 errors, 1235 warnings
- `npm.cmd run build`: **PASS** — Next.js 16.3.8 (Turbopack) production build completed
- `npm.cmd run build:worker`: **PASS** — `dist/worker.cjs` (730.9kb) + `dist/worker.cjs.map` (1.3mb)

### Codebase Discovery Map
- **Auto-appended footer, unsubscribe block & `"123 Innovation Way"` placeholder:**
  - `src/app/app/outreach/new/outreach-wizard.tsx`: default `physicalAddress` state `"123 Innovation Way, Suite 400, Wilmington, DE 19801"`
  - `src/server/email/sending-engine.ts`: `buildEmailMultipartBodies()` appends `\n\n---\n${opts.legalAddress}\nTo unsubscribe: ${opts.unsubscribeUrl}` to `text` and wraps all emails in `<!DOCTYPE html>...` with footer + `<a href="${opts.unsubscribeUrl}">Unsubscribe</a>` + fallback `"Lead Reach AI Verified Cold Outreach, Cerkit Labs"`
  - `src/server/email/sequence-service.ts`: fallback `"Lead Reach AI Verified Cold Outreach"` and calls `buildEmailMultipartBodies()`
  - `src/app/api/v1/outreach/test-send/route.ts`: prepends `[TEST PREVIEW] ` and appends `\n\n---\n[Test Preview sent from Lead Reach AI Outreach Wizard via ${creds.from_email}]`
  - `src/server/email/campaign-service.ts`: stores `sender_address_footer` in campaign `source_ref`
- **Tests referencing `buildEmailMultipartBodies`:**
  - `src/server/email/sending-engine.test.ts`
  - `src/server/email/spintax.test.ts`
  - `src/server/email/tracking-token.test.ts`
- **Compose, Preview, Render & Dispatch:**
  - `src/server/email/template-renderer.ts` (`resolveSpintax`, `renderEmailTemplate`, `extractTemplateVariables`)
  - `src/server/email/sending-engine.ts` (`dispatchEmailTransport`, `sendSingleRecipientEmail`, `dispatchRunningCampaigns`, `selectAvailableAccountForCampaign`)
  - `src/server/email/sequence-service.ts` (`sendSingleRecipientFollowup`, `dispatchDueFollowups`)
  - `src/server/email/google-oauth.ts` (`ensureFreshGoogleAccessToken`, `sendViaGmailApi`)
  - `src/app/api/v1/outreach/preview/route.ts`, `src/app/api/v1/outreach/test-send/route.ts`
- **Queues, Worker, Account Limits & Warm-up:**
  - `src/server/queues/index.ts` (`QUEUE_NAMES`, repeatable schedulers gated by `SCHEDULERS_ENABLED=true`: `planner`, `email-dispatch`, `reply-poll`, `maintenance`, `warmup`)
  - `src/server/worker/index.ts` (8 BullMQ workers)
  - `src/server/email/account-service.ts` (`getEffectiveAccountDailyLimit`, `accountHasWorkingReplyDetection`, `incrementWarmupDayForActiveAccounts`, CRUD)
  - `src/server/email/warmup-pool-service.ts` (`runSelfWarmupTick`, `getCombinedAccountSendCounts`)
  - `src/server/email/dns-checker.ts` (`checkDomainDnsHealth`)
- **Replies & Bounces:**
  - `src/server/worker/reply-poller.ts` (`isAutoReplyMessage`, `isBounceMessage`, `recordHumanReplyAndClassify` — Stop-on-Reply precedes `classifyReplyIntent`)
  - `src/server/ai/reply-classifier.ts`
- **Admin, Legal, Signup & GDPR:**
  - `src/server/auth/permissions.ts` (`STAFF_ROLES`), `src/server/auth/guards.ts` (`requireAdmin`, `requirePermission`, `assertPermission`), `src/app/admin/*`
  - `src/app/terms/page.tsx` (already exists), `src/app/sitemap.ts`, `src/app/page.tsx` footer, `src/app/(auth)/signup/page.tsx`, `src/server/auth/actions.ts` (`signupAction`)
  - `src/server/account/gdpr-service.ts` (`exportUserAccountData`, `deleteOwnAccount`)
- **Test Harness (`DATABASE_URL` unset):**
  - `src/test/mock-db.ts` and `src/test/local-store.ts` (any new Prisma models/fields must be supported in both and covered in GDPR export/delete)

---
