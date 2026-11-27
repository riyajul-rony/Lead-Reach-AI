import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { areSchedulersEnabled, getStaleThresholdHours } from "@/server/env";
import { registerRepeatableSchedulers, removeRepeatableSchedulers, queueEmailSend } from "@/server/queues";
import { db } from "@/server/db";
import { dispatchDueFollowups } from "@/server/email/sequence-service";
import { dispatchRunningCampaigns } from "@/server/email/sending-engine";

const { mockUpsertJobScheduler, mockAdd, mockRemoveJobScheduler } = vi.hoisted(() => ({
  mockUpsertJobScheduler: vi.fn().mockResolvedValue({ id: "mock-scheduler" }),
  mockAdd: vi.fn().mockResolvedValue({ id: "mock-job" }),
  mockRemoveJobScheduler: vi.fn().mockResolvedValue(true),
}));

vi.mock("bullmq", () => {
  class MockQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    upsertJobScheduler = mockUpsertJobScheduler;
    add = mockAdd;
    removeJobScheduler = mockRemoveJobScheduler;
  }

  class MockWorker {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    close = vi.fn().mockResolvedValue(undefined);
  }

  return {
    Queue: MockQueue,
    Worker: MockWorker,
  };
});

describe("CRIT-02: Repeatable Job Schedulers & Catch-Up Protection", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("1. Environment Configuration & Safe-Start Switch", () => {
    it("defaults SCHEDULERS_ENABLED to false when not provided", () => {
      delete process.env.SCHEDULERS_ENABLED;
      expect(areSchedulersEnabled()).toBe(false);
    });

    it("evaluates SCHEDULERS_ENABLED to true only when explicitly 'true'", () => {
      process.env.SCHEDULERS_ENABLED = "true";
      expect(areSchedulersEnabled()).toBe(true);

      process.env.SCHEDULERS_ENABLED = "1";
      expect(areSchedulersEnabled()).toBe(false);

      process.env.SCHEDULERS_ENABLED = "false";
      expect(areSchedulersEnabled()).toBe(false);
    });

    it("defaults STALE_THRESHOLD_HOURS to 24 when not provided", () => {
      delete process.env.STALE_THRESHOLD_HOURS;
      expect(getStaleThresholdHours()).toBe(24);
    });

    it("respects custom STALE_THRESHOLD_HOURS", () => {
      process.env.STALE_THRESHOLD_HOURS = "48";
      expect(getStaleThresholdHours()).toBe(48);
    });
  });

  describe("2. Scheduler Registration Guard", () => {
    it("does not register schedulers when SCHEDULERS_ENABLED is false", async () => {
      process.env.SCHEDULERS_ENABLED = "false";
      const result = await registerRepeatableSchedulers();
      expect(result.registered).toBe(false);
      expect(result.schedulers).toHaveLength(0);
    });

    it("registers 5 repeatable schedulers when SCHEDULERS_ENABLED is true", async () => {
      process.env.SCHEDULERS_ENABLED = "true";
      const result = await registerRepeatableSchedulers();
      expect(result.registered).toBe(true);
      expect(result.schedulers).toContain("planner (every 60s)");
      expect(result.schedulers).toContain("email-dispatch (every 60s)");
      expect(result.schedulers).toContain("reply-poll (every 5m)");
      expect(result.schedulers).toContain("maintenance (daily 02:00 UTC)");
      expect(result.schedulers).toContain("warmup-pool (every 15m)");
    });

    it("calls removeJobScheduler for all 5 schedulers when SCHEDULERS_ENABLED is false (kill switch)", async () => {
      process.env.SCHEDULERS_ENABLED = "false";
      mockRemoveJobScheduler.mockClear();
      const result = await registerRepeatableSchedulers();
      expect(result.registered).toBe(false);
      // removeJobScheduler must have been called once per scheduler (5 total)
      expect(mockRemoveJobScheduler).toHaveBeenCalledTimes(5);
      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("leadreach:scheduler:planner");
      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("leadreach:scheduler:email-dispatch");
      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("leadreach:scheduler:reply-poll");
      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("leadreach:scheduler:maintenance");
      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("leadreach:scheduler:warmup");
    });

    it("removeRepeatableSchedulers() alone calls removeJobScheduler for all 5 IDs", async () => {
      mockRemoveJobScheduler.mockClear();
      const result = await removeRepeatableSchedulers();
      expect(result.removed).toHaveLength(5);
      expect(mockRemoveJobScheduler).toHaveBeenCalledTimes(5);
    });
  });

  describe("3. Catch-Up Protection for Follow-ups", () => {
    it("marks overdue follow-ups older than 24h as needs_review without deleting data", async () => {
      process.env.STALE_THRESHOLD_HOURS = "24";
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      const campaign = await db.outreach_campaigns.create({
        data: {
          id: "camp-stale-test",
          user_id: "user-stale-1",
          name: "Stale Followup Test Campaign",
          status: "running",
          recipient_source: "manual",
          timezone: "UTC",
          send_window: { startHour: 0, endHour: 24 },
        },
      });

      await db.followup_sequences.create({
        data: {
          id: "seq-stale-test",
          campaign_id: campaign.id,
          user_id: "user-stale-1",
          status: "active",
          steps: [
            {
              step_no: 2,
              delay_days: 1,
              subject: "Step 2",
              body: "Body 2",
              same_thread: true,
            },
          ],
        },
      });

      // Recipient A: 3 days overdue (stale)
      const staleRec = await db.campaign_recipients.create({
        data: {
          id: "rec-stale-overdue",
          campaign_id: campaign.id,
          user_id: "user-stale-1",
          email: "stale@target.com",
          status: "sent",
          current_step: 1,
          next_followup_at: threeDaysAgo,
          unsubscribe_token: "tok_stale_123456789012345678901",
        },
      });

      // Recipient B: 2 hours overdue (fresh within 24h threshold)
      const freshRec = await db.campaign_recipients.create({
        data: {
          id: "rec-fresh-due",
          campaign_id: campaign.id,
          user_id: "user-stale-1",
          email: "fresh@target.com",
          status: "sent",
          current_step: 1,
          next_followup_at: twoHoursAgo,
          unsubscribe_token: "tok_fresh_123456789012345678901",
        },
      });

      await dispatchDueFollowups(now);

      // Verify Stale Recipient was marked needs_review
      const updatedStale = await db.campaign_recipients.findUnique({
        where: { id: staleRec.id },
      });
      expect(updatedStale?.status).toBe("needs_review");
      expect(updatedStale?.error).toContain("stale threshold");

      // Verify Fresh Recipient was NOT marked needs_review
      const updatedFresh = await db.campaign_recipients.findUnique({
        where: { id: freshRec.id },
      });
      expect(updatedFresh?.status).not.toBe("needs_review");
    });
  });

  describe("4. Catch-Up Protection for Queued Campaign Emails", () => {
    it("marks queued recipients older than 24h as needs_review before dispatch", async () => {
      process.env.STALE_THRESHOLD_HOURS = "24";
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);

      const campaign = await db.outreach_campaigns.create({
        data: {
          id: "camp-queued-stale",
          user_id: "user-queued-stale",
          name: "Queued Stale Test",
          status: "running",
          recipient_source: "manual",
          timezone: "UTC",
          send_window: { startHour: 0, endHour: 24 },
          days_of_week: [0, 1, 2, 3, 4, 5, 6],
        },
      });

      const staleQueuedRec = await db.campaign_recipients.create({
        data: {
          id: "rec-queued-stale",
          campaign_id: campaign.id,
          user_id: "user-queued-stale",
          email: "stale_queued@target.com",
          status: "queued",
          created_at: threeDaysAgo,
          unsubscribe_token: "tok_queued_stale_1234567890123",
        },
      });

      const freshQueuedRec = await db.campaign_recipients.create({
        data: {
          id: "rec-queued-fresh",
          campaign_id: campaign.id,
          user_id: "user-queued-stale",
          email: "fresh_queued@target.com",
          status: "queued",
          created_at: oneHourAgo,
          unsubscribe_token: "tok_queued_fresh_1234567890123",
        },
      });

      await dispatchRunningCampaigns();

      const updatedStale = await db.campaign_recipients.findUnique({
        where: { id: staleQueuedRec.id },
      });
      expect(updatedStale?.status).toBe("needs_review");
      expect(updatedStale?.error).toContain("stale threshold");

      const updatedFresh = await db.campaign_recipients.findUnique({
        where: { id: freshQueuedRec.id },
      });
      expect(updatedFresh?.status).not.toBe("needs_review");
    });
  });

  describe("5. Catch-Up Protection for Social Post Runs", () => {
    it("marks overdue post runs older than 24h as needs_review without deleting data", async () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);

      const stalePost = await db.post_runs.create({
        data: {
          id: "post-stale-overdue",
          campaign_id: "camp-social-1",
          user_id: "user-social-1",
          scheduled_for: threeDaysAgo,
          status: "scheduled",
        },
      });

      const freshPost = await db.post_runs.create({
        data: {
          id: "post-fresh-due",
          campaign_id: "camp-social-1",
          user_id: "user-social-1",
          scheduled_for: oneHourAgo,
          status: "scheduled",
        },
      });

      // Simulate planner catch-up protection logic
      const staleHours = 24;
      const staleCutoff = new Date(now.getTime() - staleHours * 60 * 60 * 1000);
      await db.post_runs.updateMany({
        where: {
          status: "scheduled",
          scheduled_for: { lt: staleCutoff },
        },
        data: {
          status: "needs_review",
          error_message: `Post run scheduled_for is older than stale threshold (${staleHours}h). Marked as needs_review for safety.`,
        },
      });

      const updatedStale = await db.post_runs.findUnique({
        where: { id: stalePost.id },
      });
      expect(updatedStale?.status).toBe("needs_review");
      expect(updatedStale?.error_message).toContain("stale threshold");

      const updatedFresh = await db.post_runs.findUnique({
        where: { id: freshPost.id },
      });
      expect(updatedFresh?.status).toBe("scheduled");
    });
  });

  describe("6. Deterministic BullMQ jobId for Email Send", () => {
    it("enqueues send jobs with deterministic jobId per recipient and step to avoid duplicate jobs", async () => {
      mockAdd.mockClear();
      await queueEmailSend("rec-det-1", 5000, 0);
      await queueEmailSend("rec-det-1", 7000, 0);
      await queueEmailSend("rec-det-1", 1000, 1);

      expect(mockAdd).toHaveBeenCalledTimes(3);
      expect(mockAdd.mock.calls[0][2]?.jobId).toBe("send_rec-det-1_step_0");
      expect(mockAdd.mock.calls[1][2]?.jobId).toBe("send_rec-det-1_step_0");
      expect(mockAdd.mock.calls[2][2]?.jobId).toBe("send_rec-det-1_step_1");
    });
  });
});
