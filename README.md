# 淘宝闪购批量日报与云端运营报告

这个目录包含阶段一 Excel 批量日报脚本，以及阶段二云端日报/周报运营系统。云端页面支持按门店 ID 生成昨日运营日报或近7日聚合运营周报。

## 目录内容

- `isv-daily-report.mjs`：批量读取 Excel、CDP 抓取昨日数据、调用大模型并输出 Excel。
- `isv-report-lib.mjs`：淘宝闪购日报公共库和日报 Prompt。
- `isv-daily-report.test.mjs`：纯函数和 Excel 输出测试，不访问真实 Chrome 或大模型。
- `cloud/server.mjs`：云端报告 API、浏览器串行取数、模型并发、缓存和任务网关。
- `cloud/public/index.html`：日报/周报模式切换、任务状态和报告结果页面。
- `.env`：当前本地运行配置，包含 Cookie 和大模型配置，禁止提交或外传。
- `.env.example`：迁移到新机器时的环境变量模板。
- `data/shops.json`：真实门店运行数据，禁止提交；格式参考 `data/shops.example.json`，也可通过 `cloud/build-shops.mjs` 生成。
- `淘宝闪购服务商批量日报系统-开发文档.md`：完整开发规格。
- `淘宝闪购服务商门店分析接口接入文档.md`：服务商接口抓包说明。
- `设计规格.md`、`实施计划.md`：本阶段的设计和执行记录。

## 安装

在本目录执行：

```bash
pnpm install --ignore-workspace
```

Node.js 要求为 18 或更高版本。Chrome 必须以调试端口启动，并保持淘宝闪购服务商账号登录：

```bash
chrome.exe --remote-debugging-port=9222 --user-data-dir="<独立profile路径>" https://open.shop.ele.me/manager/base/store-analysis
```

## 两家测试命令

```bash
node isv-daily-report.mjs --source "E:\christescuobermeyer\taobaoshangou-shengxiaozhongdianpu\淘宝闪购已建群_按运营分类.xlsx" --sheet "王清月" --operator "王清月" --limit 2 --out "E:\christescuobermeyer\taobaoshangou-shengxiaozhongdianpu\淘宝闪购王清月日报测试.xlsx"
```

本命令只处理王清月工作表第 2、3 行：

- `1330475849`：老碰私厨馆(汇川店)
- `1334001820`：蛮掌柜罐罐米线(新桥路店)

输出表固定包含 `门店ID`、`店铺名称`、`运营`、`昨日数据`、`微信群名`、`昨日日报` 六列。每家门店的 `昨日数据` 占一个单元格，内含日期、门店 ID、接口店铺名，以及全部原始字段对应的中文数据名称和原始值。

取数接口或大模型接口失败时，默认自动重试 2 次。可用 `--api-retries` 和 `--api-retry-delay` 调整次数与间隔。

## 环境变量

`.env` 中需要配置：

```text
ELEME_ISV_COOKIE=...
VECTORENGINE_API_KEY=...
VECTORENGINE_BASE_URL=https://api.vectorengine.ai
VECTORENGINE_MODEL=gpt-5.6-luna
```

脚本不会打印 Cookie 或 API Key。`secretkey`、`uniquekey`、`timestamp`、`bx_et` 和 `token` 由淘宝闪购页面运行时生成，不写入 `.env`。

## 本地测试

```bash
pnpm test
node --check isv-daily-report.mjs
node --check cloud/server.mjs
```

## 云端日报与周报

云端页面默认生成日报。切换“周报”后，服务端会在共享 Chrome 页面选择“近7日”，搜索目标门店，并只接受 `dateType=recent_7d`、起止日期和门店 ID 全部匹配的接口响应。

```http
POST /api/report
Content-Type: application/json

{"shopId":"1330475849","requestId":"request_example_1","reportType":"weekly"}
```

`reportType` 可取 `daily` 或 `weekly`，缺省保持 `daily`。日报与周报使用独立任务键，但共享浏览器并发 1 与模型并发 3。

服务端不读取或写入报告缓存。每次提交门店 ID 都会重新读取淘宝经营数据并生成报告，确保同一天平台数据延迟更新后再次查询也能获得最新结果。同一时刻对相同门店和周期的并发请求仍会共享正在执行的任务，任务完成后再次提交会重新取数。

真实联调前先确认 Chrome 调试端口可访问。测试完成后只检查两家门店生成的输出文件，不要直接去掉 `--limit 2` 执行全量任务。
