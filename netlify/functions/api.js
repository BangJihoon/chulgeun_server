const { Readable } = require('node:stream');
const { handleRequest } = require('../../server');

exports.handler = async (event) => {
  const requestBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const request = Readable.from([requestBody]);
  request.method = event.httpMethod || 'GET';
  request.headers = headers;
  request.socket = {
    remoteAddress: headers['x-nf-client-connection-ip'] || 'netlify',
  };

  let statusCode = 200;
  let responseHeaders = {};
  let responseBody = '';
  const response = {
    writeHead(status, nextHeaders = {}) {
      statusCode = status;
      responseHeaders = nextHeaders;
    },
    end(body = '') {
      responseBody = body;
    },
  };

  await handleRequest(request, response);
  return {
    statusCode,
    headers: responseHeaders,
    body: responseBody,
  };
};
