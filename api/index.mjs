import { Readable } from 'node:stream';
import serverModule from '../server.js';

const { handleRequest } = serverModule;

function nodeRequestFrom(request, body) {
  const nodeRequest = Readable.from([body]);
  nodeRequest.method = request.method;
  nodeRequest.headers = Object.fromEntries(request.headers.entries());
  nodeRequest.socket = { remoteAddress: 'vercel' };
  return nodeRequest;
}

function nodeResponseCollector() {
  let status = 200;
  let headers = {};
  let body = '';

  return {
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      headers = nextHeaders;
    },
    end(nextBody = '') {
      body = Buffer.isBuffer(nextBody) ? nextBody.toString('utf8') : String(nextBody);
    },
    result() {
      return { status, headers, body };
    },
  };
}

export default {
  async fetch(request) {
    const body = await request.text();
    const response = nodeResponseCollector();
    await handleRequest(nodeRequestFrom(request, body), response);
    const result = response.result();
    const responseBody = result.status === 204 || result.status === 304 ? null : result.body;
    return new Response(responseBody, {
      status: result.status,
      headers: result.headers,
    });
  },
};
