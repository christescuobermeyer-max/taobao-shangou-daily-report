import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_PROMPT,
  WEEKLY_SYSTEM_PROMPT,
  buildReportMessages,
} from './isv-report-lib.mjs';

test('daily report messages preserve the existing prompt contract', () => {
  const messages = buildReportMessages({ dataText: '昨日数据', reportType: 'daily' });
  assert.equal(messages[0].content, SYSTEM_PROMPT);
  assert.match(messages[1].content, /生成日报/);
  assert.match(messages[1].content, /昨日数据/);
});

test('weekly report messages use the dedicated weekly prompt and aggregate data wording', () => {
  const messages = buildReportMessages({
    dataText: '统计周期：20260711 至 20260717\n营业额：700',
    reportType: 'weekly',
  });
  assert.equal(messages[0].content, WEEKLY_SYSTEM_PROMPT);
  assert.match(messages[0].content, /运营周报/);
  assert.match(messages[1].content, /近7日运营数据生成周报/);
  assert.match(messages[1].content, /20260711 至 20260717/);
  assert.doesNotMatch(messages[1].content, /生成日报/);
});

test('report messages reject unsupported report types', () => {
  assert.throws(() => buildReportMessages({ dataText: '', reportType: 'monthly' }), /daily 或 weekly/);
});
