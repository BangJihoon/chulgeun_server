const { Readable } = require('node:stream');

const { handleRequest } = require('../server');

function requestBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}

module.exports = async (req, res) => {
  const request = Readable.from([requestBody(req)]);
  request.method = req.method || 'GET';
  request.headers = Object.fromEntries(
    Object.entries(req.headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value[0] : value,
    ]),
  );
  request.socket = req.socket || {
    remoteAddress: request.headers['x-forwarded-for'] || 'vercel',
  };

  await handleRequest(request, res);
};
