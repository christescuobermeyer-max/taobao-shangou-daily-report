import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';
import {
  OUTPUT_HEADERS,
  extractOperatorRows,
  formatRawDataCell,
  buildOutputRow,
  isTargetReportResponse,
  isTargetShopRequest,
  parseReportResponse,
  getReportConfig,
  buildModelInput,
  writeOutputWorkbook,
  retryOperation,
  parseArgs,
  REPORT_TYPES,
  normalizeReportType,
  resolveReportPeriod,
  formatPeriodDataCell,
  buildReportModelInput,
  parseReportRequestPeriod,
  periodDatesEnding,
  aggregateDailyRows,
  resolveRequestedDailyData,
} from './isv-daily-report.mjs';

const firstShop = {
  shopId: '1330475849',
  shopName: '老碰私厨馆(汇川店)',
  groupName: 'B1群',
  operator: '王清月',
  sourceRow: 2,
};

const sourceRows = [
  ['合同编号', '签约门店ID', '签约门店名称', '微信群名', '运营'],
  [1, 1330475849, '老碰私厨馆(汇川店)', 'B1群', '王清月'],
  [2, 1334001820, '蛮掌柜罐罐米线(新桥路店)', 'B2群', '王清月'],
  [3, 9999999999, '其他门店', '其他群', '其他运营'],
];

test('extractOperatorRows keeps IDs as strings and applies operator limit', () => {
  assert.deepEqual(extractOperatorRows(sourceRows, '王清月', 2), [
    firstShop,
    {
      shopId: '1334001820',
      shopName: '蛮掌柜罐罐米线(新桥路店)',
      groupName: 'B2群',
      operator: '王清月',
      sourceRow: 3,
    },
  ]);
});

test('formatRawDataCell contains metadata and every raw field', () => {
  const text = formatRawDataCell({
    date: '20260716',
    sourceShop: firstShop,
    apiShopName: '老碰私厨馆(汇川店)',
    rawRow: {
      shop_id: 1330475849,
      shop_name: '老碰私厨馆(汇川店)',
      gross_amt: 123.45,
      last_week_gross_amt_diff: -10,
      nested: { a: '中文' },
    },
  });
  assert.match(text, /昨日日期：20260716/);
  assert.match(text, /门店ID：1330475849/);
  assert.match(text, /接口店铺名称：老碰私厨馆\(汇川店\)/);
  assert.match(text, /营业额：123\.45/);
  assert.match(text, /上周营业额变化值：-10/);
  assert.match(text, /嵌套字段：/);
  assert.doesNotMatch(text, /gross_amt/);
});

test('buildOutputRow uses the fixed six-column contract', () => {
  const row = buildOutputRow(firstShop, 'raw', 'report');
  assert.deepEqual(Object.keys(row), ['门店ID', '店铺名称', '运营', '昨日数据', '微信群名', '昨日日报']);
  assert.deepEqual(Object.values(row), ['1330475849', '老碰私厨馆(汇川店)', '王清月', 'raw', 'B1群', 'report']);
  assert.deepEqual(OUTPUT_HEADERS, Object.keys(row));
});

test('only the real report POST response is accepted', () => {
  assert.equal(
    isTargetReportResponse(
      'https://lsycm.alibaba.com/api/oShopAnalysis/open/general/pageQueryOpenOfflineDetails?bx_et=x',
      'POST',
    ),
    true,
  );
  assert.equal(
    isTargetReportResponse('https://fourier.taobao.com/ts?url=report', 'GET'),
    false,
  );
  assert.equal(
    isTargetReportResponse(
      'https://lsycm.alibaba.com/api/oShopAnalysis/open/general/pageQueryOpenOfflineDetails',
      'GET',
    ),
    false,
  );
});

test('shop response matching requires the requested shop ID in postData', () => {
  const request = {
    url: 'https://lsycm.alibaba.com/api/oShopAnalysis/open/general/pageQueryOpenOfflineDetails?bx_et=x',
    method: 'POST',
    postData: JSON.stringify({ pageNo: 1, searchWord: '1330475849' }),
  };
  assert.equal(isTargetShopRequest(request, '1330475849'), true);
  assert.equal(isTargetShopRequest(request, '1334001820'), false);
  assert.equal(isTargetShopRequest({ ...request, postData: '' }, '1330475849'), false);
  assert.equal(isTargetShopRequest({ ...request, method: 'GET' }, '1330475849'), false);
});

test('report periods use yesterday and the inclusive previous seven days', () => {
  assert.deepEqual(resolveReportPeriod('daily', new Date(2026, 6, 18, 8)), {
    reportType: REPORT_TYPES.DAILY,
    periodLabel: '昨日',
    dateType: 'day',
    beginDate: '20260717',
    endDate: '20260717',
  });
  assert.deepEqual(resolveReportPeriod('weekly', new Date(2026, 0, 3, 8)), {
    reportType: REPORT_TYPES.WEEKLY,
    periodLabel: '近7日',
    dateType: 'recent_7d',
    beginDate: '20251227',
    endDate: '20260102',
  });
  assert.equal(normalizeReportType(), 'daily');
  assert.throws(() => normalizeReportType('monthly'), /daily 或 weekly/);
});

test('weekly request matching requires shop, date type, and exact range', () => {
  const period = resolveReportPeriod('weekly', new Date(2026, 6, 18, 8));
  const request = {
    url: 'https://lsycm.alibaba.com/api/oShopAnalysis/open/general/pageQueryOpenOfflineDetails?bx_et=x',
    method: 'POST',
    postData: JSON.stringify({
      searchWord: '1330475849',
      dateType: 'recent_7d',
      beginDate: '20260711',
      endDate: '20260717',
    }),
  };
  assert.equal(isTargetShopRequest(request, '1330475849', period), true);
  assert.equal(isTargetShopRequest({ ...request, postData: JSON.stringify({ ...JSON.parse(request.postData), dateType: 'day' }) }, '1330475849', period), false);
  assert.equal(isTargetShopRequest({ ...request, postData: JSON.stringify({ ...JSON.parse(request.postData), beginDate: '20260710' }) }, '1330475849', period), false);
});

test('native page periods accept reporting lag while preserving exact period length', () => {
  const dailyRequest = {
    url: 'https://lsycm.alibaba.com/api/oShopAnalysis/open/general/pageQueryOpenOfflineDetails?bx_et=x',
    method: 'POST',
    postData: JSON.stringify({
      searchWord: '1330475849', dateType: 'day', dateTypeLabel: '昨日',
      beginDate: '20260716', endDate: '20260716',
    }),
  };
  assert.deepEqual(parseReportRequestPeriod(dailyRequest, '1330475849', 'daily'), {
    reportType: 'daily', periodLabel: '昨日', dateType: 'day',
    beginDate: '20260716', endDate: '20260716',
  });
  const weeklyBody = {
    searchWord: '1330475849', dateType: 'recent_7d', dateTypeLabel: '近7日',
    beginDate: '20260710', endDate: '20260716',
  };
  assert.deepEqual(parseReportRequestPeriod({ ...dailyRequest, postData: JSON.stringify(weeklyBody) }, '1330475849', 'weekly'), {
    reportType: 'weekly', periodLabel: '近7日', dateType: 'recent_7d',
    beginDate: '20260710', endDate: '20260716',
  });
  assert.equal(parseReportRequestPeriod({ ...dailyRequest, postData: JSON.stringify({ ...weeklyBody, beginDate: '20260709' }) }, '1330475849', 'weekly'), null);
});

test('daily data uses the page response when it matches the requested date', async () => {
  const requestedPeriod = resolveReportPeriod('daily', new Date(2026, 6, 18, 8));
  const captured = { row: { shop_id: 1 }, period: requestedPeriod, requestTemplate: {} };
  const result = await resolveRequestedDailyData({
    captured, requestedPeriod, shopId: '1', fetchHistoricalRow: async () => assert.fail('must not replay'),
  });
  assert.equal(result, captured);
});

test('daily data replays the exact requested date when the page period lags', async () => {
  const requestedPeriod = resolveReportPeriod('daily', new Date(2026, 6, 18, 8));
  const captured = {
    row: { shop_id: 1, gross_amt: 16 },
    period: { ...requestedPeriod, beginDate: '20260716', endDate: '20260716' },
    requestTemplate: { url: 'https://example.test', body: {} },
  };
  const calls = [];
  const result = await resolveRequestedDailyData({
    captured, requestedPeriod, shopId: '1', timeoutMs: 30000,
    fetchHistoricalRow: async (...args) => { calls.push(args); return { shop_id: 1, gross_amt: 17 }; },
  });
  assert.equal(result.row.gross_amt, 17);
  assert.equal(result.period, requestedPeriod);
  assert.equal(calls[0][3], '20260717');
});

test('daily data fails clearly when the requested date is unavailable', async () => {
  const requestedPeriod = resolveReportPeriod('daily', new Date(2026, 6, 18, 8));
  await assert.rejects(resolveRequestedDailyData({
    captured: {
      row: { shop_id: 1 },
      period: { ...requestedPeriod, beginDate: '20260716', endDate: '20260716' },
      requestTemplate: { url: 'https://example.test', body: {} },
    },
    requestedPeriod,
    shopId: '1',
    fetchHistoricalRow: async () => null,
  }), /平台尚未返回.*20260717/);
});

test('weekly formatting and model input identify the aggregate seven-day period', () => {
  const period = resolveReportPeriod('weekly', new Date(2026, 6, 18, 8));
  const rawRow = { shop_id: 1330475849, shop_name: firstShop.shopName, gross_amt: 700, exp_uv: 1000 };
  const data = formatPeriodDataCell({ period, sourceShop: firstShop, apiShopName: firstShop.shopName, rawRow });
  const input = buildReportModelInput(period, firstShop, rawRow);
  assert.match(data, /统计口径：近7日/);
  assert.match(data, /统计周期：20260711 至 20260717/);
  assert.match(data, /全部近7日数据/);
  assert.match(input, /近7日聚合指标摘要/);
  assert.doesNotMatch(input, /7 个单日趋势/);
});

test('weekly fallback builds an inclusive UTC date sequence across month boundaries', () => {
  assert.deepEqual(periodDatesEnding('20260301', 7), [
    '20260223', '20260224', '20260225', '20260226', '20260227', '20260228', '20260301',
  ]);
});

test('weekly fallback aggregates additive metrics and weighted conversion rates', () => {
  const dailyRows = [
    { date: '20260710', row: { shop_id: 1, shop_name: '店', gross_amt: 100, exp_uv: 100, clk_uv: 10, order_user_cnt: 2, valid_order_cnt: 2 } },
    { date: '20260711', row: { shop_id: 1, shop_name: '店', gross_amt: 200, exp_uv: 300, clk_uv: 30, order_user_cnt: 9, valid_order_cnt: 8 } },
  ];
  const result = aggregateDailyRows(dailyRows);
  assert.equal(result.gross_amt, 300);
  assert.equal(result.exp_uv, 400);
  assert.equal(result.order_user_cnt, 11);
  assert.equal(result.valid_order_cnt, 10);
  assert.equal(result.clk_exp_rate, 0.1);
  assert.equal(result.ord_clk_rate, 11 / 40);
  assert.equal(result.dailyRows.length, 2);
});

test('weekly aggregation skips missing dates and records them', () => {
  const result = aggregateDailyRows([
    { date: '20260717', row: { shop_id: 1, shop_name: '店', gross_amt: 100, exp_uv: 100, clk_uv: 10, order_user_cnt: 2 } },
    { date: '20260718', row: null },
  ]);
  assert.equal(result.gross_amt, 100);
  assert.deepEqual(result.missingDates, ['20260718']);
  assert.deepEqual(result.dailyRows.map((item) => item.date), ['20260717']);
});

test('parseReportResponse validates success and returns data rows', () => {
  assert.deepEqual(parseReportResponse(JSON.stringify({ code: 0, data: [{ shop_id: 1 }] })), [{ shop_id: 1 }]);
  assert.deepEqual(parseReportResponse(JSON.stringify({ code: 0, data: [] })), []);
  assert.throws(() => parseReportResponse('{bad json'), /invalid JSON/i);
  assert.throws(() => parseReportResponse(JSON.stringify({ code: 1, data: [] })), /code/i);
});

test('getReportConfig requires the API key and supplies documented defaults', () => {
  assert.deepEqual(getReportConfig({ VECTORENGINE_API_KEY: 'sk-test' }), {
    apiKey: 'sk-test',
    baseUrl: 'https://api.vectorengine.ai',
    model: 'gpt-5.6-luna',
  });
  assert.throws(() => getReportConfig({}), /VECTORENGINE_API_KEY/i);
});

test('buildModelInput contains metadata, raw JSON, and standardized metrics', () => {
  const input = buildModelInput('20260716', firstShop, {
    shop_id: 1330475849,
    shop_name: '老碰私厨馆(汇川店)',
    gross_amt: 123.45,
    exp_uv: 100,
    clk_uv: 10,
    clk_exp_rate: 0.1,
    order_user_cnt: 2,
    valid_order_cnt: 2,
    ord_clk_rate: 0.2,
    order_user_cnt_new: 1,
    order_user_cnt_old: 1,
  });
  assert.match(input, /20260716/);
  assert.match(input, /1330475849/);
  assert.match(input, /营业额：123\.45 元/);
  assert.doesNotMatch(input, /gross_amt/);
  assert.match(input, /营业额：123\.45 元/);
});

test('writeOutputWorkbook creates the six-column readable workbook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taobao-shangou-report-'));
  const output = join(dir, 'report.xlsx');
  try {
    writeOutputWorkbook(output, [buildOutputRow(firstShop, 'raw data', 'daily report')]);
    const workbook = XLSX.readFile(output);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
    assert.deepEqual(rows[0], OUTPUT_HEADERS);
    assert.deepEqual(rows[1], ['1330475849', '老碰私厨馆(汇川店)', '王清月', 'raw data', 'B1群', 'daily report']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retryOperation retries a failed API call and returns the later success', async () => {
  let attempts = 0;
  const result = await retryOperation(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('temporary API error');
    return 'success';
  }, { retries: 2, delayMs: 0 });
  assert.equal(result, 'success');
  assert.equal(attempts, 3);
});

test('retryOperation rethrows the final API error after retries are exhausted', async () => {
  let attempts = 0;
  await assert.rejects(
    retryOperation(async () => {
      attempts += 1;
      throw new Error('permanent API error');
    }, { retries: 2, delayMs: 0 }),
    /permanent API error/,
  );
  assert.equal(attempts, 3);
});

test('parseArgs converts retry flags to numbers', () => {
  const options = parseArgs([
    '--source', 'source.xlsx',
    '--api-retries', '4',
    '--api-retry-delay', '1500',
  ]);
  assert.equal(options.apiRetries, 4);
  assert.equal(options.apiRetryDelay, 1500);
});
