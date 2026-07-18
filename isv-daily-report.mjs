import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import XLSX from 'xlsx';
import {
  buildDataText,
  extractShopMetrics,
  generateReport,
  yesterdayYmd,
} from './isv-report-lib.mjs';

export const OUTPUT_HEADERS = ['门店ID', '店铺名称', '运营', '昨日数据', '微信群名', '昨日日报'];

const REPORT_ENDPOINT = '/api/oShopAnalysis/open/general/pageQueryOpenOfflineDetails';
const DEFAULT_BASE_URL = 'https://api.vectorengine.ai';
const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_SOURCE = 'E:\\christescuobermeyer\\taobaoshangou-shengxiaozhongdianpu\\淘宝闪购已建群_按运营分类.xlsx';

export const REPORT_TYPES = Object.freeze({ DAILY: 'daily', WEEKLY: 'weekly' });

function localYmd(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

export function normalizeReportType(value = REPORT_TYPES.DAILY) {
  const normalized = String(value || REPORT_TYPES.DAILY).trim().toLowerCase();
  if (![REPORT_TYPES.DAILY, REPORT_TYPES.WEEKLY].includes(normalized)) {
    throw new Error('reportType 必须是 daily 或 weekly');
  }
  return normalized;
}

export function resolveReportPeriod(reportType = REPORT_TYPES.DAILY, now = new Date()) {
  const normalizedType = normalizeReportType(reportType);
  const end = new Date(now);
  if (Number.isNaN(end.getTime())) throw new Error('报告日期无效');
  end.setHours(12, 0, 0, 0);
  end.setDate(end.getDate() - 1);
  const begin = new Date(end);
  if (normalizedType === REPORT_TYPES.WEEKLY) begin.setDate(begin.getDate() - 6);
  return {
    reportType: normalizedType,
    periodLabel: normalizedType === REPORT_TYPES.WEEKLY ? '近7日' : '昨日',
    dateType: normalizedType === REPORT_TYPES.WEEKLY ? 'recent_7d' : 'day',
    beginDate: localYmd(begin),
    endDate: localYmd(end),
  };
}

const FIELD_LABELS = {
  shop_id: '门店ID', shop_name: '店铺名称', city_name: '城市', date_type: '日期类型',
  gross_amt: '营业额', income_amt: '收入金额', actual_pay: '实付金额', expense_amt: '支出金额',
  per_actual_pay: '客单价', exp_uv: '曝光人数', exp_pv: '曝光次数', clk_uv: '进店人数', clk_pv: '进店次数',
  clk_exp_rate: '进店转化率', ord_clk_rate: '下单转化率', order_user_cnt: '下单人数',
  order_user_cnt_new: '新客下单人数', order_user_cnt_old: '老客下单人数', order_user_cnt_new_rate: '新客下单人数占比',
  valid_order_cnt: '有效订单数', onsale_item_cnt: '在售商品数', task_cnt: '任务数', is_new: '是否新店',
  avg_cooking_duration: '平均出餐时长', open_minutes: '营业时长（分钟）', peak_open_minutes: '高峰营业时长（分钟）',
  shop_score: '店铺评分', shop_growth_score: '店铺成长分', positive_comment_rate: '好评率',
  negative_reply_rate: '差评回复率', quality_entree_item_rate: '优质餐品率', abnormal_ord_rate: '异常订单率',
  shopduty_cancel_ord_rate: '商责取消订单率', shopduty_refund_ord_rate: '商责退款订单率',
  shopduty_overtime_cook_ord_rate: '商责出餐超时订单率', shopduty_remind_ord_rate: '商责催单率',
  rebuy_rate_7d: '7日复购率', rebuy_rate_30d: '30日复购率', rebuy_user_cnt_7d: '7日复购用户数',
  rebuy_user_cnt_30d: '30日复购用户数', peer_shop_cnt: '同行店铺数', shop_income_peer_rn: '店铺收入同行排名',
  shop_income_rn: '店铺收入排名', exp_uv_rn: '曝光人数排名', exp_uv_mall_avg: '曝光人数大盘平均',
  exp_uv_mall_avg_rank: '曝光人数大盘平均排名', clk_exp_rate_mall_avg: '进店转化率大盘平均',
  clk_exp_rate_mall_avg_rank: '进店转化率大盘平均排名', ord_clk_rate_mall_avg: '下单转化率大盘平均',
  ord_clk_rate_mall_avg_rank: '下单转化率大盘平均排名', mkt_act_ord_cnt: '营销活动订单数',
  mkt_act_ord_cnt_rate: '营销活动订单占比', mkt_act_ord_net_gmv: '营销活动订单净交易额',
  mkt_act_roi: '营销活动投入产出比', mkt_act_shop_subsidy_amt: '营销活动店铺补贴金额',
  mkt_online_act_cnt: '营销在线活动数', mkt_online_act_cnt_mall_avg: '营销在线活动数大盘平均',
  collect_with_gift_act: '收藏有礼活动', full_reduce_act: '满减活动', burst_burstord_act: '爆单活动',
  burst_burstord_shop_add: '爆单活动店铺加成', burst_burstord_crowd_shop_add: '爆单活动人群店铺加成',
  abnor_index_name_list: '异常指标名称列表', nested: '嵌套字段',
};

function cleanString(value) {
  return value == null ? '' : String(value).trim();
}

function numericString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  return cleanString(value);
}

export function extractOperatorRows(rows, operator, limit) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const headers = rows[0].map(cleanString);
  const indexes = Object.fromEntries(headers.map((header, index) => [header, index]));
  const required = ['签约门店ID', '签约门店名称', '微信群名', '运营'];
  for (const header of required) {
    if (indexes[header] == null) throw new Error(`源工作表缺少字段：${header}`);
  }

  const selected = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    if (cleanString(row[indexes['运营']]) !== operator) continue;
    const shopId = numericString(row[indexes['签约门店ID']]);
    if (!shopId) continue;
    selected.push({
      shopId,
      shopName: cleanString(row[indexes['签约门店名称']]),
      groupName: cleanString(row[indexes['微信群名']]),
      operator: cleanString(row[indexes['运营']]),
      sourceRow: index + 1,
    });
    if (limit != null && selected.length >= limit) break;
  }
  return selected;
}

function formatFieldValue(value) {
  if (value == null || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value, (_key, item) => (item === undefined ? null : item));
  return String(value);
}

function translateMetricName(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const tokenLabels = {
    abnor: '异常', abnormal: '异常', act: '活动', actual: '实付', add: '加成', amt: '金额', avg: '平均',
    burst: '爆单', burstord: '订单', cancel: '取消', city: '城市', clk: '进店', cnt: '数', collect: '收藏',
    comment: '评价', cook: '出餐', cooking: '烹饪', crowd: '人群', date: '日期', duration: '时长', entree: '餐品',
    exp: '曝光', expense: '支出', full: '满', gift: '礼', gmv: '交易额', gross: '营业', growth: '成长',
    id: 'ID', income: '收入', index: '指标', is: '是否', item: '商品', last: '上', list: '列表', mall: '大盘',
    minutes: '分钟', mkt: '营销', name: '名称', negative: '差评', net: '净', new: '新客', old: '老客', online: '在线',
    onsale: '在售', open: '营业', ord: '订单', order: '订单', overtime: '超时', pay: '支付', peak: '高峰',
    peer: '同行', per: '每单', period: '期', positive: '好评', pv: '次数', quality: '优质', rank: '排名', rate: '率',
    rebuy: '复购', reduce: '减免', refund: '退款', remind: '催单', reply: '回复', rn: '排名', roi: '投入产出比',
    score: '评分', shop: '店铺', shopduty: '商责', subsidy: '补贴', task: '任务', type: '类型', user: '用户',
    uv: '人数', valid: '有效', week: '周', with: '有', '7d': '7日', '30d': '30日',
  };
  return key.split('_').map((token) => tokenLabels[token] || '其他').join('') || '其他接口指标';
}

export function translateFieldName(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const weekDiff = /^last_week_(.+)_diff$/.exec(key);
  if (weekDiff) return `上周${translateMetricName(weekDiff[1])}变化值`;
  const periodDiff = /^last_period_(.+)_diff$/.exec(key);
  if (periodDiff) return `上期${translateMetricName(periodDiff[1])}变化值`;
  return translateMetricName(key);
}

export function formatRawDataCell({ date, sourceShop, apiShopName, rawRow }) {
  return [
    `昨日日期：${date}`,
    `门店ID：${sourceShop.shopId}`,
    `接口店铺名称：${cleanString(apiShopName) || '-'}`,
    '全部昨日数据（中文字段名称）：',
    ...Object.entries(rawRow).map(([key, value]) => `${translateFieldName(key)}：${formatFieldValue(value)}`),
  ].join('\n');
}

export function formatPeriodDataCell({ period, sourceShop, apiShopName, rawRow }) {
  if (period.reportType === REPORT_TYPES.DAILY) {
    return formatRawDataCell({ date: period.endDate, sourceShop, apiShopName, rawRow });
  }
  const dailyRows = Array.isArray(rawRow.dailyRows) ? rawRow.dailyRows : [];
  const aggregateEntries = Object.entries(rawRow).filter(([key]) => key !== 'dailyRows');
  return [
    `统计口径：${period.periodLabel}`,
    `统计周期：${period.beginDate} 至 ${period.endDate}`,
    `门店ID：${sourceShop.shopId}`,
    `源表店铺名称：${cleanString(sourceShop.shopName) || '-'}`,
    `接口店铺名称：${cleanString(apiShopName) || '-'}`,
    '全部近7日数据（中文字段名称）：',
    ...aggregateEntries.map(([key, value]) => `${translateFieldName(key)}：${formatFieldValue(value)}`),
    ...(dailyRows.length ? [
      '',
      '近7日逐日数据：',
      ...dailyRows.flatMap(({ date, row }) => [
        `日期：${date}`,
        ...Object.entries(row || {}).map(([key, value]) => `${translateFieldName(key)}：${formatFieldValue(value)}`),
        '',
      ]),
    ] : []),
  ].join('\n');
}

export function periodDatesEnding(endDate, count = 7) {
  const endDay = ymdDayNumber(endDate);
  if (endDay == null || !Number.isInteger(count) || count < 1) throw new Error('日期范围参数无效');
  const format = (day) => {
    const date = new Date(day * 86400000);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  };
  return Array.from({ length: count }, (_item, index) => format(endDay - count + 1 + index));
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function aggregateDailyRows(dailyRows) {
  if (!Array.isArray(dailyRows) || dailyRows.length === 0) throw new Error('周报缺少逐日数据');
  const first = dailyRows[0].row || {};
  const result = { ...first, dailyRows };
  const sumFields = ['gross_amt', 'income_amt', 'actual_pay', 'expense_amt', 'exp_uv', 'exp_pv', 'clk_uv', 'clk_pv',
    'order_user_cnt', 'order_user_cnt_new', 'order_user_cnt_old', 'valid_order_cnt', 'mkt_act_ord_cnt',
    'mkt_act_ord_net_gmv', 'mkt_act_shop_subsidy_amt', 'rebuy_user_cnt_7d', 'rebuy_user_cnt_30d'];
  for (const field of sumFields) result[field] = dailyRows.reduce((sum, item) => sum + numericValue(item.row?.[field]), 0);
  const exp = numericValue(result.exp_uv);
  const clk = numericValue(result.clk_uv);
  const orders = numericValue(result.order_user_cnt);
  result.clk_exp_rate = exp > 0 ? clk / exp : 0;
  result.ord_clk_rate = clk > 0 ? orders / clk : 0;
  result.shop_id = first.shop_id || first.shopId;
  result.shop_name = first.shop_name || first.shopName;
  result.date_type = 'recent_7d';
  return result;
}

export function buildOutputRow(sourceShop, rawText, report) {
  return {
    门店ID: sourceShop.shopId,
    店铺名称: sourceShop.shopName,
    运营: sourceShop.operator,
    昨日数据: rawText,
    微信群名: sourceShop.groupName,
    昨日日报: report,
  };
}

export function isTargetReportResponse(url, method) {
  return String(method).toUpperCase() === 'POST'
    && String(url).includes('lsycm.alibaba.com')
    && String(url).includes(REPORT_ENDPOINT);
}

function parseRequestPostData(postData) {
  const text = String(postData || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

export function isTargetShopRequest(request, shopId, period = null) {
  if (!isTargetReportResponse(request?.url, request?.method)) return false;
  const body = parseRequestPostData(request?.postData);
  if (!body || String(body.searchWord ?? '').trim() !== String(shopId).trim()) return false;
  if (!period) return true;
  return String(body.dateType || '') === period.dateType
    && String(body.beginDate || '') === period.beginDate
    && String(body.endDate || '') === period.endDate;
}

function ymdDayNumber(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Math.floor(timestamp / 86400000);
}

export function parseReportRequestPeriod(request, shopId, reportType) {
  if (!isTargetReportResponse(request?.url, request?.method)) return null;
  const body = parseRequestPostData(request?.postData);
  if (!body || String(body.searchWord ?? '').trim() !== String(shopId).trim()) return null;
  const normalizedType = normalizeReportType(reportType);
  const expectedDateType = normalizedType === REPORT_TYPES.WEEKLY ? 'recent_7d' : 'day';
  if (String(body.dateType || '') !== expectedDateType) return null;
  const beginDate = String(body.beginDate || '');
  const endDate = String(body.endDate || '');
  const beginDay = ymdDayNumber(beginDate);
  const endDay = ymdDayNumber(endDate);
  const expectedDays = normalizedType === REPORT_TYPES.WEEKLY ? 7 : 1;
  if (beginDay == null || endDay == null || endDay - beginDay + 1 !== expectedDays) return null;
  return {
    reportType: normalizedType,
    periodLabel: normalizedType === REPORT_TYPES.WEEKLY ? '近7日' : '昨日',
    dateType: expectedDateType,
    beginDate,
    endDate,
  };
}

export function parseReportResponse(body) {
  let response;
  try {
    response = JSON.parse(body);
  } catch {
    throw new Error('接口响应 invalid JSON');
  }
  if (response?.code !== 0) throw new Error(`门店分析接口返回异常 code=${response?.code ?? '-'}`);
  if (!Array.isArray(response.data)) throw new Error('门店分析接口响应缺少 data 数组');
  return response.data;
}

export function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const values = {};
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function getReportConfig(env) {
  const apiKey = cleanString(env.VECTORENGINE_API_KEY);
  if (!apiKey) throw new Error('缺少环境变量 VECTORENGINE_API_KEY');
  return {
    apiKey,
    baseUrl: cleanString(env.VECTORENGINE_BASE_URL) || DEFAULT_BASE_URL,
    model: cleanString(env.VECTORENGINE_MODEL) || DEFAULT_MODEL,
  };
}

export function buildModelInput(date, sourceShop, rawRow) {
  const apiShopName = rawRow.shop_name || rawRow.shopName || sourceShop.shopName;
  const rawText = formatRawDataCell({ date, sourceShop, apiShopName, rawRow });
  const metrics = extractShopMetrics(rawRow, date);
  return [
    '请根据以下淘宝闪购门店昨日原始数据和标准指标，生成一份可发送到微信群的运营日报。',
    '',
    rawText,
    '',
    '标准指标摘要：',
    buildDataText(metrics),
  ].join('\n');
}

export function buildReportModelInput(period, sourceShop, rawRow) {
  if (period.reportType === REPORT_TYPES.DAILY) return buildModelInput(period.endDate, sourceShop, rawRow);
  const apiShopName = rawRow.shop_name || rawRow.shopName || sourceShop.shopName;
  const rawText = formatPeriodDataCell({ period, sourceShop, apiShopName, rawRow });
  const metrics = extractShopMetrics(rawRow, period.endDate);
  return [
    `统计周期：${period.beginDate} 至 ${period.endDate}`,
    rawText,
    '',
    '近7日聚合指标摘要：',
    buildDataText(metrics),
  ].join('\n');
}

export async function retryOperation(operation, { retries = 2, delayMs = 3000, onRetry } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries) throw error;
      attempt += 1;
      if (onRetry) await onRetry({ attempt, error });
      if (delayMs > 0) await wait(delayMs);
    }
  }
}

function setWrappedText(sheet) {
  if (!sheet['!ref']) return;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      if (sheet[address]) {
        sheet[address].s = { alignment: { wrapText: true, vertical: 'top' } };
      }
    }
  }
}

export function writeOutputWorkbook(outputPath, rows) {
  const values = [OUTPUT_HEADERS, ...rows.map((row) => OUTPUT_HEADERS.map((header) => cleanString(row[header])))];
  const sheet = XLSX.utils.aoa_to_sheet(values);
  sheet['!cols'] = [
    { wch: 16 },
    { wch: 28 },
    { wch: 14 },
    { wch: 80 },
    { wch: 36 },
    { wch: 80 },
  ];
  sheet['!autofilter'] = { ref: `A1:F${Math.max(values.length, 1)}` };
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  setWrappedText(sheet);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '日报');
  XLSX.writeFile(workbook, outputPath);
}

function requestJson(port, requestPath, timeoutMs = 5000, method = 'GET') {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: requestPath, method }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Chrome CDP ${requestPath} 返回 HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolvePromise(JSON.parse(body));
        } catch {
          reject(new Error(`Chrome CDP ${requestPath} 返回了无效 JSON`));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Chrome CDP ${requestPath} 请求超时`)));
    request.on('error', (error) => reject(new Error(`无法连接 Chrome 调试端口 ${port}：${error.message}`)));
    request.end();
  });
}

export class ChromeSession {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.socket.on('message', (buffer) => this.handleMessage(JSON.parse(buffer.toString())));
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        reject(new Error('Chrome CDP WebSocket 建连超时'));
      }, 5000);
      this.socket.once('open', () => { clearTimeout(timer); resolvePromise(); });
      this.socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    return this;
  }

  handleMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    const handlers = this.listeners.get(message.method) || [];
    for (const handler of handlers) handler(message.params || {});
  }

  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolvePromise, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome CDP 命令超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  off(method, handler) {
    const handlers = this.listeners.get(method) || [];
    this.listeners.set(method, handlers.filter((item) => item !== handler));
  }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本执行失败');
    return result?.result?.value;
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Chrome CDP session closed'));
    }
    this.pending.clear();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForCondition(session, expression, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await session.evaluate(expression)) return;
    await wait(250);
  }
  throw new Error('淘宝闪购页面加载超时或未找到搜索门店名称/ID输入框');
}

export async function connectChromePage(port = 9222) {
  let targets = await requestJson(port, '/json');
  let page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl && target.url?.includes('open.shop.ele.me'))
    || targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) {
    const created = await requestJson(port, '/json/new?https%3A%2F%2Fopen.shop.ele.me%2Fmanager%2Fbase%2Fstore-analysis', 5000, 'PUT');
    page = created?.type === 'page' ? created : null;
    if (!page) {
      targets = await requestJson(port, '/json');
      page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    }
  }
  if (!page) throw new Error('Chrome 中没有可用的 page target，请先打开淘宝闪购服务商后台');
  const session = await new ChromeSession(page.webSocketDebuggerUrl).connect();
  await session.send('Runtime.enable');
  await session.send('Page.enable');
  await session.send('Network.enable');
  return { session, page };
}

export async function createChromeSession(port = 9222) {
  const { session } = await connectChromePage(port);
  const currentUrl = await session.evaluate('location.href');
  if (!String(currentUrl).includes('/manager/base/store-analysis')) {
    await session.send('Page.navigate', { url: 'https://open.shop.ele.me/manager/base/store-analysis' });
  }
  await waitForCondition(session, 'Boolean([...document.querySelectorAll("input")].find((e) => e.placeholder === "搜索门店名称/ID"))');
  return session;
}

export async function prepareChromeSession(session) {
  await waitForCondition(session, 'Boolean([...document.querySelectorAll("input")].find((e) => e.placeholder === "搜索门店名称/ID"))');
  const clicked = await session.evaluate(`(() => {
    const element = [...document.querySelectorAll('span,button,a,div')]
      .find((item) => item.children.length === 0 && item.innerText?.trim() === '昨日');
    if (!element) return false;
    element.click();
    return true;
  })()`);
  if (!clicked) throw new Error('淘宝闪购页面未找到“昨日”时间按钮');
  await wait(500);
}

export async function selectReportPeriod(session, period) {
  const target = period.periodLabel;
  const clicked = await session.evaluate(`(() => {
    const element = [...document.querySelectorAll('span,button,a,div')]
      .find((item) => item.children.length === 0 && item.offsetParent !== null && item.innerText?.trim() === ${JSON.stringify(target)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`淘宝闪购页面未找到“${target}”时间按钮`);
  await wait(500);
}

export async function fetchShopReportData(session, shopId, timeoutMs = 15000, period = null) {
  if (period) await selectReportPeriod(session, period);
  await session.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')]
      .find((element) => element.placeholder === '搜索门店名称/ID');
    if (!input) throw new Error('找不到搜索门店名称/ID输入框');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return true;
  })()`);
  await wait(500);

  return new Promise((resolvePromise, reject) => {
    let requestId = null;
    let actualPeriod = period;
    let requestTemplate = null;
    let finished = false;
    const timer = setTimeout(() => finish(new Error(`门店 ${shopId} 接口响应超时（${timeoutMs}ms）`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      session.off('Network.requestWillBeSent', onRequest);
      session.off('Network.loadingFinished', onFinished);
    };
    const finish = (error, row) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolvePromise(row ? { row, period: actualPeriod, requestTemplate } : { row: null, period: actualPeriod, requestTemplate });
    };
    const onRequest = (event) => {
      const request = event.request || {};
      const matchedPeriod = period ? parseReportRequestPeriod(request, shopId, period.reportType) : null;
      const requestBody = parseRequestPostData(request.postData);
      const laggedDailyMatch = period?.reportType === REPORT_TYPES.DAILY
        && isTargetShopRequest(request, shopId)
        && String(requestBody?.dateType || '') === 'day';
      if ((period && (matchedPeriod || laggedDailyMatch)) || (!period && isTargetShopRequest(request, shopId))) {
        requestId = event.requestId;
        if (matchedPeriod) actualPeriod = matchedPeriod;
        if (laggedDailyMatch) actualPeriod = {
          reportType: REPORT_TYPES.DAILY,
          periodLabel: '昨日',
          dateType: 'day',
          beginDate: String(requestBody.beginDate || ''),
          endDate: String(requestBody.endDate || ''),
        };
        if (!period) {
          const body = requestBody;
          if (String(body?.dateType || '') === 'day' && ymdDayNumber(body?.beginDate) != null
            && String(body.beginDate) === String(body.endDate)) {
            actualPeriod = {
              reportType: REPORT_TYPES.DAILY,
              periodLabel: '昨日',
              dateType: 'day',
              beginDate: String(body.beginDate),
              endDate: String(body.endDate),
            };
          }
        }
        requestTemplate = {
          url: request.url,
          headers: { ...(request.headers || {}) },
          body: parseRequestPostData(request.postData),
        };
      }
    };
    const onFinished = async (event) => {
      if (!requestId || event.requestId !== requestId) return;
      try {
        const body = await session.send('Network.getResponseBody', { requestId });
        const bodyText = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        const rows = parseReportResponse(bodyText);
        const row = rows.find((item) => String(item?.shop_id ?? item?.shopId ?? '').trim() === String(shopId).trim()) || null;
        finish(null, row);
      } catch (error) {
        finish(error);
      }
    };
    session.on('Network.requestWillBeSent', onRequest);
    session.on('Network.loadingFinished', onFinished);
    session.evaluate(`(() => {
      const input = [...document.querySelectorAll('input')]
        .find((element) => element.placeholder === '搜索门店名称/ID');
      if (!input) throw new Error('找不到搜索门店名称/ID输入框');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(shopId)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return true;
    })()`).catch((error) => finish(error));
  });
}

function replayHeaders(headers) {
  const forbidden = new Set(['accept-encoding', 'content-length', 'cookie', 'host', 'origin', 'referer', 'sec-fetch-dest',
    'sec-fetch-mode', 'sec-fetch-site', 'connection']);
  return Object.fromEntries(Object.entries(headers || {}).filter(([key]) => !forbidden.has(key.toLowerCase())));
}

export async function fetchHistoricalDailyRow(session, requestTemplate, shopId, date, timeoutMs = 15000) {
  if (!requestTemplate?.url || !requestTemplate?.body) throw new Error('缺少日报接口请求模板');
  const body = {
    ...requestTemplate.body,
    key: 'day',
    dateType: 'day',
    dateTypeLabel: '昨日',
    beginDate: date,
    endDate: date,
    searchWord: String(shopId),
  };
  const expression = `(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ${Number(timeoutMs)});
    try {
      const response = await fetch(${JSON.stringify(requestTemplate.url)}, {
        method: 'POST', credentials: 'include', signal: controller.signal,
        headers: ${JSON.stringify(replayHeaders(requestTemplate.headers))},
        body: ${JSON.stringify(JSON.stringify(body))}
      });
      return { status: response.status, text: await response.text() };
    } finally { clearTimeout(timer); }
  })()`;
  const response = await session.evaluate(expression, true);
  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error(`门店分析历史接口返回 HTTP ${response?.status ?? '-'}`);
  }
  const rows = parseReportResponse(response.text);
  return rows.find((item) => String(item?.shop_id ?? item?.shopId ?? '').trim() === String(shopId).trim()) || null;
}

export async function fetchWeeklyReportData(session, shopId, timeoutMs, requestedPeriod) {
  const native = await fetchShopReportData(session, shopId, timeoutMs, requestedPeriod);
  if (native?.row) return native;

  const dailyRequested = {
    reportType: REPORT_TYPES.DAILY,
    periodLabel: '昨日',
    dateType: 'day',
    beginDate: requestedPeriod.endDate,
    endDate: requestedPeriod.endDate,
  };
  await selectReportPeriod(session, dailyRequested);
  const latest = await fetchShopReportData(session, shopId, timeoutMs, null);
  if (!latest?.row || !latest?.period?.endDate || !latest.requestTemplate) {
    throw new Error(`门店 ${shopId} 未找到最新可用日报数据`);
  }
  const dates = periodDatesEnding(latest.period.endDate, 7);
  const rowsByDate = new Map([[latest.period.endDate, latest.row]]);
  for (const date of dates) {
    if (rowsByDate.has(date)) continue;
    const row = await fetchHistoricalDailyRow(session, latest.requestTemplate, shopId, date, timeoutMs);
    if (!row) throw new Error(`门店 ${shopId} 缺少 ${date} 日报数据，无法生成完整近7日周报`);
    rowsByDate.set(date, row);
  }
  const dailyRows = dates.map((date) => ({ date, row: rowsByDate.get(date) }));
  return {
    row: aggregateDailyRows(dailyRows),
    dailyRows,
    period: {
      reportType: REPORT_TYPES.WEEKLY,
      periodLabel: '近7日',
      dateType: 'recent_7d',
      beginDate: dates[0],
      endDate: dates[dates.length - 1],
    },
  };
}

export async function fetchShopRow(session, shopId, timeoutMs = 15000, period = null) {
  const result = await fetchShopReportData(session, shopId, timeoutMs, period);
  return result?.row || null;
}

function readSourceRows(sourcePath, sheetName) {
  const workbook = XLSX.readFile(sourcePath, { cellDates: false, raw: true });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`源工作簿没有工作表：${sheetName}`);
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
}

export function parseArgs(argv) {
  const options = {
    source: DEFAULT_SOURCE,
    sheet: '王清月',
    operator: '王清月',
    limit: undefined,
    port: 9222,
    out: undefined,
    date: undefined,
    delay: 2500,
    apiRetries: 2,
    apiRetryDelay: 3000,
    dryRun: false,
  };
  const valueFlags = new Map([
    ['--source', 'source'], ['--sheet', 'sheet'], ['--operator', 'operator'], ['--limit', 'limit'],
    ['--port', 'port'], ['--out', 'out'], ['--date', 'date'], ['--delay', 'delay'],
    ['--api-retries', 'apiRetries'], ['--api-retry-delay', 'apiRetryDelay'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (flag === '--help') return { help: true };
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`未知参数：${flag}`);
    const value = argv[++index];
    if (!value) throw new Error(`参数 ${flag} 缺少值`);
    options[key] = ['limit', 'port', 'delay', 'apiRetries', 'apiRetryDelay'].includes(key) ? Number(value) : value;
  }
  if (options.limit != null && (!Number.isInteger(options.limit) || options.limit < 1)) throw new Error('--limit 必须是正整数');
  if (!Number.isInteger(options.port) || options.port < 1) throw new Error('--port 必须是正整数');
  if (!Number.isInteger(options.delay) || options.delay < 0) throw new Error('--delay 必须是非负整数');
  if (!Number.isInteger(options.apiRetries) || options.apiRetries < 0) throw new Error('--api-retries 必须是非负整数');
  if (!Number.isInteger(options.apiRetryDelay) || options.apiRetryDelay < 0) throw new Error('--api-retry-delay 必须是非负整数');
  options.source = resolve(options.source);
  options.out = resolve(options.out || join(dirname(options.source), '淘宝闪购王清月日报测试.xlsx'));
  return options;
}

function printHelp() {
  console.log('用法：node isv-daily-report.mjs --operator 王清月 --limit 2 [选项]');
  console.log('选项：--source <xlsx> --sheet <name> --port <port> --out <xlsx> --date <yyyyMMdd> --delay <ms> --api-retries <n> --api-retry-delay <ms> --dry-run');
}

function isMainModule() {
  return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

async function run(options) {
  if (!existsSync(options.source)) throw new Error(`源工作簿不存在：${options.source}`);
  const sourceRows = readSourceRows(options.source, options.sheet);
  const shops = extractOperatorRows(sourceRows, options.operator, options.limit);
  if (shops.length === 0) throw new Error(`工作表 ${options.sheet} 中没有运营为“${options.operator}”的门店`);
  const env = { ...loadDotEnv(join(dirname(fileURLToPath(import.meta.url)), '.env')), ...process.env };
  const config = options.dryRun ? null : getReportConfig(env);
  const date = options.date || yesterdayYmd();
  const outputRows = [];
  let session;
  let failed = 0;
  try {
    session = await createChromeSession(options.port);
    await prepareChromeSession(session);
    for (let index = 0; index < shops.length; index += 1) {
      const sourceShop = shops[index];
      let rawText = '';
      let report = '';
      try {
        const rawRow = await retryOperation(
          () => fetchShopRow(session, sourceShop.shopId),
          {
            retries: options.apiRetries,
            delayMs: options.apiRetryDelay,
            onRetry: ({ attempt, error }) => console.warn(`↻ ${sourceShop.shopId} 取数接口重试 ${attempt}/${options.apiRetries}: ${error.message}`),
          },
        );
        if (!rawRow) throw new Error('未找到该门店或门店不属于当前服务商');
        const apiShopName = rawRow.shop_name || rawRow.shopName || sourceShop.shopName;
        rawText = formatRawDataCell({ date, sourceShop, apiShopName, rawRow });
        if (apiShopName !== sourceShop.shopName) console.warn(`⚠ 门店名称不一致 ${sourceShop.shopId}: Excel=${sourceShop.shopName}, API=${apiShopName}`);
        report = options.dryRun ? 'DRY-RUN：未调用大模型 API' : await retryOperation(
          () => generateReport({
            ...config,
            dataText: buildModelInput(date, sourceShop, rawRow),
          }),
          {
            retries: options.apiRetries,
            delayMs: options.apiRetryDelay,
            onRetry: ({ attempt, error }) => console.warn(`↻ ${sourceShop.shopId} 日报 API 重试 ${attempt}/${options.apiRetries}: ${error.message}`),
          },
        );
        console.log(`✅ ${sourceShop.shopId} ${sourceShop.shopName}`);
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        rawText ||= `昨日日期：${date}\n门店ID：${sourceShop.shopId}\n原始数据获取失败：${message}`;
        report ||= `日报生成失败：${message}`;
        console.error(`❌ ${sourceShop.shopId} ${sourceShop.shopName}: ${message}`);
      }
      outputRows.push(buildOutputRow(sourceShop, rawText, report));
      writeOutputWorkbook(options.out, outputRows);
      if (index < shops.length - 1) await wait(options.delay);
    }
  } finally {
    session?.close();
  }
  console.log(`输出文件：${options.out}`);
  console.log(`汇总：成功 ${shops.length - failed} 家，失败 ${failed} 家`);
  if (failed > 0) process.exitCode = 1;
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else await run(options);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
