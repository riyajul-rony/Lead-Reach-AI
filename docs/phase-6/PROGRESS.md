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

## Task 1 — Pure Message Mode (no body injection)

**Status:** Completed

### Outcome & Changes
- Added optional `business_address` on `workspaces` (`prisma/schema.prisma`, additive migration `prisma/migrations/20261126060000_add_workspace_business_address/migration.sql`), workspace settings service & API (`src/server/workspace/settings.ts`, `src/app/api/v1/workspace/settings/route.ts`), synced with `src/app/app/settings/profile/actions.ts`, added `workspaces` mock DB support (`src/test/local-store.ts`, `src/test/mock-db.ts`), and included `business_address` in GDPR export (`src/server/account/gdpr-service.ts`).
- Removed all auto-appended footers, `"---"` separators, hardcoded `"123 Innovation Way, Suite 400, Wilmington, DE 19801"`, `"Lead Reach AI Verified Cold Outreach, Cerkit Labs"`, and `[Test Preview sent...]` / `[TEST PREVIEW] ` prefixes from `src/server/email/sending-engine.ts`, `src/server/email/sequence-service.ts`, `src/server/email/campaign-service.ts`, `src/app/api/v1/outreach/test-send/route.ts`, `src/app/app/settings/profile/profile-form.tsx`, and `src/app/app/outreach/new/outreach-wizard.tsx`.
- Plain-text templates with open/click tracking disabled emit `text/plain` only (`html` omitted on both Gmail API and Nodemailer transports), while preserving `List-Unsubscribe`, `List-Unsubscribe-Post`, `/u/*`, suppressions, and Stop-on-Reply.
- Added cursor-position `"Insert unsubscribe line"` and `"Insert address"` buttons in `src/app/app/outreach/new/outreach-wizard.tsx` and `src/components/outreach/followup-step-builder.tsx`, optional `{{business_address}}` & `{{unsubscribe_url}}` rendering, and `"Raw message"` preview toggles on Step 4 & Step 5.
- Added `src/server/email/pure-message-mode.test.ts` (5 tests) covering Step 1 & follow-up fidelity, `text/plain`-only Gmail API & SMTP dispatch, header preservation, optional variables, test-send parity, and repo-wide grep verification that `"123 Innovation Way"` is absent from `src/`.
- **Decisions & Test Updates:** Updated `src/server/email/sending-engine.test.ts`, `src/server/email/tracking-token.test.ts`, and `src/server/email/outreach-followup.test.ts` assertions that previously expected auto-injected footers/`To unsubscribe:` or HTML wrappers on plain-text sends, because auto-footer injection was deleted per Task 1. (Note: `src/server/billing/providers/manual-provider.ts` still contains `Cerkit Labs / Lead Reach AI` as a manual bank transfer payee label unrelated to outreach emails.)
- **Verification:** `npx.cmd tsc --noEmit` PASS (0 errors), `npm.cmd run lint` PASS (0 errors), `npm.cmd test` PASS (49 test files, 295 tests passed).

### Plan
- **Files to add/modify:**
  - `prisma/schema.prisma`: add `business_address String?` on `workspaces`
  - `prisma/migrations/20261126060000_add_workspace_business_address/migration.sql`: additive `ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "business_address" TEXT;`
  - `src/test/local-store.ts`, `src/test/mock-db.ts`: add `workspaces` store + delegate support with `business_address`
  - `src/server/account/gdpr-service.ts`: include `business_address: true` in `workspaces` GDPR export (`exportUserAccountData`); deletion already cascades `workspaces`
  - `src/app/api/v1/workspace/settings/route.ts`: `GET` / `PATCH` optional workspace `business_address` setting for the authenticated user's default workspace
  - `src/app/app/settings/profile/actions.ts` & `src/app/app/settings/profile/profile-form.tsx`: keep user `sender_address` and default workspace `business_address` in sync; remove misleading footer copy
  - `src/server/email/sending-engine.ts`: remove auto-appended `---`, `legalAddress`, and `To unsubscribe:` from `buildEmailMultipartBodies()`; omit HTML MIME part (`html: undefined`) for plain-text templates unless `trackingOpen`, `trackingClick`, or HTML tags require HTML (and still inject no footer); resolve workspace `business_address` for optional `{{business_address}}` rendering; update `DispatchTransportInput` to omit `html` when `undefined`; delete Cerkit Labs placeholder fallback
  - `src/server/email/sequence-service.ts`: resolve workspace `business_address` for `{{business_address}}`; pass `unsubscribeUrl` into all template renders; pass `html` only when generated; delete fallback footer string
  - `src/server/email/campaign-service.ts`: remove `sender_address_footer` injection into `source_ref`
  - `src/app/api/v1/outreach/test-send/route.ts`: remove `[TEST PREVIEW]` prefix and `[Test Preview sent...]` footer; use `renderEmailTemplate` with workspace `business_address` and `/u/preview-test` sample URL
  - `src/app/app/outreach/new/outreach-wizard.tsx`: delete `"123 Innovation Way, Suite 400, Wilmington, DE 19801"` and auto-footer field wording; load optional workspace `business_address` for `{{business_address}}` preview/insertion; replace chip append with cursor-position insertion; add `"Insert unsubscribe line"` and `"Insert address"` buttons; add `"Raw message"` preview toggle showing final body and headers (`From`, `To`, `Subject`, `Content-Type`, `List-Unsubscribe`, `List-Unsubscribe-Post`)
  - `src/server/email/sending-engine.test.ts`, `src/server/email/spintax.test.ts`, `src/server/email/tracking-token.test.ts`, `src/server/email/outreach-followup.test.ts`: update existing assertions that explicitly checked the old auto-injected footer / `To unsubscribe:` text
  - `src/server/email/pure-message-mode.test.ts`: comprehensive tests for pure body fidelity (step 1 + follow-ups), `text/plain`-only transmission, `List-Unsubscribe` headers preserved, optional `{{business_address}}` / `{{unsubscribe_url}}` rendering, test-send exact fidelity, and repo-wide grep test confirming `"123 Innovation Way"` is gone from `src/`
- **Edge cases & risks:**
  - Plain-text templates with tracking off MUST send `text/plain` only (`html` omitted on both Gmail API and Nodemailer), whereas templates with open/click tracking enabled still need multipart HTML without any footer.
  - Workspaces may not exist yet for legacy test users created directly via `mock-db` -> fallback from `workspaces.business_address` to `users.sender_address` when resolving `{{business_address}}`.
  - BullMQ retries / concurrent sends only read immutable template + workspace/user settings and do not mutate templates.
