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

---

## Task 4 — Opt-out reply detection

**Status:** Completed

### Outcome & Changes
- Created `src/server/email/opt-out-detector.ts` (`extractFirstNonQuotedLine`, `detectDeterministicOptOut`) inspecting strictly the first non-empty, non-quoted line against a conservative allowlist (`"stop"`, `"unsubscribe"`, `"remove me"`, `"please remove me"`, `"not interested, stop"`, etc.) with zero substring/fuzzy matching.
- Updated `recordHumanReplyAndClassify` in `src/server/worker/reply-poller.ts`: executes Stop-on-Reply (`next_followup_at = null`) first; on deterministic opt-out match, marks recipient `unsubscribed`, records inbound reply with `reply_category: "unsubscribe"` and `reply_category_source: "rule_opt_out"`, and idempotently adds `email` to `db.suppressions`; on non-match, proceeds to safe AI classification which never auto-suppresses.
- Added `src/server/email/opt-out-detector.test.ts` (34 tests) verifying explicit opt-outs, quoted history filtering, multilingual non-matching safety, strict false-positive rejections (`"don't stop now"`, `"please don't unsubscribe me"`, etc.), suppression creation, and Stop-on-Reply + AI non-auto-suppression ordering.
- **Verification:** `npx.cmd tsc --noEmit` PASS (0 errors), `npm.cmd run lint` PASS (0 errors), `npm.cmd test` PASS (52 test files, 337 tests passed).

---

## Task 5 — Terms pages and legal acknowledgement

**Status:** Completed

### Outcome & Changes
- Added `workspace_legal_acknowledgements` table (`prisma/schema.prisma`, additive migration `prisma/migrations/20261126080000_add_workspace_legal_acknowledgements/migration.sql`) with unique index `(workspace_id, terms_version)` and `ON DELETE CASCADE`, mock DB support (`src/test/local-store.ts`, `src/test/mock-db.ts`), and GDPR export & deletion cleanup (`src/server/account/gdpr-service.ts`).
- Updated `src/app/terms/page.tsx` and created `src/app/acceptable-use/page.tsx` marked clearly as **DRAFT — REQUIRES LEGAL REVIEW**, covering CAN-SPAM / GDPR / PECR sole responsibility, valid postal address & opt-out method, lawful basis, truthful headers/subjects, zero harassment/illegal content, and suspension/termination rights.
- Updated `src/app/sitemap.ts`, `src/app/robots.ts`, `src/app/llms.txt/route.ts`, `src/app/page.tsx` footer, and `src/server/seo/seo.test.ts` (added `/acceptable-use` to public indexable routes test).
- Updated `src/components/auth/auth-form.tsx`, `src/app/(auth)/signup/page.tsx`, and `src/server/auth/actions.ts` (`signupAction`) to require accepting `/terms` and `/acceptable-use` on signup.
- Implemented `src/server/legal/acknowledgement.ts` (optional env `LEGAL_TERMS_VERSION`, default `"2026-11-v1"`) and `src/app/api/v1/workspace/legal-acknowledgement/route.ts`, enforced HTTP **422** (`LEGAL_ACKNOWLEDGEMENT_REQUIRED`) across both `POST /api/v1/outreach/campaigns` (`launchNow: true`) and `PATCH /api/v1/outreach/campaigns/[id]` (`status: "running"`) until accepted, and wired the first-launch modal in `src/app/app/outreach/new/outreach-wizard.tsx`.
- Added `src/server/legal/acknowledgement.test.ts` (4 tests) verifying gating, 422 API enforcement on create & PATCH, no repeat prompt, re-prompt & 422 enforcement on new `LEGAL_TERMS_VERSION`, `signupAction` consent enforcement, and GDPR export/deletion.
- **Verification:** `npx.cmd tsc --noEmit` PASS (0 errors), `npm.cmd run lint` PASS (0 errors), `npm.cmd test` PASS (53 test files, 341 tests passed).

---

## Task 6 — Adaptive per-account daily limit

**Status:** Completed

### Outcome & Changes
- Added adaptive profile, ramp, override, and rate-limit fields on `email_accounts` plus `account_limit_history` (`ON DELETE CASCADE`) and `admin_actions` (`ON DELETE SET NULL`) in `prisma/schema.prisma`, `prisma/migrations/20261126090000_add_adaptive_limits_and_admin_actions/migration.sql`, `src/test/local-store.ts`, `src/test/mock-db.ts`, and `src/server/account/gdpr-service.ts`.
- Implemented `src/server/email/adaptive-limit-config.ts`, `src/server/email/account-profile-detector.ts` (Gmail/Google Workspace MX lookup with timeout, read-only IMAP `\All` special-use attribute & `1:5` `INTERNALDATE` age detection with fallback warning `"Could not verify account age"`), `src/server/email/adaptive-limit-service.ts` (start tiers `10/20/30/40`, ceilings `50/50/100`, `>=14d` `+10` warmup bonus, daily 7-day window evaluator + `account_limit_history`, legacy pre-Phase-6 fixture preservation, and `admin_daily_limit_override` up to `SYSTEM_MAX_DAILY_LIMIT` default `150`), and `src/server/email/daily-capacity.ts` (atomic Redis Lua + per-account mutex reservation & failure release, 50% official limit safety invariant accounting for `warmup_logs`, UTC day keys, Gmail `550 5.4.5` / `454 4.7.0` postponement).
- Wired adaptive detection, capacity reservation/release, and daily 7-day health checks across `src/server/email/account-service.ts`, `src/server/email/sending-engine.ts`, `src/server/email/sequence-service.ts`, `src/server/email/warmup-pool-service.ts`, and `src/server/worker/index.ts`.
- Added/updated endpoints (`GET/POST/PATCH /api/v1/email-accounts*`, `POST /api/v1/email-accounts/[id]/recheck`, `PATCH /api/v1/admin/email-accounts/[id]/limit-override`), UI cards & Re-check / Workspace selector / user lower-cap controls (`src/app/app/outreach/email-accounts/*`), wizard today-capacity banner & warning (`src/app/app/outreach/new/outreach-wizard.tsx`), and admin override panel (`src/app/admin/users/[id]/*`).
- Added `src/server/email/adaptive-limit.test.ts` (9 tests) covering type/MX classification, IMAP `\All` read-only scan, age-tier boundaries & warmup bonus, 7-day ramp progression & floor `5`, forced re-check stability, user lower-cap & admin RBAC + `admin_actions`/`account_limit_history` logs, concurrent capacity race safety, 50% safety invariant, Gmail `550 5.4.5` rate-limit handling, and GDPR export/deletion.
- **Decisions:** Admin override (`admin_daily_limit_override`) explicitly supersedes `planCeiling` & weekly ramp up to `SYSTEM_MAX_DAILY_LIMIT` (default `150`) so admins can raise or lower caps above adaptive ceilings, while respecting any stricter lower `user_daily_limit`. Legacy accounts/test fixtures with no Phase 6 signals continue using legacy `warmup_start_limit` ramp behavior seamlessly.
- **Verification:** `npx.cmd tsc --noEmit` PASS (0 errors), `npm.cmd run lint` PASS (0 errors), `npm.cmd test` PASS (54 test files, 350 tests passed).

---

## Task 7 — Send jitter

**Status:** Completed

### Outcome & Changes
- Created `src/server/email/send-jitter.ts` (`getDefaultSendJitterBounds`, `resolveAccountJitterBounds`, `computeSendJitterSeconds`) enforcing default randomized delays between `120–300` seconds (configurable via `SEND_JITTER_MIN_SECONDS` and `SEND_JITTER_MAX_SECONDS` or per-account bounds).
- Fixed shared cross-account delay accumulation in `src/server/email/sending-engine.ts` (`dispatchRunningCampaigns`) by tracking `perAccountNextSlotMs` strictly per `assigned_account_id` so multiple accounts schedule in parallel via non-blocking BullMQ delays (`queueEmailSend(rec.id, delayMs)`) without slowing each other down.
- Updated `next_allowed_at` calculation and defaults across `src/server/email/sending-engine.ts`, `src/server/email/sequence-service.ts`, `src/server/email/campaign-service.ts`, `src/server/email/account-service.ts`, and `src/app/api/v1/email-accounts/route.ts` (`120–300s` default) while preserving Task 6 daily capacity enforcement.
- Added `src/server/email/send-jitter.test.ts` (4 tests) verifying default 120–300s randomized variance, env configuration, independent per-account BullMQ delayed scheduling even when another account has an active cooldown, and intact Task 6 daily caps.
- **Verification:** `npx.cmd tsc --noEmit` PASS (0 errors), `npm.cmd run lint` PASS (0 errors), `npm.cmd test` PASS (55 test files, 354 tests passed).

---

## Task 8 — Auto-pause on bad signals

**Status:** Completed

### Outcome & Changes
- Added `paused_deliverability` to `EmailAccountStatus` enum plus `consecutive_smtp_auth_failures`, `deliverability_pause_reason`, and `deliverability_paused_at` on `email_accounts` (`prisma/schema.prisma`, additive migration `prisma/migrations/20261126100000_add_deliverability_auto_pause/migration.sql`) and included these fields in GDPR export (`src/server/account/gdpr-service.ts`).
- Created `src/server/email/deliverability-pause.ts`:
  - `evaluateAccountBouncePause`: computes rolling 7-day hard-bounce rate with minimum `>= 30` sends threshold and pauses ONLY the triggering account when bounce rate is strictly `> 2%`.
  - `recordAccountAuthFailure` / `resetAccountAuthFailures`: increments serialized per-account `consecutive_smtp_auth_failures` (resets on successful send) and auto-pauses ONLY that account on the 3rd consecutive SMTP auth error.
  - `recordHardBounceAndSuppress`: updates recipient `status: "bounced"`, clears `next_followup_at`, idempotently inserts permanent suppression in `db.suppressions`, and triggers `evaluateAccountBouncePause`.
  - `resumePausedEmailAccount`: manual-only recovery resetting auth failure streak, clearing pause reason/timestamp, setting `status: "active"`, and preserving Task 6 `health_status: "holding"` without inflating limits.
- Wired auto-pause checks, clean paused-job throttling (re-queuing/holding without failing leads or killing healthy accounts), and permanent bounce suppression into `src/server/worker/reply-poller.ts`, `src/server/email/sending-engine.ts`, `src/server/email/sequence-service.ts`, `src/server/email/adaptive-limit-service.ts`, and `src/server/email/account-service.ts`.
- Added `POST /api/v1/email-accounts/[id]/resume` (`src/app/api/v1/email-accounts/[id]/resume/route.ts`) and rendered the deliverability pause banner, `Paused (Deliverability)` badge, and `"Manually Resume"` button in `src/app/app/outreach/email-accounts/email-accounts-manager.tsx`.
- Added `src/server/email/deliverability-pause.test.ts` (4 tests) verifying `>= 30` sample guard & `> 2%` boundary, 3 consecutive auth failures & counter reset, account isolation, synchronous `550 5.1.1` bounce suppression vs `550 5.4.5` ignore, and manual resume with Task 6 limits preserved.
- **Verification:** `npx.cmd tsc --noEmit` PASS (0 errors), `npm.cmd run lint` PASS (0 errors), `npm.cmd test` PASS (56 test files, 358 tests passed).

### Plan
- **Data model & GDPR (additive):**
  - `prisma/schema.prisma`: add `paused_deliverability` to `enum EmailAccountStatus`; add `consecutive_smtp_auth_failures Int @default(0)`, `deliverability_pause_reason String?`, and `deliverability_paused_at DateTime?` to `email_accounts`.
  - `prisma/migrations/20261126100000_add_deliverability_auto_pause/migration.sql`: additive `ALTER TYPE "EmailAccountStatus" ADD VALUE IF NOT EXISTS 'paused_deliverability';` and `ALTER TABLE "email_accounts" ADD COLUMN IF NOT EXISTS ...`.
  - `src/server/account/gdpr-service.ts`: export new `email_accounts` columns (`deliverability_pause_reason`, `deliverability_paused_at`, `consecutive_smtp_auth_failures`); deletion already cascades `email_accounts`.
- **Files to add/modify:**
  - `src/server/email/deliverability-pause.ts`:
    - `isSmtpAuthFailureError(msg)` & `isPermanentHardBounceSmtpError(msg)`.
    - `evaluateAccountBouncePause(accountId, now)`: computes 7-day rolling hard-bounce rate with minimum sample `>= 30` sends; if `> 2%`, auto-pauses ONLY that account (`status: "paused_deliverability"`, `health_status: "paused"`, plain-language `deliverability_pause_reason`, `deliverability_paused_at`) without pausing healthy mailboxes.
    - `recordAccountAuthFailure(accountId, errorMsg, now)` & `resetAccountAuthFailures(accountId)`: tracks `consecutive_smtp_auth_failures`; pauses ONLY that account once count reaches `3`.
    - `recordHardBounceAndSuppress(...)`: marks recipient `bounced`, clears `next_followup_at`, idempotently inserts permanent suppression into `db.suppressions`, then calls `evaluateAccountBouncePause`.
    - `resumePausedEmailAccount(userId, accountId)`: manual-only resume resetting `consecutive_smtp_auth_failures = 0`, clearing pause fields, setting `status = "active"` and `health_status = "holding"`.
  - `src/server/worker/reply-poller.ts`, `src/server/email/sending-engine.ts`, `src/server/email/sequence-service.ts`, `src/server/email/adaptive-limit-service.ts`, `src/server/email/account-service.ts`.
  - `src/app/api/v1/email-accounts/[id]/route.ts`, `src/app/api/v1/email-accounts/[id]/resume/route.ts`, `src/app/app/outreach/email-accounts/email-accounts-manager.tsx`.
  - `src/server/email/deliverability-pause.test.ts`.
- **Concurrency & risks:**
  - Concurrent workers recording auth failures or bounces could race; keep per-account increment/check serialized and idempotent. Queued jobs hitting a `paused_deliverability` account requeue cleanly without failing leads.

### Plan (Task 7 Archive)
- **Behavior & Architecture:**
  - Centralize randomized send jitter configuration in `src/server/email/send-jitter.ts` (`SEND_JITTER_MIN_SECONDS=120`, `SEND_JITTER_MAX_SECONDS=300` defaults, env-configurable, safe account/campaign overrides).
  - Fix `dispatchRunningCampaigns` in `src/server/email/sending-engine.ts` where a single `cumulativeDelayMs` was shared across all recipients in the loop; track delays strictly per `assigned_account_id` (plus that account's own `next_allowed_at` cooldown) so different sending accounts schedule independently via non-blocking BullMQ delayed jobs (`queueEmailSend(rec.id, delayMs)`) without blocking each other or slowing down multi-account sending.
  - Update `next_allowed_at` cooldown calculation in `sending-engine.ts` and `sequence-service.ts`, plus fallback creation bounds in `account-service.ts` and `campaign-service.ts`, to use `120–300` seconds defaults while keeping Task 6 daily caps untouched.
- **Files to add/modify:**
  - `src/server/email/send-jitter.ts`
  - `src/server/email/sending-engine.ts`
  - `src/server/email/sequence-service.ts`
  - `src/server/email/campaign-service.ts`
  - `src/server/email/account-service.ts`
  - `src/server/email/send-jitter.test.ts`
- **Edge cases & risks:**
  - Unassigned recipients (`assigned_account_id: null`) in `dispatchRunningCampaigns` pre-select or isolate under an unassigned bucket so they never inflate another mailbox's delay chain; BullMQ `jobId` deduplication prevents duplicate delayed jobs on repeated scheduler ticks.
  - Zero `sleep` / `setTimeout` inside BullMQ workers; delays occur solely via BullMQ `delay` option and persisted `next_allowed_at`.

### Plan (Task 6 Archive)
- **Data model changes (additive):**
  - `prisma/schema.prisma`:
    - Add to `email_accounts`: `account_type`, `workspace_tier`, `detected_age_days`, `message_count`, `age_source`, `detected_at`, `ramp_started_at`, `start_limit_snapshot`, `current_daily_limit`, `healthy_weeks_completed`, `last_evaluated_at`, `health_status`, `user_daily_limit`, `admin_daily_limit_override`, `rate_limited_until`, `rate_limit_hit_at`.
    - Add `model account_limit_history` (`id`, `account_id`, `user_id`, `date`, `old_limit`, `new_limit`, `reason`, `created_at`) with `ON DELETE CASCADE`.
    - Add `model admin_actions` (`id`, `admin_id`, `action`, `reason`, `target_user_id`, `workspace_id`, `account_id`, `metadata`, `created_at`) with `ON DELETE SET NULL` so audit logs survive GDPR deletion cleanly with identifiers removed.
  - `prisma/migrations/20261126090000_add_adaptive_limits_and_admin_actions/migration.sql`: additive `ALTER TABLE` + `CREATE TABLE IF NOT EXISTS` statements + indexes.
  - `src/test/local-store.ts`, `src/test/mock-db.ts`: add `account_limit_history` & `admin_actions` stores/delegates and cascade cleanup / anonymization on user deletion.
  - `src/server/account/gdpr-service.ts`: export new adaptive fields & `account_limit_history`; delete `account_limit_history` and strip PII (`admin_id`, `target_user_id`, metadata identifiers) from `admin_actions` on `deleteOwnAccount`.
- **Files to add/modify:**
  - `src/server/email/adaptive-limit-config.ts`: centralized config for plan ceilings (`free_gmail: 50`, `workspace_trial: 50`, `workspace_paid: 100`), official limits (`500 / 500 / 2000`), age-tier starts (`10 / 20 / 30 / 40`), warmup bonus (`+10` after `>=14` healthy days), weekly growth (`+10`), floor (`5`), and `SYSTEM_MAX_DAILY_LIMIT` (`150`), all overridable via optional env vars / settings.
  - `src/server/email/account-profile-detector.ts`: domain type & Google MX resolution with timeout; IMAP read-only `\All` special-use folder lookup (never hardcoded folder name), sequence `1:5` `INTERNALDATE` metadata-only scan, message count check (empty/almost-empty counts as `<30d`), and `<=1/day` / `force` detection without modifying already-started ramp start tier.
  - `src/server/email/adaptive-limit-service.ts`: start-limit & `effectiveLimit` computation, 7-day window daily health evaluation (`healthy` / `holding` / `reduced` / `paused`), `account_limit_history` logging, UI summary metrics, and legacy pre-Phase-6 fixture compatibility.
  - `src/server/email/daily-capacity.ts`: atomic per-account UTC daily capacity reservation & release (Redis Lua INCR/EXPIRE + process-local async mutex DB-backed reservation), 50% official limit safety invariant accounting for `warmup_logs` traffic, and Gmail 550/454 rate-limit detection + tomorrow retry scheduling without failing leads.
  - `src/server/email/account-service.ts`, `src/server/email/sending-engine.ts`, `src/server/email/sequence-service.ts`, `src/server/worker/index.ts`: wire auto-detection on connect, daily health eval in `maintenance` worker, atomic reservation/release & `ramp_started_at` initialization on dispatch, Gmail rate-limit handling.
  - `src/app/api/v1/email-accounts/route.ts`, `src/app/api/v1/email-accounts/[id]/route.ts`, `src/app/api/v1/email-accounts/[id]/recheck/route.ts`, `src/app/api/v1/admin/email-accounts/[id]/limit-override/route.ts`: API endpoints + server-side admin check (`requirePermission`/403 for non-admins).
  - `src/app/app/outreach/email-accounts/*`, `src/app/app/outreach/new/outreach-wizard.tsx`, `src/app/admin/users/[id]/*`: per-mailbox limit cards, Workspace selector, Re-check button, wizard total capacity warning, and admin limit override control.
  - `src/server/email/adaptive-limit.test.ts`: comprehensive mocked tests covering 6a–6f rules, concurrency race safety, capacity release on failed send, 50% provider invariant with warmup traffic, Gmail 550/454 handling, admin auth, and GDPR export/deletion.
- **Concurrency & migration risks:**
  - Two workers sending concurrently must never overshoot `min(adaptiveCap, remaining50PctCap)`: enforced by atomic Redis Lua check+incr AND serialized per-account async reservation mutex when Redis is unavailable, with immediate release on send failure before SMTP/Gmail acceptance.
  - UTC day boundaries: daily counters key on `YYYY-MM-DD` UTC; retries revert recipient to `queued` / postpone follow-up to next UTC midnight.

### Plan
- **Data model changes (additive):**
  - `prisma/schema.prisma`: add `model workspace_legal_acknowledgements` (`id`, `user_id`, `workspace_id`, `terms_version`, `accepted_at`, `@@unique([workspace_id, terms_version])`) + relation fields on `users` and `workspaces`.
  - `prisma/migrations/20261126080000_add_workspace_legal_acknowledgements/migration.sql`: additive `CREATE TABLE IF NOT EXISTS "workspace_legal_acknowledgements" ...` + indexes + FKs (`ON DELETE CASCADE`).
  - `src/test/local-store.ts` & `src/test/mock-db.ts`: add `workspace_legal_acknowledgements` CRUD + cascade cleanup on user/workspace deletion.
  - `src/server/account/gdpr-service.ts`: include `workspace_legal_acknowledgements` in GDPR export (`exportUserAccountData`) and transactional cleanup (`deleteOwnAccount`).
- **Public legal pages & SEO:**
  - `src/app/terms/page.tsx`: update existing Terms page with clear DRAFT banner (requires legal review) and full outreach compliance obligations (CAN-SPAM, GDPR, PECR, valid postal address & opt-out where required, lawful basis, truthful identity/subjects, no harassment/illegal content, suspension rights).
  - `src/app/acceptable-use/page.tsx`: new public indexable Acceptable Use Policy page marked DRAFT with full SEO metadata (`alternates.canonical`, OpenGraph, Twitter) consistent with Phase 4 SEO setup.
  - `src/app/sitemap.ts`, `src/app/robots.ts`, `src/app/llms.txt/route.ts`, `src/app/page.tsx` footer: add `/acceptable-use`.
  - `src/server/seo/seo.test.ts`: include `/acceptable-use` in sitemap/robots/public-metadata tests.
- **Signup & Workspace Launch Enforcement:**
  - `src/components/auth/auth-form.tsx`, `src/app/(auth)/signup/page.tsx`, `src/server/auth/actions.ts`: require accepting `/terms` and `/acceptable-use` via checkbox on signup (validated server-side in `signupAction`).
  - `src/server/legal/acknowledgement.ts`: `getCurrentLegalTermsVersion()` (env `LEGAL_TERMS_VERSION` optional, default `"2026-11-v1"`), `LegalAcknowledgementRequiredError` (422), `hasWorkspaceLegalAcknowledgement`, `recordWorkspaceLegalAcknowledgement`, `assertWorkspaceLegalAcknowledgement`.
  - `src/app/api/v1/workspace/legal-acknowledgement/route.ts`: `GET` status + `POST` acceptance endpoint.
  - `src/server/email/campaign-service.ts`, `src/app/api/v1/outreach/campaigns/route.ts`, `src/app/api/v1/outreach/campaigns/[id]/route.ts`: enforce acknowledgement on launch (`launchNow: true` and `PATCH status: "running"`), returning HTTP 422 until accepted. Draft saving (`launchNow: false`) remains allowed.
  - `src/app/app/outreach/new/outreach-wizard.tsx`: show first-launch Legal Acknowledgement modal with required checkbox; never re-show once accepted unless `termsVersion` changes; handle 422 cleanly.
  - `src/server/legal/acknowledgement.test.ts`: tests for legal gating, 422 API enforcement (create + PATCH launch), no repeat once accepted, re-prompt on new `LEGAL_TERMS_VERSION`, `signupAction` checkbox enforcement, and GDPR export/delete inclusion.
- **Edge cases & risks:**
  - Concurrency / double-click launch: unique index `(workspace_id, terms_version)` handles idempotent acceptances cleanly.
  - Existing unit tests creating draft campaigns (`launchNow: false`) remain unaffected; reply-detection guard runs before legal check on `createOutreachCampaign` so existing `crit-03` guard test stays green.

### Plan
- **Behavior & ordering:**
  1. Execute Stop-on-Reply immediately (`next_followup_at = null`, status updated).
  2. Run conservative deterministic opt-out detection on the first non-quoted line ONLY (`src/server/email/opt-out-detector.ts`). On an exact match (`"stop"`, `"unsubscribe"`, `"remove me"`, `"please remove me"`, `"not interested, stop"`, etc.), mark recipient `status: "unsubscribed"`, `reply_category: "unsubscribe"`, record inbound reply `email_messages` with `reply_category: "unsubscribe"`, `reply_category_source: "rule_opt_out"`, and insert into `db.suppressions` (idempotent check first). Also sync matching `leads.status` if `lead_id` is linked (optional best-effort).
  3. On non-match, preserve existing Stop-on-Reply + safe `classifyReplyIntent()` flow where AI classification NEVER adds rows to `suppressions`.
- **Files to add/modify:**
  - `src/server/email/opt-out-detector.ts`: pure deterministic parser `extractFirstNonQuotedLine(bodyText)` and `detectDeterministicOptOut(bodyText)`
  - `src/server/worker/reply-poller.ts`: wire `detectDeterministicOptOut` into `recordHumanReplyAndClassify` (and poll log); make `recipient.email` optional with DB lookup fallback
  - `src/server/email/opt-out-detector.test.ts`: comprehensive unit & integration tests (explicit matches, quoted-text isolation, multilingual non-matching safe handling, false-positive exclusions such as `"don't stop now"` / `"please don't unsubscribe me"` / conversational sentences, suppression insertion, Stop-on-Reply + AI non-auto-suppression verification)
- **Edge cases & risks:**
  - Quoted reply blocks (`>`, `On ... wrote:`, `-----Original Message-----`, `From: ...`) containing `"Stop"` in quoted history must NOT trigger opt-out if the first non-quoted line is normal conversation.
  - Strict whole-line exact matching after whitespace/trailing-punctuation normalization prevents false positives across English & multilingual text.
  - Duplicate inbound polls or BullMQ retries stay idempotent (`suppressions.findFirst` check before `create`; skip if recipient is already `"replied"` or `"unsubscribed"`).

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
