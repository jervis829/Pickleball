-- P5-D: coach-reviewed remediation and criterion-scoped retests.
PRAGMA foreign_keys = ON;

ALTER TABLE assessment_criterion_results ADD COLUMN coach_review_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (coach_review_status IN ('pending','confirmed','needs_remediation','not_applicable'));
ALTER TABLE assessment_criterion_results ADD COLUMN coach_decision_note TEXT;
ALTER TABLE assessment_attempts ADD COLUMN criteria_scope_json TEXT;

CREATE TABLE IF NOT EXISTS assessment_remediation_plans (
  id TEXT PRIMARY KEY,
  source_attempt_id TEXT NOT NULL REFERENCES assessment_attempts(id) ON DELETE RESTRICT,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','in_progress','completed','cancelled')),
  coach_note TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_remediation_student ON assessment_remediation_plans(student_id, created_at DESC);
CREATE TABLE IF NOT EXISTS assessment_remediation_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES assessment_remediation_plans(id) ON DELETE CASCADE,
  criterion_code TEXT NOT NULL,
  criterion_snapshot_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  lesson_numbers_json TEXT NOT NULL DEFAULT '[]',
  skill_keys_json TEXT NOT NULL DEFAULT '[]',
  activity TEXT NOT NULL,
  dose_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','ready_for_retest','completed','deferred')),
  coach_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plan_id, criterion_code)
);
CREATE INDEX IF NOT EXISTS idx_remediation_items_plan ON assessment_remediation_items(plan_id, priority);
