import { vi } from "vitest";
import { createTestMockDb, scoped } from "./mock-db";

// Route @/server/db to the test-only in-memory store when no PostgreSQL DATABASE_URL is configured.
vi.mock("@/server/db", async (importOriginal) => {
  if (process.env.DATABASE_URL) {
    return await importOriginal<typeof import("@/server/db")>();
  }
  return {
    db: createTestMockDb(),
    scoped,
  };
});
