import { describe, it, expect, vi, beforeEach } from "vitest";
import { getWorkerSchedulerStatus } from "./status";

const { mockPing, mockGet } = vi.hoisted(() => ({
  mockPing: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock("@/server/queues", () => ({
  getRedisConnection: () => ({
    ping: mockPing,
    get: mockGet,
  }),
}));

describe("getWorkerSchedulerStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports warning when worker heartbeat is missing", async () => {
    mockPing.mockResolvedValue("PONG");
    mockGet.mockResolvedValue(null);

    const status = await getWorkerSchedulerStatus(1_700_000_000_000);
    expect(status.redisOk).toBe(true);
    expect(status.workerUp).toBe(false);
    expect(status.schedulersEnabled).toBe(false);
    expect(status.warningMessage).toContain("No background worker heartbeat detected");
  });

  it("reports warning when worker is up but SCHEDULERS_ENABLED is false", async () => {
    const nowMs = 1_700_000_000_000;
    mockPing.mockResolvedValue("PONG");
    mockGet.mockResolvedValue(
      JSON.stringify({
        timestamp: new Date(nowMs - 15_000).toISOString(),
        schedulersEnabled: false,
      })
    );

    const status = await getWorkerSchedulerStatus(nowMs);
    expect(status.redisOk).toBe(true);
    expect(status.workerUp).toBe(true);
    expect(status.schedulersEnabled).toBe(false);
    expect(status.warningMessage).toContain("SCHEDULERS_ENABLED is false");
  });

  it("reports warning when worker heartbeat is stale (> 5 minutes)", async () => {
    const nowMs = 1_700_000_000_000;
    mockPing.mockResolvedValue("PONG");
    mockGet.mockResolvedValue(
      JSON.stringify({
        timestamp: new Date(nowMs - 6 * 60 * 1000).toISOString(),
        schedulersEnabled: true,
      })
    );

    const status = await getWorkerSchedulerStatus(nowMs);
    expect(status.workerUp).toBe(false);
    expect(status.stale).toBe(true);
    expect(status.warningMessage).toContain("stale");
  });

  it("reports healthy with no warning when worker heartbeat is fresh and schedulers are enabled", async () => {
    const nowMs = 1_700_000_000_000;
    mockPing.mockResolvedValue("PONG");
    mockGet.mockResolvedValue(
      JSON.stringify({
        timestamp: new Date(nowMs - 20_000).toISOString(),
        schedulersEnabled: true,
      })
    );

    const status = await getWorkerSchedulerStatus(nowMs);
    expect(status.redisOk).toBe(true);
    expect(status.workerUp).toBe(true);
    expect(status.schedulersEnabled).toBe(true);
    expect(status.stale).toBe(false);
    expect(status.warningMessage).toBeNull();
  });
});
