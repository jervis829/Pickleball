'use strict';
const http = require('node:http');
const { createContext, prepare, handleError, finalize } = require('./middlewares');
const { dispatch } = require('./routes');

function createServer() {
  return http.createServer(async (req, res) => {
    const ctx = createContext(req, res);
    res.on('finish', () => finalize(ctx));
    try {
      const ready = await prepare(ctx);
      if (!ready) return;
      await dispatch(ctx);
    } catch (err) {
      handleError(ctx, err);
    }
  });
}

module.exports = { createServer };
