'use strict';
const repo = require('../repositories/state');
const { validate } = require('../utils/validate');
const { HttpError } = require('../utils/response');

const get = () => repo.readState();

function put(body) {
  const snapshot = body && body.state !== undefined ? body.state : body;
  const revision = body && body.revision !== undefined ? Number(body.revision) : null;
  if (!snapshot || typeof snapshot !== 'object') throw new HttpError(422, 'VALIDATION_ERROR', 'state 不能为空');
  return { revision: repo.replaceState(snapshot, revision) };
}

const exportAll = () => ({
  format: 'pickleball-academy/backup',
  version: 1,
  exported_at: new Date().toISOString(),
  state: repo.readState()
});

function importAll(body) {
  const snapshot = body && body.state !== undefined ? body.state : body;
  const revision = repo.replaceState(snapshot, null);
  return { revision, imported: true };
}

module.exports = { get, put, exportAll, importAll };
