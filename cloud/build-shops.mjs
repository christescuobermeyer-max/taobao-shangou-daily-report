import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(process.env.SHOPS_SOURCE || 'E:\\christescuobermeyer\\taobaoshangou-shengxiaozhongdianpu\\淘宝闪购已建群_按运营分类.xlsx');
const outputPath = resolve(process.env.SHOPS_OUTPUT || join(projectDir, 'data', 'shops.json'));

if (!existsSync(sourcePath)) throw new Error(`源工作簿不存在：${sourcePath}`);
const workbook = XLSX.readFile(sourcePath, { cellDates: false, raw: true });
const shops = new Map();
for (const sheetName of workbook.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
  if (!rows.length) continue;
  const headers = rows[0].map((value) => String(value ?? '').trim());
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));
  for (const row of rows.slice(1)) {
    const shopId = String(row[index['签约门店ID']] ?? '').trim().replace(/\.0$/, '');
    const shopName = String(row[index['签约门店名称']] ?? '').trim();
    if (!/^\d{5,20}$/.test(shopId) || !shopName) continue;
    const item = {
      shopId,
      shopName,
      operator: String(row[index['运营']] ?? '').trim(),
      groupName: String(row[index['微信群名']] ?? '').trim(),
      sourceSheet: sheetName,
    };
    if (!shops.has(shopId)) shops.set(shopId, item);
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify([...shops.values()], null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`已生成 ${shops.size} 家门店：${outputPath}`);
