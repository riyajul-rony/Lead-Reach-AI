-- Additive Phase 6 migration: workspace first-launch legal acknowledgement table
CREATE TABLE IF NOT EXISTS "workspace_legal_acknowledgements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "terms_version" TEXT NOT NULL,
  "accepted_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "workspace_legal_acknowledgements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_legal_acknowledgements_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workspace_legal_acknowledgements_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_legal_acknowledgements_workspace_id_terms_version_key"
  ON "workspace_legal_acknowledgements"("workspace_id", "terms_version");

CREATE INDEX IF NOT EXISTS "workspace_legal_acknowledgements_user_id_idx"
  ON "workspace_legal_acknowledgements"("user_id");

CREATE INDEX IF NOT EXISTS "workspace_legal_acknowledgements_workspace_id_idx"
  ON "workspace_legal_acknowledgements"("workspace_id");
