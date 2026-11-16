const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');
const https = require('node:https');
const { URL, URLSearchParams } = require('node:url');

const PORT = Number(process.env.PORT || 8080);
const BUS_KEY = process.env.DATA_GO_KR_BUS_KEY || '';
const RATE_LIMIT = Number(process.env.UPSTREAM_RATE_PER_MINUTE || 30);
const ODSAY_RATE_LIMIT = Number(process.env.ODSAY_RATE_PER_MINUTE || 20);
const VWORLD_RATE_LIMIT = Number(process.env.VWORLD_RATE_PER_MINUTE || 30);
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 10000);
const REQUIRE_HTTPS = process.env.REQUIRE_HTTPS === 'true';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const UPSTREAM_BASE = 'https://apis.data.go.kr/B551982/rte';
const ALLOWED_OPERATIONS = new Set(['mst_info', 'ps_info', 'rtm_loc_info']);
const CACHE_TTL_MS = {
  odsay: 30 * 1000,
  mst_info: 6 * 60 * 60 * 1000,
  ps_info: 60 * 60 * 1000,
  rtm_loc_info: 15 * 1000,
};

const cache = new Map();
const inFlight = new Map();
const rateBuckets = new Map();
const vworldInFlight = new Map();
const odsayInFlight = new Map();

function readServerConfig() {
  const configPath = process.env.VWORLD_CONFIG_PATH || path.join(__dirname, 'config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

const SERVER_CONFIG = readServerConfig();
const ODSAY_KEY = String(
  process.env.ODSAY_API_KEY ||
  SERVER_CONFIG.odsay?.apiKey ||
  SERVER_CONFIG.ODsay?.apiKey ||
  '',
);
const VWORLD_KEY = String(
  process.env.VWORLD_API_KEY || SERVER_CONFIG.vworld?.apiKey || '',
);
const VWORLD_REGISTERED_DOMAIN = String(
  process.env.VWORLD_REGISTERED_DOMAIN ||
  SERVER_CONFIG.vworld?.registeredDomain ||
  process.env.DEPLOY_PRIME_URL ||
  process.env.URL || '',
).trim();
const VWORLD_SEARCH_URL = 'https://api.vworld.kr/req/search';
const VWORLD_GEOCODER_URL = 'https://api.vworld.kr/req/address';
const ODSAY_ROUTE_URL = 'https://api.odsay.com/v1/api/searchPubTransPathT';

class ProxyError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsHeaders(),
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function corsHeaders() {
  return {
    'access-control-allow-origin': CORS_ORIGIN,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  };
}

function validateRequest(request) {
  if (request?.provider !== 'korea_precision_bus') {
    throw new ProxyError(404, 'PROVIDER_NOT_ALLOWED', '허용되지 않은 provider입니다.');
  }
  if (!ALLOWED_OPERATIONS.has(request.operation)) {
    throw new ProxyError(404, 'OPERATION_NOT_ALLOWED', '허용되지 않은 API operation입니다.');
  }
  const params = request.params || {};
  const regionCode = String(params.stdgCd || '');
  const pageNo = Number(params.pageNo || 1);
  const numOfRows = Number(params.numOfRows || 500);
  if (!/^\d{10}$/.test(regionCode)) {
    throw new ProxyError(400, 'INVALID_REGION_CODE', 'stdgCd는 10자리 숫자여야 합니다.');
  }
  if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > 100000) {
    throw new ProxyError(400, 'INVALID_PAGE', 'pageNo가 올바르지 않습니다.');
  }
  if (!Number.isInteger(numOfRows) || numOfRows < 1 || numOfRows > 1000) {
    throw new ProxyError(400, 'INVALID_PAGE_SIZE', 'numOfRows가 올바르지 않습니다.');
  }
  return { regionCode, pageNo, numOfRows };
}

function allowRequest(clientAddress, limit = RATE_LIMIT) {
  const now = Date.now();
  const current = rateBuckets.get(clientAddress);
  if (!current || now - current.startedAt >= 60_000) {
    rateBuckets.set(clientAddress, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function cacheKey(operation, params) {
  return `${operation}|${params.regionCode}|${params.pageNo}|${params.numOfRows}`;
}

function classifyUpstream(status, body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_) {
    parsed = null;
  }
  const header = parsed?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  const text = `${header?.errMsg || ''} ${header?.returnAuthMsg || ''} ${body}`.toUpperCase();
  const reasonCode = String(header?.returnReasonCode || '');
  if (reasonCode === '20' || text.includes('SERVICE_KEY') || text.includes('인증')) {
    return new ProxyError(401, 'UPSTREAM_AUTHENTICATION_ERROR', '공공데이터 API 인증에 실패했습니다.');
  }
  if (reasonCode === '22' || text.includes('LIMIT') || text.includes('QUOTA') || text.includes('호출량')) {
    return new ProxyError(429, 'UPSTREAM_QUOTA_EXCEEDED', '공공데이터 API 호출량 제한에 도달했습니다.');
  }
  if (status < 200 || status >= 300) {
    return new ProxyError(502, 'UPSTREAM_ERROR', '공공데이터 API가 오류를 반환했습니다.');
  }
  return null;
}

async function fetchUpstream(operation, params) {
  if (!BUS_KEY) {
    throw new ProxyError(503, 'SERVER_CONFIGURATION_ERROR', 'DATA_GO_KR_BUS_KEY가 서버에 설정되지 않았습니다.');
  }
  const url = new URL(`${UPSTREAM_BASE}/${operation}`);
  const query = new URLSearchParams({
    serviceKey: BUS_KEY,
    pageNo: String(params.pageNo),
    numOfRows: String(params.numOfRows),
    type: 'JSON',
    stdgCd: params.regionCode,
  });
  url.search = query.toString();

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const upstream = await fetch(url, { signal: controller.signal });
      const body = await upstream.text();
      const classified = classifyUpstream(upstream.status, body);
      if (classified && upstream.status >= 500 && attempt === 0) continue;
      if (classified) throw classified;
      return {
        status: upstream.status,
        contentType: upstream.headers.get('content-type') || 'application/json',
        body,
      };
    } catch (error) {
      lastError = error;
      if (error instanceof ProxyError) {
        if (error.status >= 500 && attempt === 0) continue;
        throw error;
      }
      if (attempt === 0) continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ProxyError(504, 'UPSTREAM_TIMEOUT', lastError?.message || '공공데이터 API 요청이 실패했습니다.');
}

async function fetchWithCache(operation, params) {
  const key = cacheKey(operation, params);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return { ...cached.value, cache: 'hit' };
  if (inFlight.has(key)) return { ...(await inFlight.get(key)), cache: 'coalesced' };
  const request = fetchUpstream(operation, params).then((value) => {
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS[operation] });
    return value;
  });
  inFlight.set(key, request);
  try {
    return { ...(await request), cache: 'miss' };
  } finally {
    inFlight.delete(key);
  }
}

function validateOdsayRequest(request) {
  if (request?.provider !== 'odsay') {
    throw new ProxyError(404, 'PROVIDER_NOT_ALLOWED', '허용되지 않은 provider입니다.');
  }
  if (request.operation !== 'searchPubTransPathT') {
    throw new ProxyError(404, 'OPERATION_NOT_ALLOWED', '허용되지 않은 ODsay operation입니다.');
  }
  if (!ODSAY_KEY) {
    throw new ProxyError(503, 'SERVER_CONFIGURATION_ERROR', 'ODsay 서버 설정이 완료되지 않았습니다.');
  }
  const input = request.params || {};
  const values = ['SX', 'SY', 'EX', 'EY'].map((name) => Number(input[name]));
  if (values.some((value, index) => !Number.isFinite(value) ||
      (index % 2 === 0
        ? value < -180 || value > 180
        : value < -90 || value > 90))) {
    throw new ProxyError(400, 'INVALID_COORDINATE', 'ODsay 좌표가 올바르지 않습니다.');
  }
  return {
    SX: values[0],
    SY: values[1],
    EX: values[2],
    EY: values[3],
    OPT: Number.isInteger(Number(input.OPT)) ? Number(input.OPT) : 0,
    SearchType: Number.isInteger(Number(input.SearchType)) ? Number(input.SearchType) : 0,
    SearchPathType: Number.isInteger(Number(input.SearchPathType)) ? Number(input.SearchPathType) : 0,
  };
}

function classifyOdsayResponse(status, body) {
  const parsed = safeJson(body);
  const error = parsed?.error || parsed?.result?.error;
  if (status === 401 || status === 403 || error) {
    return new ProxyError(401, 'ODSAY_AUTHENTICATION_ERROR', 'ODsay 인증에 실패했습니다.');
  }
  if (status === 429 || body.toUpperCase().includes('QUOTA') || body.includes('호출량')) {
    return new ProxyError(429, 'ODSAY_QUOTA_EXCEEDED', 'ODsay 호출량 제한에 도달했습니다.');
  }
  if (status < 200 || status >= 300) {
    return new ProxyError(502, 'ODSAY_UPSTREAM_ERROR', 'ODsay가 오류를 반환했습니다.');
  }
  if (!parsed || typeof parsed !== 'object') {
    return new ProxyError(502, 'ODSAY_INVALID_RESPONSE', 'ODsay 응답을 처리하지 못했습니다.');
  }
  return null;
}

async function fetchOdsay(params) {
  const query = new URLSearchParams({
    apiKey: ODSAY_KEY,
    lang: '0',
    output: 'json',
    SX: String(params.SX),
    SY: String(params.SY),
    EX: String(params.EX),
    EY: String(params.EY),
    OPT: String(params.OPT),
    SearchType: String(params.SearchType),
    SearchPathType: String(params.SearchPathType),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const upstream = await fetch(`${ODSAY_ROUTE_URL}?${query.toString()}`, {
        signal: controller.signal,
      });
      const body = await upstream.text();
      const classified = classifyOdsayResponse(upstream.status, body);
      if (classified && upstream.status >= 500 && attempt === 0) continue;
      if (classified) throw classified;
      return { status: upstream.status, contentType: 'application/json', body };
    } catch (error) {
      if (error instanceof ProxyError) {
        if (error.status >= 500 && attempt === 0) continue;
        throw error;
      }
      if (attempt === 0) continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ProxyError(504, 'ODSAY_TIMEOUT', 'ODsay 요청 시간이 초과되었습니다.');
}

async function fetchOdsayWithCache(params) {
  const key = `odsay|${JSON.stringify(params)}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cache: 'hit' };
  if (odsayInFlight.has(key)) {
    return { ...(await odsayInFlight.get(key)), cache: 'coalesced' };
  }
  const request = fetchOdsay(params).then((value) => {
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS.odsay });
    return value;
  });
  odsayInFlight.set(key, request);
  try {
    return { ...(await request), cache: 'miss' };
  } finally {
    odsayInFlight.delete(key);
  }
}

function validateVWorldRequest(request) {
  if (request?.provider !== 'vworld') {
    throw new ProxyError(404, 'PROVIDER_NOT_ALLOWED', '허용되지 않은 provider입니다.');
  }
  if (!['search', 'geocode', 'reverseGeocode'].includes(request.operation)) {
    throw new ProxyError(404, 'OPERATION_NOT_ALLOWED', '허용되지 않은 VWorld operation입니다.');
  }
  if (!VWORLD_KEY) {
    throw new ProxyError(503, 'SERVER_CONFIGURATION_ERROR', 'VWorld 서버 설정이 완료되지 않았습니다.');
  }
  if (request.operation === 'search') {
    const query = String(request.query || '').trim();
    const page = Number(request.page || 1);
    const size = Number(request.size || 10);
    const types = Array.isArray(request.types) ? request.types : ['PLACE', 'ROAD', 'PARCEL'];
    const allowedTypes = types.map((type) => String(type).toUpperCase())
      .filter((type) => ['PLACE', 'ROAD', 'PARCEL'].includes(type));
    if (query.length < 1 || query.length > 100) {
      throw new ProxyError(400, 'INVALID_QUERY', 'VWorld 검색어 길이가 올바르지 않습니다.');
    }
    if (!Number.isInteger(page) || page < 1 || page > 1000) {
      throw new ProxyError(400, 'INVALID_PAGE', 'VWorld 검색 페이지가 올바르지 않습니다.');
    }
    if (!Number.isInteger(size) || size < 1 || size > 100) {
      throw new ProxyError(400, 'INVALID_PAGE_SIZE', 'VWorld 검색 크기가 올바르지 않습니다.');
    }
    if (allowedTypes.length === 0) {
      throw new ProxyError(400, 'INVALID_SEARCH_TYPE', 'VWorld 검색 유형이 올바르지 않습니다.');
    }
    return { query, page, size, types: [...new Set(allowedTypes)] };
  }
  if (request.operation === 'geocode') {
    const address = String(request.address || '').trim();
    const type = String(request.type || 'ROAD').toUpperCase();
    if (address.length < 1 || address.length > 200) {
      throw new ProxyError(400, 'INVALID_ADDRESS', 'VWorld 주소 길이가 올바르지 않습니다.');
    }
    if (!['ROAD', 'PARCEL'].includes(type)) {
      throw new ProxyError(400, 'INVALID_ADDRESS_TYPE', 'VWorld 주소 유형이 올바르지 않습니다.');
    }
    return { address, type };
  }
  const coordinate = request.coordinate || {};
  const latitude = Number(coordinate.latitude);
  const longitude = Number(coordinate.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new ProxyError(400, 'INVALID_COORDINATE', 'VWorld 좌표가 올바르지 않습니다.');
  }
  return { latitude, longitude };
}

function safeJson(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function classifyVWorldResponse(status, body) {
  const parsed = safeJson(body);
  const responseStatus = String(parsed?.response?.status || '').toUpperCase();
  const text = body.toUpperCase();
  if (status === 401 || status === 403 || text.includes('INVALID_KEY') ||
      text.includes('SERVICE_KEY') || text.includes('인증')) {
    return new ProxyError(401, 'VWORLD_AUTHENTICATION_ERROR', 'VWorld 인증에 실패했습니다.');
  }
  if (status === 429 || text.includes('LIMIT') || text.includes('QUOTA') || text.includes('호출량')) {
    return new ProxyError(429, 'VWORLD_QUOTA_EXCEEDED', 'VWorld 호출량 제한에 도달했습니다.');
  }
  if (status < 200 || status >= 300 || responseStatus === 'ERROR') {
    const upstreamCode = String(parsed?.response?.error?.code || 'UNKNOWN')
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '')
      .slice(0, 64);
    console.error('VWorld upstream response rejected', {
      status,
      responseStatus: responseStatus || 'UNKNOWN',
      upstreamCode,
    });
    return new ProxyError(
      502,
      'VWORLD_UPSTREAM_ERROR',
      'VWorld 응답을 처리하지 못했습니다.',
      {
        upstreamStatus: status,
        upstreamResponseStatus: responseStatus || 'UNKNOWN',
        upstreamCode,
      },
    );
  }
  return null;
}

async function fetchVWorld(url, params, keyName = 'key') {
  const query = new URLSearchParams({ ...params, [keyName]: VWORLD_KEY });
  const requestUrl = `${url}?${query.toString()}`;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers = {
        accept: 'application/json',
        'user-agent': 'chulgeun-server/0.8',
      };
      if (VWORLD_REGISTERED_DOMAIN) {
        headers.referer = VWORLD_REGISTERED_DOMAIN;
        headers.origin = VWORLD_REGISTERED_DOMAIN.replace(/\/$/, '');
      }
      let upstreamStatus;
      let body;
      try {
        const upstream = await fetch(requestUrl, {
          signal: controller.signal,
          headers,
        });
        upstreamStatus = upstream.status;
        body = await upstream.text();
      } catch (error) {
        console.error('VWorld upstream fetch failed; trying IPv4 fallback', {
          host: new URL(url).host,
          attempt: attempt + 1,
          errorName: error?.name || 'UnknownError',
          errorCode: error?.cause?.code || error?.code || 'UNKNOWN',
        });
        const fallback = await fetchVWorldOverIpv4(requestUrl, headers);
        upstreamStatus = fallback.status;
        body = fallback.body;
      }
      const classified = classifyVWorldResponse(upstreamStatus, body);
      if (classified && upstreamStatus >= 500 && attempt === 0) continue;
      if (classified) throw classified;
      return body;
    } catch (error) {
      lastError = error;
      if (!(error instanceof ProxyError)) {
        console.error('VWorld upstream network failure', {
          host: new URL(url).host,
          attempt: attempt + 1,
          errorName: error?.name || 'UnknownError',
          errorCode: error?.cause?.code || error?.code || 'UNKNOWN',
        });
      }
      if (error instanceof ProxyError) {
        if (error.status >= 500 && attempt === 0) continue;
        throw error;
      }
      if (attempt === 0) continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ProxyError(
    504,
    'VWORLD_UPSTREAM_NETWORK_ERROR',
    'VWorld 서버에 연결하지 못했습니다.',
  );
}

function fetchVWorldOverIpv4(requestUrl, headers) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      requestUrl,
      {
        headers,
        timeout: TIMEOUT_MS,
        lookup(hostname, _options, callback) {
          dns.lookup(hostname, { family: 4 }, callback);
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode || 0, body });
        });
        response.on('error', reject);
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error('VWorld IPv4 request timeout'));
    });
    request.on('error', reject);
  });
}

function vworldSearchCandidates(body) {
  const parsed = safeJson(body);
  const items = parsed?.response?.result?.items;
  const item = items && !Array.isArray(items) ? items.item : items;
  const values = Array.isArray(item) ? item : item ? [item] : [];
  return values.map((item) => {
    const address = item?.address || {};
    const point = item?.point || {};
    const road = String(address.road || '').trim();
    const parcel = String(address.parcel || '').trim();
    const selectedAddress = road || parcel;
    const x = Number(point.x);
    const y = Number(point.y);
    return {
      id: String(item?.id || ''),
      name: String(item?.title || selectedAddress),
      address: selectedAddress,
      latitude: Number.isFinite(y) && y >= -90 && y <= 90 ? y : null,
      longitude: Number.isFinite(x) && x >= -180 && x <= 180 ? x : null,
      addressType: road ? 'road' : parcel ? 'parcel' : 'unknown',
      source: 'vworld',
    };
  }).filter((item) => item.id && item.address);
}

function vworldGeocodeResult(body) {
  const parsed = safeJson(body);
  const point = parsed?.response?.result?.point || {};
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -180 || x > 180 || y < -90 || y > 90) {
    return { coordinate: null, source: 'vworld' };
  }
  return { coordinate: { latitude: y, longitude: x }, source: 'vworld' };
}

function flattenAddress(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const orderedKeys = ['text', 'level0', 'level1', 'level2', 'level3', 'level4L', 'level4A', 'level5', 'detail'];
  const values = orderedKeys.map((key) => value[key]).filter((entry) => typeof entry === 'string' && entry.trim());
  return values.join(' ').replace(/\s+/g, ' ').trim();
}

function findAddress(value, preferredKeys) {
  if (!value || typeof value !== 'object') return '';
  for (const [key, child] of Object.entries(value)) {
    if (preferredKeys.includes(key)) {
      const address = flattenAddress(child);
      if (address) return address;
    }
    if (child && typeof child === 'object') {
      const nested = findAddress(child, preferredKeys);
      if (nested) return nested;
    }
  }
  return '';
}

function vworldReverseResult(roadBody, parcelBody) {
  const road = safeJson(roadBody);
  const parcel = safeJson(parcelBody);
  return {
    roadAddress: findAddress(road, ['roadAddress', 'newAddress', 'road', 'text', 'address']),
    parcelAddress: findAddress(parcel, ['parcelAddress', 'jibunAddress', 'parcel', 'text', 'address']),
  };
}

async function fetchVWorldOperation(request) {
  const params = validateVWorldRequest(request);
  if (request.operation === 'search') {
    const calls = params.types.map((type) => {
      const isPlace = type === 'PLACE';
      return fetchVWorld(VWORLD_SEARCH_URL, {
        service: 'search',
        request: 'search',
        version: '2.0',
        crs: 'EPSG:4326',
        query: params.query,
        type: isPlace ? 'place' : 'address',
        ...(isPlace ? {} : { category: type.toLowerCase() }),
        size: String(params.size),
        page: String(params.page),
        format: 'json',
        errorFormat: 'json',
      });
    });
    const settled = await Promise.allSettled(calls);
    const responses = settled
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    if (responses.length === 0) {
      const failed = settled.find((result) => result.status === 'rejected');
      if (failed?.reason) throw failed.reason;
      throw new ProxyError(502, 'VWORLD_UPSTREAM_ERROR', 'VWorld 응답을 처리하지 못했습니다.');
    }
    const candidates = responses.flatMap(vworldSearchCandidates);
    const unique = new Map(candidates.map((candidate) => [
      `${candidate.id}|${candidate.address}|${candidate.latitude}|${candidate.longitude}`,
      candidate,
    ]));
    return { candidates: [...unique.values()], status: candidates.length ? 'OK' : 'NOT_FOUND' };
  }
  if (request.operation === 'geocode') {
    const body = await fetchVWorld(VWORLD_GEOCODER_URL, {
      service: 'address',
      request: 'getCoord',
      version: '2.0',
      crs: 'EPSG:4326',
      address: params.address,
      refine: 'true',
      simple: 'false',
      format: 'json',
      errorFormat: 'json',
      type: params.type.toLowerCase(),
    });
    return vworldGeocodeResult(body);
  }
  const body = await fetchVWorld(VWORLD_GEOCODER_URL, {
    service: 'address',
    request: 'getAddress',
    version: '2.0',
    crs: 'EPSG:4326',
    point: `${params.longitude},${params.latitude}`,
    type: 'both',
    zipcode: 'true',
    simple: 'false',
    format: 'json',
    errorFormat: 'json',
  });
  return vworldReverseResult(body, body);
}

async function handleVWorld(request, response, clientAddress) {
  if (!allowRequest(clientAddress, VWORLD_RATE_LIMIT)) {
    throw new ProxyError(429, 'VWORLD_PROXY_RATE_LIMIT', 'VWorld 프록시 요청량 제한에 도달했습니다.');
  }
  const key = JSON.stringify(request);
  if (vworldInFlight.has(key)) return vworldInFlight.get(key);
  const operation = fetchVWorldOperation(request);
  vworldInFlight.set(key, operation);
  try {
    return await operation;
  } finally {
    vworldInFlight.delete(key);
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new ProxyError(413, 'BODY_TOO_LARGE', '요청이 너무 큽니다.'));
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function handleRequest(request, response) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }
  if (REQUIRE_HTTPS && request.headers['x-forwarded-proto'] !== 'https') {
    sendJson(response, 400, { error: 'HTTPS_REQUIRED' });
    return;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }
  try {
    const body = await readBody(request);
    const parsed = JSON.parse(body);
    if (parsed?.provider === 'seoul_subway' || parsed?.provider === 'national_bus') {
      sendJson(response, 200, {
        updates: [],
        message: '기존 실시간 공급자 프록시를 별도로 연결해야 합니다.',
      });
      return;
    }
    if (parsed?.provider === 'odsay') {
      const clientAddress = request.socket.remoteAddress || 'unknown';
      if (!allowRequest(clientAddress, ODSAY_RATE_LIMIT)) {
        throw new ProxyError(429, 'ODSAY_PROXY_RATE_LIMIT', 'ODsay 프록시 요청량 제한에 도달했습니다.');
      }
      const params = validateOdsayRequest(parsed);
      const result = await fetchOdsayWithCache(params);
      response.writeHead(result.status, {
        'content-type': result.contentType,
        'cache-control': 'no-store',
        ...corsHeaders(),
        'x-proxy-cache': result.cache,
      });
      response.end(result.body);
      return;
    }
    if (parsed?.provider === 'vworld') {
      const clientAddress = request.socket.remoteAddress || 'unknown';
      const result = await handleVWorld(parsed, response, clientAddress);
      sendJson(response, 200, result);
      return;
    }
    const params = validateRequest(parsed);
    const clientAddress = request.socket.remoteAddress || 'unknown';
    if (!allowRequest(clientAddress)) {
      throw new ProxyError(429, 'PROXY_RATE_LIMIT', '프록시 요청량 제한에 도달했습니다.');
    }
    const result = await fetchWithCache(parsed.operation, params);
    response.writeHead(result.status, {
      'content-type': result.contentType,
      'cache-control': 'no-store',
      ...corsHeaders(),
      'x-proxy-cache': result.cache,
    });
    response.end(result.body);
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendJson(response, 400, { error: 'INVALID_JSON' });
      return;
    }
    const proxyError = error instanceof ProxyError
      ? error
      : new ProxyError(500, 'PROXY_ERROR', '프록시 내부 오류가 발생했습니다.');
    sendJson(response, proxyError.status, {
      error: proxyError.code,
      message: proxyError.message,
      ...(proxyError.details ? { details: proxyError.details } : {}),
    });
  }
}

if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`chulgeun_master API server listening on ${PORT}`);
  });
}

module.exports = { handleRequest };
