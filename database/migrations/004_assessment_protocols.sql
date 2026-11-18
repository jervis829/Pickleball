-- P5-B: versioned stage-assessment protocols and immutable attempt snapshots.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS assessment_protocols (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  stage INTEGER NOT NULL CHECK (stage BETWEEN 1 AND 3),
  version INTEGER NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pilot','published','retired')),
  pathway TEXT NOT NULL DEFAULT 'general',
  age_group TEXT NOT NULL DEFAULT 'all',
  conditions_json TEXT NOT NULL,
  calibration_status TEXT NOT NULL DEFAULT 'coach_pilot_required'
    CHECK (calibration_status IN ('coach_pilot_required','calibrating','validated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(code, version)
);
CREATE INDEX IF NOT EXISTS idx_assessment_protocols_stage_status
  ON assessment_protocols(stage, status, version);

CREATE TABLE IF NOT EXISTS assessment_criteria (
  id TEXT PRIMARY KEY,
  protocol_id TEXT NOT NULL REFERENCES assessment_protocols(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('execution','decision','consistency','rules_safety')),
  is_required INTEGER NOT NULL DEFAULT 1 CHECK (is_required IN (0,1)),
  is_gate INTEGER NOT NULL DEFAULT 0 CHECK (is_gate IN (0,1)),
  order_index INTEGER NOT NULL DEFAULT 0,
  rubric_json TEXT NOT NULL,
  test_protocol_json TEXT NOT NULL,
  min_trials INTEGER,
  pass_rule_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(protocol_id, code)
);
CREATE INDEX IF NOT EXISTS idx_assessment_criteria_protocol
  ON assessment_criteria(protocol_id, order_index);

CREATE TABLE IF NOT EXISTS assessment_attempts (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  protocol_id TEXT NOT NULL REFERENCES assessment_protocols(id) ON DELETE RESTRICT,
  protocol_snapshot_json TEXT NOT NULL,
  assessment_date TEXT NOT NULL,
  lesson_number INTEGER CHECK (lesson_number IS NULL OR lesson_number BETWEEN 1 AND 48),
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  assessor_id TEXT,
  assessor_name TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','in_progress','submitted','cancelled')),
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('pending_review','achieved','partially_achieved','not_achieved','deferred')),
  retest_of_id TEXT REFERENCES assessment_attempts(id) ON DELETE RESTRICT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assessment_attempts_student_date
  ON assessment_attempts(student_id, assessment_date DESC);
CREATE INDEX IF NOT EXISTS idx_assessment_attempts_protocol
  ON assessment_attempts(protocol_id, assessment_date DESC);
CREATE INDEX IF NOT EXISTS idx_assessment_attempts_retest
  ON assessment_attempts(retest_of_id);

CREATE TABLE IF NOT EXISTS assessment_criterion_results (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES assessment_attempts(id) ON DELETE CASCADE,
  criterion_id TEXT REFERENCES assessment_criteria(id) ON DELETE SET NULL,
  criterion_code TEXT NOT NULL,
  criterion_snapshot_json TEXT NOT NULL,
  raw_trials_json TEXT NOT NULL DEFAULT '[]',
  score INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 4),
  achieved INTEGER CHECK (achieved IS NULL OR achieved IN (0,1)),
  observations TEXT,
  evidence_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(attempt_id, criterion_code)
);
CREATE INDEX IF NOT EXISTS idx_assessment_results_attempt
  ON assessment_criterion_results(attempt_id);

-- Conservative draft templates only. No numerical pass thresholds are published here.
INSERT OR IGNORE INTO assessment_protocols
(id,code,stage,version,name,status,pathway,age_group,conditions_json,calibration_status,created_at,updated_at)
VALUES
('AP-STAGE1-V1','stage1-foundation',1,1,'初阶出口：基本回合能力（教练试测稿）','draft','general','all',
 '{"standardization":"待教练定义并试测","court":"标准匹克球场","ball":"记录球型与状态","feed":"记录喂球方式、速度与落点","environment":"记录场地、天气及测试日期","safety":"先完成适宜性筛查；出现疼痛或不适立即停止","calibration":"不得自动判定晋级"}',
 'coach_pilot_required',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AP-STAGE2-V1','stage2-transition',2,1,'中阶出口：攻防转换与选择能力（教练试测稿）','draft','general','all',
 '{"standardization":"待教练定义并试测","court":"标准匹克球场","ball":"记录球型与状态","feed":"记录喂球/对抗条件","environment":"记录场地、天气及测试日期","safety":"先完成适宜性筛查；出现疼痛或不适立即停止","calibration":"不得自动判定晋级"}',
 'coach_pilot_required',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AP-STAGE3-V1','stage3-competitive',3,1,'高阶出口：比赛应用与适应能力（教练试测稿）','draft','general','all',
 '{"standardization":"待教练定义并试测","court":"标准匹克球场","ball":"记录球型与状态","feed":"记录对手/搭档及对抗条件","environment":"记录比分情境与测试日期","safety":"先完成适宜性筛查；出现疼痛或不适立即停止","calibration":"不得自动判定晋级"}',
 'coach_pilot_required',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

-- 初阶：直接覆盖发接发、基础击球、第三拍drop、dink、规则与移动。
INSERT OR IGNORE INTO assessment_criteria
(id,protocol_id,code,name,dimension,is_required,is_gate,order_index,rubric_json,test_protocol_json,min_trials,pass_rule_json,created_at,updated_at)
VALUES
('AC-S1-SERVE','AP-STAGE1-V1','serve_return','发球合法性与接发质量','execution',1,0,10,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"合法发球与接发球组合观察","record":["发球合法性","接发深度","接发后前移意识"],"trials":"待教练试测确定"}',NULL,'{"rule":"待教练试测校准；不得自动判定"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S1-GROUND','AP-STAGE1-V1','groundstrokes','正反手基础击球控制','execution',1,0,20,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"正反手基础击球","record":["准备姿势","击球点","方向与深度控制"],"trials":"待教练试测确定"}',NULL,'{"rule":"待教练试测校准；不得自动判定"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S1-DROP','AP-STAGE1-V1','third_shot_drop','第三拍drop基本弧线与落点','execution',1,1,30,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"第三拍drop情境","record":["弧线","落点","可重复性"],"trials":"待教练试测确定"}',NULL,'{"rule":"关键能力项；具体标准待教练试测校准"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S1-DINK','AP-STAGE1-V1','nvz_dink','NVZ dink控制与连续相持','consistency',1,1,40,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"NVZ基础dink相持","record":["弧线与落点","非截击区站位","连续相持质量"],"trials":"待教练试测确定"}',NULL,'{"rule":"关键能力项；具体标准待教练试测校准"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S1-RULE','AP-STAGE1-V1','rules_safety','两跳规则、发球规则与NVZ规则','rules_safety',1,1,50,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"规则问答与情境观察","record":["两跳规则","发球规则","NVZ规则","安全行为"],"trials":"待教练试测确定"}',NULL,'{"rule":"规则与安全门槛；具体标准待教练试测校准"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S1-MOVE','AP-STAGE1-V1','movement','分腿垫步、回中与安全制动','execution',1,0,60,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"多方向移动与回位","record":["分腿垫步时机","回中","安全制动"],"trials":"待教练试测确定"}',NULL,'{"rule":"待教练试测校准；不得自动判定"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

-- 中阶：重点验证选择、reset、截击选择和双打轮转。
INSERT OR IGNORE INTO assessment_criteria
(id,protocol_id,code,name,dimension,is_required,is_gate,order_index,rubric_json,test_protocol_json,min_trials,pass_rule_json,created_at,updated_at)
VALUES
('AC-S2-CHOICE','AP-STAGE2-V1','third_shot_choice','第三拍drop / drive / drip情境选择','decision',1,1,10,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"变化来球下第三拍选择","record":["来球识别","选择合理性","执行质量"],"trials":"待教练试测确定"}',NULL,'{"rule":"关键能力项；具体标准待教练试测校准"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S2-RESET','AP-STAGE2-V1','transition_reset','过渡区block / drop / half-volley reset','execution',1,1,20,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"过渡区连续防守与reset","record":["拍面稳定","球路高度","连续处理"],"trials":"待教练试测确定"}',NULL,'{"rule":"关键能力项；具体标准待教练试测校准"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S2-DINK','AP-STAGE2-V1','dink_variation','长短dink深度与节奏变化','consistency',1,0,30,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"长短dink组合","record":["深度控制","节奏/旋转变化","回位"],"trials":"待教练试测确定"}',NULL,'{"rule":"待教练试测校准；不得自动判定"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S2-VOLLEY','AP-STAGE2-V1','volley_selection','block / punch / flick / roll volley选择','decision',1,1,40,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"不同高度与速度来球截击","record":["来球识别","击球方式选择","控制与风险"],"trials":"待教练试测确定"}',NULL,'{"rule":"关键能力项；具体标准待教练试测校准"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S2-LOB','AP-STAGE2-V1','lob_overhead','lob / overhead与bounce-it判断','decision',1,0,50,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"高球与lob情境判断","record":["高球识别","是否进攻/让球","安全执行"],"trials":"待教练试测确定"}',NULL,'{"rule":"待教练试测校准；不得自动判定"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S2-DOUBLES','AP-STAGE2-V1','doubles_rotation','双打stacking、沟通与轮转','decision',1,1,60,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"双打轮转情境","record":["站位","沟通","轮转时机"],"trials":"待教练试测确定"}',NULL,'{"rule":"关键能力项；具体标准待教练试测校准"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

-- 高阶：以真实回合中的战术应用、攻防转换和适应能力为核心。
INSERT OR IGNORE INTO assessment_criteria
(id,protocol_id,code,name,dimension,is_required,is_gate,order_index,rubric_json,test_protocol_json,min_trials,pass_rule_json,created_at,updated_at)
VALUES
('AC-S3-SERVE','AP-STAGE3-V1','serve_return_strategy','发接发策略与回合建立','decision',1,0,10,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"多种比分/对手条件下发接发","record":["目标选择","落点与质量","第三拍衔接"],"trials":"待教练试测确定"}',NULL,'{"rule":"待教练试测校准；不得自动判定"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S3-THIRD','AP-STAGE3-V1','third_fifth_decision','第三拍与第五拍连续决策','decision',1,1,20,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"发接发后连续决策","record":["来球识别","策略选择","连续执行"],"trials":"待教练试测确定"}',NULL,'{"rule":"关键能力项；具体标准待教练试测校准"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S3-NVZ','AP-STAGE3-V1','nvz_tempo','NVZ节奏旋转与可攻球识别','decision',1,1,30,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"NVZ开放相持","record":["节奏变化","旋转控制","可攻球识别"],"trials":"待教练试测确定"}',NULL,'{"rule":"关键能力项；具体标准待教练试测校准"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S3-TRANSITION','AP-STAGE3-V1','transition_attack_defense','过渡区防守到重新进攻转换','execution',1,1,40,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"过渡区多球与开放回合","record":["reset质量","回到平衡","反攻时机"],"trials":"待教练试测确定"}',NULL,'{"rule":"关键能力项；具体标准待教练试测校准"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S3-HANDS','AP-STAGE3-V1','hands_battle_counter','hands battle与counter选择','decision',1,0,50,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"网前提速与反提速","record":["准备姿势","反应与拍面","目标控制"],"trials":"待教练试测确定"}',NULL,'{"rule":"待教练试测校准；不得自动判定"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
('AC-S3-DOUBLES','AP-STAGE3-V1','doubles_adaptation','双打协同、比分与对手适应','decision',1,1,60,'{"scale":"0-4","anchors":["未观察/无法完成","需持续提示","部分达到","标准条件稳定达到","变化条件下稳定运用"],"calibration":"待教练试测校准"}','{"task":"情境化双打比赛","record":["搭档协同","比分管理","对手弱点适应"],"trials":"待教练试测确定"}',NULL,'{"rule":"关键能力项；具体标准待教练试测校准"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

-- Legacy assessments table is intentionally untouched.
