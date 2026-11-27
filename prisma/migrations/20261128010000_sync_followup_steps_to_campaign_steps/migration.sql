-- Additive Phase 6c migration: copy any legacy followup_steps into canonical campaign_steps.
-- Idempotent and safe on existing data; does not drop followup_sequences or followup_steps.
INSERT INTO "campaign_steps" (
    "campaign_id",
    "step_no",
    "delay_days",
    "mode",
    "subject_template",
    "body_template",
    "ai_instruction",
    "tracking_open",
    "tracking_click"
)
SELECT
    seq."campaign_id",
    fs."step_no",
    GREATEST(fs."delay_days", 1),
    fs."mode",
    fs."subject_template",
    fs."body_template",
    fs."ai_instruction",
    false,
    false
FROM "followup_steps" fs
INNER JOIN "followup_sequences" seq
    ON seq."id" = fs."sequence_id"
WHERE seq."campaign_id" IS NOT NULL
ON CONFLICT ("campaign_id", "step_no") DO NOTHING;
