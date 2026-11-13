'use strict';
const entities = require('../repositories/entities');
const { meta } = require('../repositories/misc');
const { validate, parsePaging } = require('../utils/validate');

const COMMON_ID = { type: 'string', maxLength: 64 };
const STAGE = { type: 'integer', min: 1, max: 3 };
const LESSON = { type: 'integer', min: 1, max: 48 };

const SCHEMAS = {
  students: {
    id: COMMON_ID,
    name: { type: 'string', required: true, maxLength: 60 },
    phone: { type: 'string', maxLength: 40 },
    age: { type: 'string', enum: ['adult', 'youth', 'senior', 'mixed'] },
    stage: STAGE,
    sizeLabel: { type: 'string', maxLength: 40 },
    total: { type: 'integer', min: 0, max: 999 },
    used: { type: 'integer', min: 0, max: 999 },
    expire: { type: 'string', maxLength: 20 },
    injury: { type: 'string', maxLength: 500 },
    techScore: { type: 'number', min: 0, max: 5 },
    fitScore: { type: 'number', min: 0, max: 5 },
    goal: { type: 'string', maxLength: 100 },
    status: { type: 'string', maxLength: 20 },
    note: { type: 'string', maxLength: 1000 }
  },
  plans: {
    id: COMMON_ID,
    lesson: { ...LESSON, required: true },
    stage: STAGE, tech: { type: 'string', maxLength: 200 },
    minutes: { type: 'integer', min: 30, max: 180 },
    date: { type: 'string', maxLength: 20 },
    age: { type: 'string', maxLength: 20 }, ageName: { type: 'string', maxLength: 20 },
    size: { type: 'string', maxLength: 20 }, zones: { type: 'json' },
    focus: { type: 'string', maxLength: 40 }, text: { type: 'string' },
    studentIds: { type: 'array' }
  },
  sessions: {
    id: COMMON_ID,
    studentId: { type: 'string', maxLength: 64 },
    date: { type: 'string', maxLength: 20 }, lesson: LESSON,
    minutes: { type: 'integer', min: 0, max: 300 },
    attend: { type: 'string', maxLength: 20 }, judge: { type: 'string', maxLength: 20 },
    rpe: { type: 'integer', min: 1, max: 10 }, note: { type: 'string', maxLength: 2000 }
  },
  assessments: {
    id: COMMON_ID,
    studentId: { type: 'string', maxLength: 64 }, stage: STAGE,
    date: { type: 'string', maxLength: 20 }, vals: { type: 'json' },
    total: { type: 'number' }, conclusion: { type: 'string', maxLength: 100 }
  }
};

const assertEntity = (name) => {
  if (!SCHEMAS[name]) throw new Error('未知实体：' + name);
  return SCHEMAS[name];
};

const list = (name, query) => entities.list(name, parsePaging(query));
const get = (name, id) => entities.find(name, id);
// 细粒度写操作同样递增 revision，保证与聚合同步共用一把乐观锁
const create = (name, body) => { const r = entities.create(name, validate(body, assertEntity(name))); meta.bump(); return r; };
const update = (name, id, body) => { const r = entities.update(name, id, validate(body, assertEntity(name), { partial: true })); meta.bump(); return r; };
const remove = (name, id) => { entities.remove(name, id); meta.bump(); };

module.exports = { SCHEMAS, list, get, create, update, remove };
