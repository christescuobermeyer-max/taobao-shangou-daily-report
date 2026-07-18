// 淘宝闪购服务商 · 门店昨日数据提取 + 日报生成 公共库
// 被 isv-daily-report.mjs 复用。不含硬编码密钥的执行逻辑，密钥由主脚本传入。
import { request as httpsRequest } from 'node:https';

// ---------- 昨日日期 (yyyyMMdd, 本地时区) ----------
export function yesterdayYmd() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// ---------- 从门店列表接口响应行提取昨日关键指标 ----------
// row = pageQueryOpenOfflineDetails.data[i]
export function extractShopMetrics(row, ymd) {
  const pct = (v) => (typeof v === 'number' ? (v * 100).toFixed(1) + '%' : '-');
  return {
    date: ymd,
    city: row.city_name || row.cityName || row.city || '-',
    shopName: row.shop_name || '-',
    shopId: row.shop_id || row.shopId || '-',
    grossAmt: row.gross_amt ?? '-',            // 营业额(元)
    incomeAmt: row.income_amt ?? '-',          // 收入(元)
    expUv: row.exp_uv ?? '-',                  // 曝光人数
    clkUv: row.clk_uv ?? '-',                  // 进店人数
    orderUserCnt: row.order_user_cnt ?? '-',   // 下单人数
    validOrderCnt: row.valid_order_cnt ?? '-', // 有效订单数
    clkExpRate: pct(row.clk_exp_rate),         // 进店转化率
    ordClkRate: pct(row.ord_clk_rate),         // 下单转化率
    orderUserNew: row.order_user_cnt_new ?? '-',
    orderUserOld: row.order_user_cnt_old ?? '-',
  };
}

// ---------- 组装给大模型的运营数据文本 ----------
export function buildDataText(m) {
  return [
    `日期：${m.date}`,
    `城市：${m.city}`,
    `店铺名称：${m.shopName}`,
    `店铺ID：${m.shopId}`,
    `营业额：${m.grossAmt} 元`,
    `曝光人数：${m.expUv} 人`,
    `入店人数：${m.clkUv} 人`,
    `入店转化率：${m.clkExpRate}`,
    `下单人数：${m.orderUserCnt} 人（新客 ${m.orderUserNew} / 老客 ${m.orderUserOld}）`,
    `下单转化率：${m.ordClkRate}`,
    `有效订单数：${m.validOrderCnt} 单`,
  ].join('\n');
}

export const SYSTEM_PROMPT = `您是一位专业的运营数据分析助手，专注于为淘宝闪购外卖店铺生成结构清晰、内容详实的运营日报简报，帮助商家优化运营策略。

## 能力
1. **数据提取与总结**：自动提取用户提供的运营数据，并总结关键指标。
2. **结构化分析**：生成结构化的日报简报内容，包括运营总览、数据总结、优势分析、劣势分析及改进建议。
3. **积极正向反馈**：使用积极正面的语言激励商家，提供切实可行的改进建议。

## 规则
1. **格式要求**：输出内容排版美观整齐，以纯文本格式输出。
2. **数据准确性**：确保所有数据项准确提取并清晰展示。
3. **结构化分析**：分析部分需分点详细阐述，逻辑清晰，内容积极正面。
4. **请不要回答与人设和内容无关的其他任何话题。**

## 工作流程
1. **接收数据**：接收用户提供的运营数据。
2. **提取关键指标**：提取日期、城市、店铺名称、店铺ID、营业额、曝光人数、入店人数、入店转化率、下单转化率、下单人数等关键指标。
3. **生成运营总览**：总结运营数据，生成简洁明了的运营总览。
4. **生成日报分析**：
   - **数据总结**：概括昨日在淘宝闪购平台的运营表现。
   - **优势分析**：指出在淘宝闪购运营中的亮点和优势。
   - **劣势分析**：识别在淘宝闪购平台存在的问题和不足。
   - **改进建议**：提供针对淘宝闪购平台具体、可操作的改进建议。
5. **输出日报简报**：生成排版美观、内容详实的运营日报简报，以纯文本格式输出。`;

export const WEEKLY_SYSTEM_PROMPT = `# 淘宝闪购外卖店铺运营周报生成助手

## 定位
您是一位专业的运营数据分析助手，专注于为淘宝闪购外卖店铺生成结构清晰、内容详实的运营周报，帮助商家优化运营策略。

## 能力
1. **数据提取与总结**：自动提取用户提供的运营数据，并总结关键指标。
2. **结构化分析**：生成结构化的周报内容，包括运营总览、数据总结、优势分析、劣势分析及改进建议。
3. **积极正向反馈**：使用积极正面的语言激励商家，提供切实可行的改进建议。

## 规则
1. **格式要求**：输出内容排版美观整齐，以纯文本格式输出。
2. **数据准确性**：确保所有数据项准确提取并清晰展示。
3. **结构化分析**：分析部分需分点详细阐述，逻辑清晰，内容积极正面。
4. **请不要回答与人设和内容无关的其他任何话题。**

## 工作流程
1. **接收数据**：接收用户提供的运营数据。
2. **提取关键指标**：提取日期、城市、店铺名称、店铺ID、营业额、曝光人数、入店人数、入店转化率、下单转化率、下单人数等关键指标。
3. **生成运营总览**：总结运营数据，生成简洁明了的运营总览。
4. **生成周报分析**：
   - **数据总结**：概括本周在淘宝闪购平台的运营表现。
   - **优势分析**：指出在淘宝闪购运营中的亮点和优势。
   - **劣势分析**：识别在淘宝闪购平台存在的问题和不足。
   - **改进建议**：提供针对淘宝闪购平台具体、可操作的改进建议。
5. **输出周报**：生成排版美观、内容详实的运营周报，以纯文本格式输出。`;

export function buildReportMessages({ dataText, reportType = 'daily' }) {
  if (!['daily', 'weekly'].includes(reportType)) throw new Error('reportType 必须是 daily 或 weekly');
  const weekly = reportType === 'weekly';
  return [
    { role: 'system', content: weekly ? WEEKLY_SYSTEM_PROMPT : SYSTEM_PROMPT },
    {
      role: 'user',
      content: weekly
        ? `请根据以下淘宝闪购门店近7日运营数据生成周报：\n\n${dataText}`
        : `请根据以下运营数据生成日报：\n\n${dataText}`,
    },
  ];
}

// ---------- 调用 OpenAI 兼容 API 生成日报或周报 ----------
export function generateReport({ baseUrl, apiKey, model, dataText, reportType = 'daily', timeoutMs = 300000 }) {
  const reportName = reportType === 'weekly' ? '周报' : '日报';
  const body = JSON.stringify({
    model,
    messages: buildReportMessages({ dataText, reportType }),
    temperature: 0.7,
  });
  const u = new URL('/v1/chat/completions', baseUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const req = httpsRequest(
      { hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let d = '';
        res.on('data', (x) => (d += x));
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.error) return settle(reject, new Error(JSON.stringify(j.error)));
            settle(resolve, j.choices?.[0]?.message?.content || JSON.stringify(j));
          } catch { settle(reject, new Error('parse fail: ' + d.slice(0, 300))); }
        });
        res.on('error', (error) => settle(reject, error));
      }
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`${reportName} API 请求超时（${timeoutMs}ms）`));
    }, timeoutMs);
    req.on('error', (error) => settle(reject, error));
    try {
      req.write(body);
      req.end();
    } catch (error) {
      settle(reject, error);
    }
  });
}
