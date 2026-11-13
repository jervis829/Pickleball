'use strict';
const { ok, created, noContent } = require('../utils/response');
const auth = require('../services/auth');
const catalog = require('../services/catalog');
const stateSvc = require('../services/state');
const insights = require('../services/insights');
const { curriculum } = require('../repositories/misc');

function crud(entity) {
  return {
    list: ctx => ok(ctx.res, catalog.list(entity, ctx.query)),
    get: ctx => ok(ctx.res, catalog.get(entity, ctx.params.id)),
    create: ctx => created(ctx.res, catalog.create(entity, ctx.body)),
    update: ctx => ok(ctx.res, catalog.update(entity, ctx.params.id, ctx.body)),
    remove: ctx => { catalog.remove(entity, ctx.params.id); noContent(ctx.res); }
  };
}

const students = crud('students');
const plans = crud('plans');
const sessions = crud('sessions');
const assessments = crud('assessments');

module.exports = {
  health: ctx => ok(ctx.res, { status: 'ok', service: 'pickleball-academy', time: new Date().toISOString() }),
  login: ctx => ok(ctx.res, auth.login(ctx.body)),
  me: ctx => ok(ctx.res, auth.me(ctx)),
  changePassword: ctx => ok(ctx.res, auth.changePassword(ctx, ctx.body)),
  logout: ctx => noContent(ctx.res),
  stateGet: ctx => ok(ctx.res, stateSvc.get()),
  statePut: ctx => ok(ctx.res, stateSvc.put(ctx.body), 200, 'State synced'),
  exportAll: ctx => ok(ctx.res, stateSvc.exportAll()),
  importAll: ctx => ok(ctx.res, stateSvc.importAll(ctx.body), 200, 'Imported'),
  stats: ctx => ok(ctx.res, insights.overview()),
  studentRecords: ctx => ok(ctx.res, insights.studentRecords(ctx.params.id)),
  curriculum: ctx => ok(ctx.res, { units: curriculum.list(), lesson_count: curriculum.list().length * 2 }),
  students, plans, sessions, assessments
};
