module.exports = function ping(_request, response) {
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ status: 'ok', service: 'chulgeun-server' }));
};
