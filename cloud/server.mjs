import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReportModelInput,
  connectChromePage,
  fetchDailyReportData,
  fetchWeeklyReportData,
  fetchShopRow,
  formatPeriodDataCell,
  getReportConfig,
  loadDotEnv,
  normalizeReportType,
  prepareChromeSession,
  resolveReportPeriod,
  retryOperation,
} from '../isv-daily-report.mjs';
import { generateReport } from '../isv-report-lib.mjs';
import { createConcurrencyLimiter, createKeyedDeduper } from './async-control.mjs';
import { createReportGateway, isValidRequestId } from './report-gateway.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const DATA_DIR = resolve(process.env.DATA_DIR || join(APP_DIR, 'data'));
const ENV_PATH = resolve(process.env.ENV_FILE || join(APP_DIR, '.env'));
const STORE_URL = 'https://open.shop.ele.me/manager/base/store-analysis';
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_PORT = 8792;
const DEFAULT_CDP_PORT = 9222;
const LOGIN_FAILURE_TEXT = /login|signin|登录|授权|失效/i;

const env = { ...loadDotEnv(ENV_PATH), ...process.env };
const config = {
  port: toPositiveInteger(env.APP_PORT, DEFAULT_PORT),
  cdpPort: toPositiveInteger(env.CHROME_DEBUG_PORT, DEFAULT_CDP_PORT),
  cookie: String(env.ELEME_ISV_COOKIE || '').trim(),
  cookieBundlePath: String(env.COOKIE_BUNDLE_PATH || '').trim(),
  ...getReportConfig(env),
  apiTimeoutMs: toPositiveInteger(env.REPORT_API_TIMEOUT_MS, 300000),
  apiRetries: toNonNegativeInteger(env.REPORT_API_RETRIES, 2),
  retryDelayMs: toNonNegativeInteger(env.REPORT_API_RETRY_DELAY_MS, 3000),
  browserTimeoutMs: toPositiveInteger(env.REPORT_BROWSER_TIMEOUT_MS, 30000),
  llmConcurrency: toPositiveInteger(env.REPORT_LLM_CONCURRENCY, 3),
};

const shops = loadShops(join(DATA_DIR, 'shops.json'));
const WEEKLY_SCHEDULE_PATH = join(DATA_DIR, 'weekly-schedule.json');
const browserLimiter = createConcurrencyLimiter(1);
const llmLimiter = createConcurrencyLimiter(config.llmConcurrency);
const reportDeduper = createKeyedDeduper();
const reportGateway = createReportGateway({
  metricsPath: join(DATA_DIR, 'gateway-metrics.json'),
  llmConcurrency: config.llmConcurrency,
  onPersistError: (error) => console.warn(`网关指标保存失败：${error.message}`),
});
const state = {
  session: null,
  sessionPromise: null,
  health: null,
  healthAt: 0,
  healthPromise: null,
  healthProbeOffset: 0,
  weeklySchedule: null,
};

function beijingNow() { return new Date(Date.now() + 8 * 60 * 60 * 1000); }
function compactDate(date) { return date.toISOString().slice(0, 10).replaceAll('-', ''); }
function currentWeekStart() {
  const date = beijingNow();
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((day + 6) % 7));
  return compactDate(date);
}
function nextResetAt() {
  const date = beijingNow();
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (8 - day) % 7 || 7);
  date.setUTCHours(0, 0, 0, 0);
  return new Date(date.getTime() - 8 * 60 * 60 * 1000).toISOString();
}
function loadWeeklySchedule() {
  const weekStart = currentWeekStart();
  let parsed = {};
  if (existsSync(WEEKLY_SCHEDULE_PATH)) {
    try { parsed = JSON.parse(readFileSync(WEEKLY_SCHEDULE_PATH, 'utf8')); } catch { parsed = {}; }
  }
  if (parsed.weekStart !== weekStart) {
    const history = parsed.history && typeof parsed.history === 'object' ? parsed.history : {};
    if (parsed.weekStart && parsed.sent && typeof parsed.sent === 'object') history[parsed.weekStart] = parsed.sent;
    parsed = { weekStart, sent: {}, history };
  }
  if (!parsed.sent || typeof parsed.sent !== 'object') parsed.sent = {};
  if (!parsed.history || typeof parsed.history !== 'object') parsed.history = {};
  state.weeklySchedule = parsed;
  writeFileSync(WEEKLY_SCHEDULE_PATH, JSON.stringify(parsed, null, 2));
  return parsed;
}
function getWeeklySchedule() { return state.weeklySchedule || loadWeeklySchedule(); }
function saveWeeklySchedule() { writeFileSync(WEEKLY_SCHEDULE_PATH, JSON.stringify(state.weeklySchedule, null, 2)); }

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function loadShops(filePath) {
  if (!existsSync(filePath)) throw new Error(`门店数据文件不存在：${filePath}`);
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed.shops;
  if (!Array.isArray(list)) throw new Error('shops.json 必须是门店数组或包含 shops 数组');
  const result = new Map();
  for (const item of list) {
    const shopId = String(item.shopId || '').trim();
    if (!/^\d{5,20}$/.test(shopId)) continue;
    result.set(shopId, {
      shopId,
      shopName: String(item.shopName || '').trim(),
      operator: String(item.operator || '').trim(),
      groupName: String(item.groupName || '').trim(),
      sourceSheet: String(item.sourceSheet || '').trim(),
    });
  }
  return result;
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) return null;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (!/^[\w-]+$/.test(name) || !value) return null;
      return { name, value, domain: '.ele.me', path: '/', secure: true };
    })
    .filter(Boolean);
}

function loadCookieSpecs() {
  if (config.cookieBundlePath && existsSync(config.cookieBundlePath)) {
    const parsed = JSON.parse(readFileSync(config.cookieBundlePath, 'utf8'));
    const cookies = Array.isArray(parsed) ? parsed : parsed.specs || parsed.cookies;
    if (Array.isArray(cookies) && cookies.length > 0) return cookies.map(normalizeCookieSpec).filter(Boolean);
  }
  return parseCookieHeader(config.cookie);
}

function normalizeCookieSpec(cookie) {
  if (!cookie || !cookie.name || cookie.value == null) return null;
  const sameSiteMap = {
    strict: 'Strict',
    lax: 'Lax',
    none: 'None',
    no_restriction: 'None',
  };
  const sameSite = sameSiteMap[String(cookie.sameSite || '').toLowerCase()];
  const expires = Number(cookie.expires ?? cookie.expirationDate);
  return {
    name: String(cookie.name),
    value: String(cookie.value),
    domain: String(cookie.domain || '.ele.me'),
    path: String(cookie.path || '/'),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    ...(sameSite ? { sameSite } : {}),
    ...(!cookie.session && Number.isFinite(expires) && expires > 0 ? { expires } : {}),
  };
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForStorePage(session, timeoutMs = 30000) {
  const started = Date.now();
  let lastInfo = null;
  while (Date.now() - started < timeoutMs) {
    lastInfo = await session.evaluate(`(() => ({
      url: location.href,
      title: document.title,
      hasSearch: Boolean([...document.querySelectorAll('input')].find((e) => e.placeholder === '搜索门店名称/ID')),
      loginVisible: Boolean([...document.querySelectorAll('input')].find((e) => e.placeholder === '服务商账号' && e.offsetParent !== null))
    }))()`);
    if (lastInfo?.hasSearch) return lastInfo;
    if (lastInfo?.loginVisible) throw new Error('淘宝闪购服务商 Cookie 无效，页面显示登录入口');
    if (LOGIN_FAILURE_TEXT.test(`${lastInfo?.url || ''} ${lastInfo?.title || ''}`)) {
      throw new Error('淘宝闪购服务商 Cookie 已失效或页面跳转到登录页');
    }
    await wait(500);
  }
  throw new Error(`淘宝闪购服务商页面加载超时：${lastInfo?.url || '未知页面'}`);
}

async function closeSession() {
  if (!state.session) return;
  try { state.session.close(); } catch { /* ignore close failure */ }
  state.session = null;
}

async function openAuthenticatedSession() {
  const cookieSpecs = loadCookieSpecs();
  if (cookieSpecs.length === 0) throw new Error('云端未配置淘宝闪购服务商 Cookie');
  await closeSession();
  const { session } = await connectChromePage(config.cdpPort);
  state.session = session;
  const current = await sessionPageInfo(session);
  if (current.hasSearch && !current.loginVisible) {
    await prepareChromeSession(session);
    return session;
  }
  await session.send('Network.setCookies', { cookies: cookieSpecs });
  await session.send('Page.navigate', { url: STORE_URL });
  await waitForStorePage(session);
  await prepareChromeSession(session);
  return session;
}

async function ensureSession() {
  if (state.session) {
    try {
      const info = await sessionPageInfo(state.session);
      if (info.hasSearch && !LOGIN_FAILURE_TEXT.test(`${info.url} ${info.title}`)) return state.session;
    } catch { /* recreate below */ }
    await closeSession();
  }
  if (!state.sessionPromise) {
    state.sessionPromise = openAuthenticatedSession().catch(async (error) => {
      await closeSession();
      throw error;
    }).finally(() => { state.sessionPromise = null; });
  }
  return state.sessionPromise;
}

async function sessionPageInfo(session) {
  return session.evaluate(`(() => ({
    url: location.href,
    title: document.title,
    hasSearch: Boolean([...document.querySelectorAll('input')].find((e) => e.placeholder === '搜索门店名称/ID')),
    loginVisible: Boolean([...document.querySelectorAll('input')].find((e) => e.placeholder === '服务商账号' && e.offsetParent !== null))
  }))()`);
}

function runLimited(limiter, type, key, task) {
  return limiter.run(async ({ waitMs }) => {
    const startedAt = Date.now();
    const startedStats = limiter.stats();
    console.log(`[${type}] 开始 key=${key} waitMs=${waitMs} active=${startedStats.active} pending=${startedStats.pending}`);
    try {
      return await task();
    } finally {
      const finishedStats = limiter.stats();
      console.log(`[${type}] 完成 key=${key} durationMs=${Date.now() - startedAt} active=${finishedStats.active} pending=${finishedStats.pending}`);
    }
  });
}

function reportErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Cookie|登录|授权|失效/i.test(message)) return 'AUTH_ERROR';
  if (/日报 API|大模型|模型/i.test(message)) return 'MODEL_ERROR';
  if (/门店|接口|Chrome|页面/i.test(message)) return 'DATA_ERROR';
  return 'REPORT_ERROR';
}

function getShop(shopId) {
  return shops.get(String(shopId || '').trim()) || null;
}

function weeklyScheduleResult(url) {
  const schedule = getWeeklySchedule();
  const operator = String(url.searchParams.get('operator') || '').trim();
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(url.searchParams.get('pageSize') || '20', 10) || 20));
  const list = [...shops.values()]
    .filter((shop) => !operator || shop.operator === operator)
    .sort((a, b) => a.shopId.localeCompare(b.shopId))
    .map((shop) => ({ ...shop, sentAt: schedule.sent[shop.shopId] || null, sent: Boolean(schedule.sent[shop.shopId]) }));
  const start = (page - 1) * pageSize;
  return { ok: true, weekStart: schedule.weekStart, resetAt: nextResetAt(), total: list.length, sentCount: list.filter((shop) => shop.sent).length, pendingCount: list.filter((shop) => !shop.sent).length, operators: [...new Set([...shops.values()].map((shop) => shop.operator).filter(Boolean))].sort(), page, pageSize, items: list.slice(start, start + pageSize) };
}

function markWeeklyScheduleSent(shopId) {
  const shop = getShop(shopId);
  if (!shop) return null;
  const schedule = getWeeklySchedule();
  schedule.sent[shop.shopId] = new Date().toISOString();
  saveWeeklySchedule();
  return { ...shop, sent: true, sentAt: schedule.sent[shop.shopId] };
}

function validateRequestedDate(period, bodyDate) {
  if (period.reportType === 'weekly' && bodyDate != null) {
    throw new Error('周报日期范围由服务端计算，不允许传 date');
  }
  if (period.reportType === 'daily' && bodyDate && String(bodyDate) !== period.endDate) {
    throw new Error(`只允许查询昨日数据，服务端昨日日期为 ${period.endDate}`);
  }
}

function publicResult(shop, period, periodData, report) {
  const result = {
    shopId: shop.shopId,
    shopName: shop.shopName,
    operator: shop.operator,
    groupName: shop.groupName,
    date: period.endDate,
    reportType: period.reportType,
    periodLabel: period.periodLabel,
    beginDate: period.beginDate,
    endDate: period.endDate,
    periodData,
    report,
  };
  if (period.reportType === 'weekly') result.weeklyData = periodData;
  else result.yesterdayData = periodData;
  return result;
}

async function createReport(shop, requestedPeriod, taskKey) {
  try {
    const captured = await runLimited(browserLimiter, 'browser', shop.shopId, async () => {
      reportGateway.transition(taskKey, 'fetching_browser');
      const session = await ensureSession();
      return requestedPeriod.reportType === 'weekly'
        ? fetchWeeklyReportData(session, shop.shopId, config.browserTimeoutMs, requestedPeriod)
        : fetchDailyReportData(session, shop.shopId, config.browserTimeoutMs, requestedPeriod);
    });
    const rawRow = captured?.row || null;
    const period = captured?.period || requestedPeriod;
    if (!rawRow) throw new Error('未找到该门店或门店不属于当前服务商');
    const apiShopId = String(rawRow.shop_id || rawRow.shopId || '').trim();
    if (apiShopId !== shop.shopId) throw new Error(`接口返回门店 ID 不一致：请求 ${shop.shopId}，返回 ${apiShopId || '-'}`);
    const apiShopName = String(rawRow.shop_name || rawRow.shopName || '').trim();
    const periodData = formatPeriodDataCell({ period, sourceShop: shop, apiShopName, rawRow });
    reportGateway.transition(taskKey, 'waiting_llm');
    const report = await runLimited(llmLimiter, 'llm', shop.shopId, () => {
      reportGateway.transition(taskKey, 'generating_llm');
      return retryOperation(
        () => generateReport({
          ...config,
          reportType: period.reportType,
          timeoutMs: config.apiTimeoutMs,
          dataText: buildReportModelInput(period, shop, rawRow),
        }),
        {
          retries: config.apiRetries,
          delayMs: config.retryDelayMs,
          onRetry: ({ attempt, error }) => console.warn(`${period.periodLabel}报告 API 重试 ${attempt}/${config.apiRetries} shop=${shop.shopId}：${error.message}`),
        },
      );
    });
    if (!report || !String(report).trim()) throw new Error('大模型返回空报告');
    const result = publicResult(shop, period, periodData, String(report).trim());
    reportGateway.transition(taskKey, 'completed');
    return result;
  } catch (error) {
    try {
      reportGateway.transition(taskKey, 'failed', { errorCode: reportErrorCode(error) });
    } catch (transitionError) {
      console.warn(`网关失败状态更新失败 shop=${shop.shopId}：${transitionError.message}`);
    }
    throw error;
  }
}

function createFreshReport(shop, period, taskKey) {
  return reportDeduper.run(taskKey, () => createReport(shop, period, taskKey));
}

async function performHealthCheck() {
  const session = await ensureSession();
  const page = await sessionPageInfo(session);
  if (!page.hasSearch) throw new Error('服务商页面缺少搜索门店名称/ID输入框');
  const probeShops = [...shops.keys()].slice(0, 3);
  let probe = null;
  for (let index = 0; index < probeShops.length; index += 1) {
    const candidateIndex = (state.healthProbeOffset + index) % probeShops.length;
    const shopId = probeShops[candidateIndex];
    const row = await fetchShopRow(session, shopId, 20000);
    if (row && String(row.shop_id || row.shopId || '') === shopId) {
      probe = shopId;
      state.healthProbeOffset = (candidateIndex + 1) % probeShops.length;
      break;
    }
  }
  if (!probe) throw new Error('Cookie 已注入，但真实服务商门店业务接口未返回可用数据');
  return {
    ok: true,
    loggedIn: true,
    chrome: true,
    storeAnalysisPage: true,
    probeShopId: probe,
    checkedAt: new Date().toISOString(),
  };
}

async function healthResult(force = false) {
  if (!force && state.health && Date.now() - state.healthAt < 30000) return state.health;
  if (state.healthPromise) return state.healthPromise;
  const healthPromise = runLimited(browserLimiter, 'health', 'service', performHealthCheck)
    .catch((error) => ({
      ok: false,
      loggedIn: false,
      chrome: Boolean(state.session),
      storeAnalysisPage: false,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    }))
    .then((result) => {
      state.health = result;
      state.healthAt = Date.now();
      return result;
    })
    .finally(() => {
      if (state.healthPromise === healthPromise) state.healthPromise = null;
    });
  state.healthPromise = healthPromise;
  return healthPromise;
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  };
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { ok: false, error: message });
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    let size = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => resolvePromise(body));
    request.on('error', reject);
  });
}

function contentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  return { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
}

function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const publicRoot = normalize(PUBLIC_DIR);
  const filePath = resolve(PUBLIC_DIR, relative);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    sendError(response, 400, '非法路径');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendError(response, 404, '页面不存在');
    return;
  }
  response.writeHead(200, { ...securityHeaders(), 'Content-Type': contentType(filePath), 'Cache-Control': 'no-cache' });
  response.end(readFileSync(filePath));
}

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { ...securityHeaders(), Allow: 'GET,POST,OPTIONS' });
    response.end();
    return;
  }
  if (url.pathname === '/api/health' && request.method === 'GET') {
    const result = await healthResult(url.searchParams.get('force') === '1');
    sendJson(response, result.ok ? 200 : 503, result);
    return;
  }
  if (url.pathname === '/api/gateway' && request.method === 'GET') {
    const requestId = String(url.searchParams.get('requestId') || '').trim();
    if (requestId && !isValidRequestId(requestId)) return sendError(response, 400, 'requestId 格式无效');
    sendJson(response, 200, reportGateway.snapshot(requestId));
    return;
  }
  if (url.pathname === '/api/weekly-schedule' && request.method === 'GET') {
    sendJson(response, 200, weeklyScheduleResult(url));
    return;
  }
  if (url.pathname === '/api/weekly-schedule/mark' && request.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(request)); } catch (error) { return sendError(response, 400, error.message || '提交内容无效'); }
    const item = markWeeklyScheduleSent(String(body?.shopId || '').trim());
    if (!item) return sendError(response, 404, '未找到该门店');
    sendJson(response, 200, { ok: true, item, schedule: weeklyScheduleResult(new URL('http://local/')) });
    return;
  }
  const shopMatch = /^\/api\/shop\/(\d{5,20})$/.exec(url.pathname);
  if (shopMatch && request.method === 'GET') {
    const shop = getShop(shopMatch[1]);
    if (!shop) return sendError(response, 404, '未找到该门店 ID');
    sendJson(response, 200, shop);
    return;
  }
  if (url.pathname === '/api/report' && request.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(request)); } catch (error) { return sendError(response, 400, error.message || '请求 JSON 无效'); }
    const shopId = String(body?.shopId || '').trim();
    if (!/^\d{5,20}$/.test(shopId)) return sendError(response, 400, '门店 ID 必须是 5-20 位数字');
    const requestId = body?.requestId == null ? '' : String(body.requestId).trim();
    if (requestId && !isValidRequestId(requestId)) return sendError(response, 400, 'requestId 格式无效');
    const shop = getShop(shopId);
    if (!shop) return sendError(response, 404, '未找到该门店 ID');
    let period;
    try {
      period = resolveReportPeriod(normalizeReportType(body?.reportType));
      validateRequestedDate(period, body?.date);
    } catch (error) {
      return sendError(response, 400, error.message);
    }
    const taskKey = `${period.reportType}-${shopId}-${period.beginDate}-${period.endDate}`;
    try {
      reportGateway.register({ key: taskKey, shopId, ...period, requestId });
      const result = await createFreshReport(shop, period, taskKey);
      sendJson(response, 200, result);
    } catch (error) {
      sendError(response, 502, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'GET') return serveStatic(response, url.pathname);
  sendError(response, 405, '不支持的请求方法');
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => sendError(response, 500, error instanceof Error ? error.message : String(error)));
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`淘宝闪购云端日报服务已启动：${config.port}，门店 ${shops.size} 家，浏览器并发 1，大模型并发 ${config.llmConcurrency}`);
});

export { server };

async function shutdown() {
  await closeSession();
  try { await reportGateway.flush(); } catch (error) { console.warn(`网关指标刷新失败：${error.message}`); }
  server.close(() => process.exit(0));
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
