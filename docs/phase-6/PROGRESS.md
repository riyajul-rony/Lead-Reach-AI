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

---

## Task 2 — Tracking default off, toggles remain

**Status:** Completed

### Outcome & Changes
- Added nullable per-step tracking columns `tracking_open Boolean?` and `tracking_click Boolean?` on `campaign_steps` (`prisma/schema.prisma`, additive migration `prisma/migrations/20261126070000_add_step_tracking_flags/migration.sql`) and updated `src/test/mock-db.ts` + `src/server/account/gdpr-service.ts` (`campaign_steps` export).
- Kept existing campaigns/steps unchanged (`null` falls back to `campaign.tracking_open` / `campaign.tracking_click`), while all newly created campaigns, campaign steps, and follow-up sequence blueprints default `tracking_open: false` and `tracking_click: false`.
- Updated `src/server/email/campaign-service.ts`, `src/server/email/sequence-service.ts`, `src/server/email/sending-engine.ts`, `src/app/api/v1/track/open/[token]/route.ts`, and `src/app/api/v1/track/click/[token]/route.ts` so pixels and link rewriting fire strictly when enabled on the active step/campaign while `/u/*`, `List-Unsubscribe`, and `List-Unsubscribe-Post` remain untouched.
- Rendered per-campaign tracking toggles in `src/app/app/outreach/new/outreach-wizard.tsx` and per-step toggles in `src/components/outreach/followup-step-builder.tsx` (both OFF by default) with the deliverability notice.
- Added `src/server/email/tracking-defaults.test.ts` (4 tests) verifying defaults, `text/plain` when off, open-pixel isolation, click-link isolation, and per-step follow-up overrides.
- **Verification:** `npx.cmd tsc --noEmit` PASS (0 errors), `npm.cmd run lint` PASS (0 errors), `npm.cmd test` PASS (50 test files, 299 tests passed).

---

## Task 3 — From name per email account

**Status:** Completed

### Outcome & Changes
- Created `src/server/email/sender-identity.ts` (`sanitizeSenderName`, `resolveAccountSenderName`, `resolveSenderFirstName`, `formatFromHeader`) to safely format `"First Last" <email>` RFC-2822 headers without CRLF/quote hazards or product-brand fallback, and extract `sender_first_name`.
- Updated `src/server/email/account-service.ts`, `src/app/api/v1/email-accounts/route.ts`, and `src/app/api/v1/email-accounts/[id]/route.ts` to expose & accept `senderName` synced with `from_name`, defaulting newly created accounts to `input.senderName || input.from_name || session.user.name || emailPrefix`.
- Wired `formatFromHeader(account)` and `sender_first_name: resolveSenderFirstName(account)` into `src/server/email/sending-engine.ts` (Gmail API & SMTP), `src/server/email/sequence-service.ts`, and `src/app/api/v1/outreach/test-send/route.ts`.
- Added editable `Sender Name (From Header)` input + hint `"Use a real human name that matches the signature, not a product name."` in `src/app/app/outreach/email-accounts/email-accounts-manager.tsx`, `src/app/app/outreach/email-accounts/page.tsx`, and `src/components/warmup/gmail-app-password-modal.tsx`, plus `+ {{sender_first_name}}` chip & live preview support in `src/app/app/outreach/new/outreach-wizard.tsx`.
- Added `src/server/email/sender-identity.test.ts` (4 tests) covering header formatting, injection sanitization, `PATCH /api/v1/email-accounts/[id]` updates, `{{sender_first_name}}` rendering across initial/follow-up/Gmail API/test-send, and default name fallback.
- **Verification:** `npx.cmd tsc --noEmit` PASS (0 errors), `npm.cmd run lint` PASS (0 errors), `npm.cmd test` PASS (51 test files, 303 tests passed).

### Plan
- **Data model strategy:** `email_accounts` already stores `from_name String?` (included in GDPR export/deletion). We expose and accept `senderName` cleanly across `account-service`, API routes (`/api/v1/email-accounts`, `/api/v1/email-accounts/[id]`), and UI backed by `from_name`, defaulting to the existing account `from_name` (or user profile name / email prefix on new creation) so existing accounts keep their names seamlessly with zero risk of column drift.
- **Files to add/modify:**
  - `src/server/email/sender-identity.ts`: pure helpers `resolveAccountSenderName`, `formatFromHeader`, `resolveSenderFirstName`
  - `src/server/email/account-service.ts`: accept `senderName` alongside `from_name` on create & update, return `senderName` from `sanitizeAccount`
  - `src/app/api/v1/email-accounts/route.ts` & `src/app/api/v1/email-accounts/[id]/route.ts`: accept `senderName` alias in Zod/PATCH, return `senderName` in GET/PATCH responses, default new account `from_name` using `input.senderName || input.from_name || session.user.name || emailPrefix`
  - `src/server/email/sending-engine.ts`, `src/server/email/sequence-service.ts`, `src/app/api/v1/outreach/test-send/route.ts`: use `formatFromHeader(account)` for Gmail API & SMTP `From` headers and inject `sender_first_name: resolveSenderFirstName(account)` into `templateVars` for initial, follow-up, AI fallback, and test-send renders
  - `src/app/app/outreach/email-accounts/page.tsx` & `email-accounts-manager.tsx` & `src/components/warmup/gmail-app-password-modal.tsx`: display & edit `senderName` (`from_name`) with explicit hint `"Use a real human name that matches the signature, not a product name."`
  - `src/app/app/outreach/new/outreach-wizard.tsx`: add `+ {{sender_first_name}}` variable chip, resolve `sender_first_name` in `previewVars`, and compose `From:` in `previewRawMessage` using `formatFromHeader`
  - `src/server/email/sender-identity.test.ts`: tests for header composition, CRLF sanitization, defaulting, API `PATCH` update, `{{sender_first_name}}` rendering across initial/follow-up/test-send
- **Edge cases & risks:**
  - Account with null/empty `from_name` must fall back to raw email address in `From` header (never `"null" <...>` or brand name like `"Lead Reach AI"`).
  - Double quotes/newlines inside `senderName` must be sanitized before header formatting to prevent header injection.

### Plan
- **Existing campaigns policy:** `outreach_campaigns.tracking_open` and `outreach_campaigns.tracking_click` are already `@default(false)` in `prisma/schema.prisma`, and existing campaigns are left untouched (we do NOT overwrite existing campaign or step rows). New `campaign_steps.tracking_open` and `campaign_steps.tracking_click` columns are nullable (`Boolean?`) so existing legacy steps inherit `campaign.tracking_open` / `campaign.tracking_click` while all new steps explicitly default to `false` (`tracking_open: false`, `tracking_click: false`).
- **Files to add/modify:**
  - `prisma/schema.prisma`: add `tracking_open Boolean?` and `tracking_click Boolean?` to `campaign_steps`
  - `prisma/migrations/20261126070000_add_step_tracking_flags/migration.sql`: additive `ALTER TABLE "campaign_steps" ADD COLUMN IF NOT EXISTS "tracking_open" BOOLEAN, ADD COLUMN IF NOT EXISTS "tracking_click" BOOLEAN;`
  - `src/test/local-store.ts`: default `tracking_open`/`tracking_click` appropriately in `saveCampaignStep`
  - `src/server/account/gdpr-service.ts`: include `campaign_steps` (with `tracking_open`, `tracking_click`) in `outreachCampaigns` GDPR export (`outreach_campaigns` cascade already deletes `campaign_steps`)
  - `src/server/email/campaign-service.ts`: default `trackingOpen` / `trackingClick` to `false` and persist `tracking_open: Boolean(s.tracking_open)`, `tracking_click: Boolean(s.tracking_click)` on `campaign_steps` and `followup_sequences`
  - `src/server/email/sequence-service.ts`: support `tracking_open?: boolean` and `tracking_click?: boolean` (default `false`) in `FollowupStep`, `getCampaignSequence`, `saveCampaignSequence`, and use per-step resolved flags (`step.tracking_open ?? campaign.tracking_open`, `step.tracking_click ?? campaign.tracking_click`) in `sendSingleRecipientFollowup`
  - `src/server/email/sending-engine.ts`: resolve per-step `trackingOpen` / `trackingClick` (`stepRecord?.tracking_open ?? campaign.tracking_open`) for follow-up steps cleanly while Step 0 uses `campaign.tracking_open` / `campaign.tracking_click`
  - `src/app/api/v1/track/open/[token]/route.ts` and `src/app/api/v1/track/click/[token]/route.ts`: allow recording events when either `campaign.tracking_open`/`tracking_click` OR any step of the campaign enabled it
  - `src/app/app/outreach/new/outreach-wizard.tsx` & `src/components/outreach/followup-step-builder.tsx`: keep per-campaign and per-step Open Tracking & Click Tracking toggles (both OFF by default) with clear deliverability note: `"Click tracking rewrites links, open tracking adds a hidden image; both can hurt inbox placement."`
  - `src/server/email/tracking-defaults.test.ts`: Vitest tests verifying defaults (`tracking_open=false`, `tracking_click=false` on new campaign & new follow-up steps), no pixel & no link rewriting when off (and `text/plain` only), pixel added only when `trackingOpen` is on, links rewritten only when `trackingClick` is on, per-step override independently of Step 0, and `List-Unsubscribe` / `/u/*` preserved untouched.
- **Edge cases & risks:**
  - Step with `trackingOpen=false` and `trackingClick=true` wraps links in HTML without adding an open-tracking `<img>` pixel; `trackingOpen=true` and `trackingClick=false` adds the `<img>` pixel without rewriting links; both `false` emits `text/plain` only.
  - Concurrency / retries only read immutable campaign & step tracking booleans.

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
