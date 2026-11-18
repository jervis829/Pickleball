-- P6: 身体素质测评（fitness battery）——入班体能由「教练 0-5 主观打分」升级为「可量化 9 项实测 + 图文报告」。
-- 版本化：每次测评固化测评表快照，规则调整不改变历史报告的解释。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS fitness_assessments (
  id                     TEXT PRIMARY KEY,
  student_id             TEXT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  battery_code           TEXT NOT NULL,
  battery_version        INTEGER NOT NULL,
  battery_snapshot_json  TEXT NOT NULL,
  test_date              TEXT NOT NULL,
  age_group_code         TEXT NOT NULL,
  age_group_name         TEXT NOT NULL,
  age_factor             REAL NOT NULL DEFAULT 1,
  sex                    TEXT CHECK (sex IS NULL OR sex IN ('male','female')),
  height_cm              REAL,
  weight_kg              REAL,
  status                 TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','completed','abandoned')),
  total_index            REAL,
  fit_score              REAL,
  fit_score_label        TEXT,
  notes                  TEXT,
  assessed_by            TEXT,
  assessed_by_name       TEXT,
  completed_at           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fitness_assessments_student
  ON fitness_assessments(student_id, test_date DESC);
CREATE INDEX IF NOT EXISTS idx_fitness_assessments_status
  ON fitness_assessments(status, test_date DESC);

CREATE TABLE IF NOT EXISTS fitness_results (
  id              TEXT PRIMARY KEY,
  assessment_id   TEXT NOT NULL REFERENCES fitness_assessments(id) ON DELETE CASCADE,
  item_code       TEXT NOT NULL,
  item_name       TEXT NOT NULL,
  dimension       TEXT NOT NULL,
  variant_code    TEXT,
  variant_name    TEXT,
  unit            TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('higher','lower')),
  raw_value       REAL,
  trials_json     TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'measured'
                    CHECK (status IN ('measured','aborted','skipped','contraindicated')),
  level           INTEGER CHECK (level IS NULL OR level BETWEEN 0 AND 4),
  index_value     REAL,
  note            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (assessment_id, item_code)
);
CREATE INDEX IF NOT EXISTS idx_fitness_results_assessment
  ON fitness_results(assessment_id, item_code);
CREATE INDEX IF NOT EXISTS idx_fitness_results_dimension
  ON fitness_results(dimension);

-- Down（人工回滚参考）
-- DROP TABLE IF EXISTS fitness_results;
-- DROP TABLE IF EXISTS fitness_assessments;
