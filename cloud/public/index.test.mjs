import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const html = readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');
const markup = /<body[^>]*>([\s\S]*?)<\/body>/.exec(html)?.[1] || '';
const visibleMarkup = markup.replace(/<script[\s\S]*?<\/script>/gi, '');
const heroMarkup = /<section class=["']hero["']>([\s\S]*?)<\/section>/.exec(markup)?.[1] || '';

test('page contains the queue gateway summary, own task, and active task list', () => {
  for (const id of ['gateway', 'gatewayCurrent', 'gatewayGenerating', 'gatewayWaiting', 'gatewayAverage', 'myJob', 'gatewayJobs']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /日报生成进度/);
  assert.match(html, /本次日报/);
  assert.match(markup, /<section class=["']hero["'][\s\S]*?<\/section>\s*<section id=["']gateway["'] class=["']panel gateway gateway-panel/);
  assert.doesNotMatch(heroMarkup, /id=["']gateway["']/);
});

test('user-facing copy hides internal implementation terms', () => {
  assert.doesNotMatch(visibleMarkup, /Cookie|API Key|Cloud Session|日报生成网关|门店 ID|服务端|大模型/);
  assert.match(visibleMarkup, /安全读取/);
  assert.match(visibleMarkup, /日报生成进度/);
  assert.match(visibleMarkup, /门店编号/);
});

test('report requests carry a generated requestId and gateway polling is non-overlapping', () => {
  assert.match(html, /crypto\.randomUUID/);
  assert.match(html, /JSON\.stringify\(\{\s*shopId,\s*requestId/);
  assert.match(html, /reportType:\s*requestMode/);
  assert.match(html, /gatewayBusy/);
  assert.match(html, /setTimeout\(pollGateway/);
  assert.match(html, /document\.hidden\s*\?\s*5000/);
});

test('page defaults to daily and exposes an accessible daily-weekly mode switch', () => {
  assert.match(html, /<body data-mode=["']daily["']/);
  assert.match(html, /role=["']group["'] aria-label=["']报告类型["']/);
  assert.match(html, /id=["']modeDaily["'][^>]*aria-pressed=["']true["']/);
  assert.match(html, /id=["']modeWeekly["'][^>]*aria-pressed=["']false["']/);
  assert.match(html, /setMode\('daily'\)/);
  assert.match(html, /setMode\('weekly'\)/);
});

test('daily and weekly results are stored independently and mode controls lock while pending', () => {
  assert.match(html, /const results = \{ daily: null, weekly: null \}/);
  assert.match(html, /results\[requestMode\] = data/);
  assert.match(html, /renderResult\(results\[currentMode\]\)/);
  assert.match(html, /modeDaily'\)\.disabled = reportPending/);
  assert.match(html, /modeWeekly'\)\.disabled = reportPending/);
});

test('gateway renders server values as text and does not use innerHTML', () => {
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
  assert.match(html, /replaceChildren/);
  assert.match(html, /textContent/);
  assert.match(html, /aria-live=["']polite["']/);
});

test('gateway includes mobile and reduced-motion styles', () => {
  assert.match(html, /@media\(max-width:520px\)/);
  assert.match(html, /prefers-reduced-motion:\s*reduce/);
});

test('inline browser script has valid JavaScript syntax', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
});
