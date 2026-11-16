module.exports = function ping(_request, response) {
  response.status(200).json({ status: 'ok', service: 'chulgeun-server' });
};
