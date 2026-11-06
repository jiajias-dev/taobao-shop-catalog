#!/usr/bin/env node
/**
 * 给店铺宝贝补充详情字段：SKU 名称/价格/库存、原始价、到手价、包邮、发货地、时效、销售额估算
 *
 * 数据来源：店铺页里的 mtop 商详接口 mtop.taobao.pcdetail.data.get
 *   （比直接抓商详 HTML 稳定，不会触发滑块验证页）
 *
 * 用法：
 *   node enrich_shop_items.js --input out/shop_items.json --prefix out/shop --max-items 5
 *   node enrich_shop_items.js --input out/shop_items.json --prefix out/shop
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CDP = process.env.TB_CDP || 'http://127.0.0.1:9222';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseSales(text) {
  const m = String(text || '').match(/([\d.]+)\s*(万)?/);
  let n = m ? parseFloat(m[1]) : 0;
  if (m && m[2]) n *= 10000;
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(file, headers, rows) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(','));
  fs.writeFileSync(file, '﻿' + lines.join('\n') + '\n', 'utf8');
}

// 在店铺页里调用 mtop 商详接口，一次一条
async function fetchDetailInPage(id) {
  if (!window.lib || !window.lib.mtop) return { ok: false, item_id: id, error: 'no mtop' };
  const call = () => new Promise((resolve) => {
    const opts = {
      api: 'mtop.taobao.pcdetail.data.get',
      type: 'get', v: '1.0', ecode: 0, isSec: 0, timeout: 15000, dataType: 'json',
      sessionOption: 'AutoLoginAndManualLogin', needLogin: true, LoginRequest: true,
      jsonpIncPrefix: '_' + Date.now() + '_',
      data: JSON.stringify({ id }),
    };
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      window.lib.mtop.request(opts, (a) => done({ ok: true, payload: a }), (e) => {
        let msg = ''; try { msg = typeof e === 'string' ? e : JSON.stringify(e); } catch (_) { msg = String(e); }
        done({ ok: false, error: msg.slice(0, 400) });
      });
    } catch (e) {
      done({ ok: false, error: String(e).slice(0, 400) });
    }
    setTimeout(() => done({ ok: false, error: 'timeout' }), 18000);
  });

  const r = await call();
  if (!r.ok) return { ok: false, item_id: id, error: r.error };
  const d = (r.payload && r.payload.data) || {};
  if (!d.item) return { ok: false, item_id: id, error: 'no data.item' };

  const cvo = d.componentsVO || {};
  const pv = (cvo.priceVO && cvo.priceVO.price) || {};
  const dv = cvo.deliveryVO || {};
  const skuBase = d.skuBase || {};
  const sku2 = (d.skuCore && d.skuCore.sku2info) || {};

  const vidName = {};
  (skuBase.props || []).forEach((p) => (p.values || []).forEach((v) => { vidName[v.vid] = `${p.name}:${v.name}`; }));
  const skus = (skuBase.skus || []).map((s) => {
    const names = String(s.propPath || '').split(';').map((kv) => {
      const vid = kv.split(':')[1];
      return vidName[vid] || kv;
    });
    const info = sku2[s.skuId] || {};
    const p = info.price || {};
    return {
      sku_id: String(s.skuId),
      name: names.join(' / '),
      price: p.priceText != null ? Number(p.priceText) : null,
      price_money: p.priceMoney != null ? Number(p.priceMoney) : null,
      price_title: p.priceTitle || '',
      quantity: info.quantity != null ? Number(info.quantity) : null,
      quantity_text: info.quantityText || '',
      logistics: info.logisticsTime || '',
    };
  });
  const prices = skus.map((x) => x.price).filter((n) => Number.isFinite(n));
  const quantities = skus.map((x) => x.quantity).filter((n) => Number.isFinite(n));
  const saleable = skus.filter((x) => Number.isFinite(x.quantity) && x.quantity > 0);
  const saleablePrices = saleable.map((x) => x.price).filter((n) => Number.isFinite(n));

  return {
    ok: true,
    item_id: id,
    title: (d.item && d.item.title) || '',
    images: (d.item && d.item.images) || [],
    detail_price: pv.priceText != null ? Number(pv.priceText) : null,
    price_title: pv.priceTitle || '',
    price_desc: pv.priceDesc || '',
    price_action: pv.priceActionText || '',
    ship_from: dv.deliveryFromAddr || '',
    freight: dv.freight || '',
    delivery_time: dv.agingDesc || '',
    deliver_to: dv.deliveryToAddr || '',
    item_status: (d.skuCore && d.skuCore.skuItem && d.skuCore.skuItem.itemStatus),
    sku_count: skus.length,
    price_min: prices.length ? Math.min(...prices) : null,
    price_max: prices.length ? Math.max(...prices) : null,
    price_min_in_stock: saleablePrices.length ? Math.min(...saleablePrices) : null,
    price_max_in_stock: saleablePrices.length ? Math.max(...saleablePrices) : null,
    stock_total: quantities.reduce((a, b) => a + b, 0),
    skus,
  };
}

async function main() {
  const input = String(arg('input', ''));
  const prefix = String(arg('prefix', path.join(__dirname, 'out', 'shop')));
  const maxItems = Number(arg('max-items', 0));
  const delayMin = Number(arg('delay-min', 2500));
  const delayMax = Number(arg('delay-max', 4500));
  const batch = Number(arg('batch', 50));
  const cooldown = Number(arg('cooldown', 1200));
  const reportOnly = process.argv.includes('--report-only');
  if (!input || !fs.existsSync(input)) throw new Error('--input 文件不存在');

  const data = JSON.parse(fs.readFileSync(input, 'utf8'));
  const items = data.items || [];
  const progressFile = `${prefix}_progress.jsonl`;
  const done = new Map();
  if (fs.existsSync(progressFile)) {
    for (const line of fs.readFileSync(progressFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o && o.ok) done.set(String(o.item_id), o); } catch (_) {}
    }
  }
  console.log(`总商品 ${items.length}，已完成 ${done.size}，待处理 ${items.length - done.size}`);

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  let page = null;
  const shopUrl = data.shopUrl || 'https://www.taobao.com/';
  if (!reportOnly) {
    page = ctx.pages().find((p) => (p.url() || '').includes('taobao.com')) || ctx.pages()[0];
    await page.goto(shopUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);
  }

  let processed = 0;
  let errors = 0;
  let stopRequested = false;
  for (const it of (reportOnly ? [] : items)) {
    if (stopRequested) break;
    const id = String(it.item_id || '');
    if (!id || done.has(id)) continue;
    if (maxItems > 0 && processed >= maxItems) break;

    let rec = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        rec = await Promise.race([
          page.evaluate(fetchDetailInPage, id),
          sleep(30000).then(() => ({ ok: false, item_id: id, error: 'evaluate timeout' })),
        ]);
        if (rec && rec.ok) break;
      } catch (e) {
        rec = { ok: false, item_id: id, error: String(e).slice(0, 300) };
      }
      const limited = rec && /TIMEOUT|限流|BUSY|FAIL_SYS_TRAFFIC/i.test(String(rec.error || ''));
      if (limited) {
        console.log(`  接口限流，按规则立即停止（已完成 ${done.size} 条）`);
        stopRequested = true;
        break;
      } else if (rec && rec.error === 'evaluate timeout') {
        await page.goto(shopUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(4000);
        await sleep(1500 * attempt);
      } else {
        await sleep(1500 * attempt);
      }
    }
    if (stopRequested) break;
    if (!rec) rec = { ok: false, item_id: id, error: 'no result' };
    rec.catalog_title = it.title || '';
    rec.catalog_price = it.price != null ? Number(it.price) : null;
    rec.real_sales = it.realSales || '';
    rec.sales_low = parseSales(it.realSales);
    rec.procity = it.procity || '';
    rec.item_url = `https://detail.tmall.com/item.htm?id=${id}`;
    rec.pic = it.pic_path || '';
    rec.category = it.categoryp || '';
    rec.hot = (it.hotListInfo && it.hotListInfo.rank_short_text) || '';
    rec.usp = Array.isArray(it.structuredUSPInfo) ? it.structuredUSPInfo.map((x) => `${x.propertyName}:${x.propertyValueName}`).join(';') : '';
    rec.baoyou_icon = Array.isArray(it.icons) && it.icons.some((x) => x.alias === 'baoyounew' || x.text === '包邮');

    fs.appendFileSync(progressFile, JSON.stringify(rec) + '\n', 'utf8');
    done.set(id, rec);
    processed++;
    if (!rec.ok) errors++;
    if (processed % 20 === 0 || !rec.ok) {
      console.log(`  ${done.size}/${items.length}  ok=${rec.ok}  ${rec.ok ? (rec.title || '').slice(0, 24) : rec.error}`);
    }
    if (batch > 0 && processed % batch === 0) {
      console.log(`  已处理 ${processed} 条，关闭页面冷却 ${cooldown}s 后换新会话继续`);
      try { await page.close(); } catch (_) {}
      await sleep((cooldown + Math.random() * 600) * 1000);
      page = await ctx.newPage();
      await page.goto(shopUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(5000);
    }
    await sleep(delayMin + Math.random() * Math.max(0, delayMax - delayMin));
  }

  // 汇总
  const rows = [];
  const skuRows = [];
  for (const it of items) {
    const id = String(it.item_id || '');
    const got = done.get(id);
    const d = got || {
      ok: false,
      item_id: id,
      title: '',
      catalog_title: it.title || '',
      images: [],
      detail_price: null,
      catalog_price: it.price != null ? Number(it.price) : null,
      real_sales: it.realSales || '',
      sales_low: parseSales(it.realSales),
      procity: it.procity || '',
      item_url: `https://detail.tmall.com/item.htm?id=${id}`,
      pic: it.pic_path || '',
      category: it.categoryp || '',
      hot: (it.hotListInfo && it.hotListInfo.rank_short_text) || '',
      usp: Array.isArray(it.structuredUSPInfo) ? it.structuredUSPInfo.map((x) => `${x.propertyName}:${x.propertyValueName}`).join(';') : '',
      baoyou_icon: Array.isArray(it.icons) && it.icons.some((x) => x.alias === 'baoyounew' || x.text === '包邮'),
      skus: [],
    };
    const salesLow = d.sales_low || 0;
    const handPrice = d.catalog_price != null ? d.catalog_price : (d.ok ? d.detail_price : null);
    const est = handPrice != null ? +(salesLow * handPrice).toFixed(2) : null;
    rows.push({
      '商品ID': id,
      '标题': d.title || d.catalog_title || '',
      '商品链接': d.item_url,
      '商品主图': (d.images && d.images[0]) || d.pic || '',
      '原始价格(优惠前)': d.detail_price,
      '到手价(店铺列表)': d.catalog_price,
      '价格说明': it.priceShow && it.priceShow.priceDesc ? it.priceShow.priceDesc : '',
      'SKU最低价': d.price_min,
      'SKU最高价': d.price_max,
      'SKU数量': d.sku_count,
      '总库存': d.stock_total,
      '包邮': d.baoyou_icon || /免运费|卖家承担/.test(d.freight || '') ? '是' : '否',
      '运费': d.freight,
      '发货地': d.ship_from || d.procity || '',
      '预计送达': d.delivery_time,
      '付款人数': d.real_sales,
      '付款人数下限': salesLow,
      '估算销售额(到手价×付款人数)': est,
      '类目': d.category,
      '关键属性': d.usp,
      '热卖榜': d.hot,
      '采集状态': got ? (d.ok ? 'ok' : d.error) : '未采集详情',
    });
    if (got && d.ok && Array.isArray(d.skus)) {
      for (const s of d.skus) {
        skuRows.push({
          '商品ID': id,
          '标题': d.title || d.catalog_title || '',
          'SKU ID': s.sku_id,
          'SKU名称': s.name,
          'SKU价格': s.price,
          '价格说明': s.price_title,
          'SKU库存': s.quantity,
          '库存状态': s.quantity_text,
          '发货时效': s.logistics,
          '来源': '商详',
        });
      }
    } else if (Array.isArray(it.skuThumbList) && it.skuThumbList.length) {
      for (const s of it.skuThumbList) {
        skuRows.push({
          '商品ID': id,
          '标题': d.title || d.catalog_title || it.title || '',
          'SKU ID': s.skuId != null ? String(s.skuId) : '',
          'SKU名称': s.skuPropertyText || '',
          'SKU价格': '',
          '价格说明': '',
          'SKU库存': '',
          '库存状态': '',
          '发货时效': '',
          '来源': '店铺列表',
        });
      }
    }
  }

  const headers = ['商品ID', '标题', '商品链接', '商品主图', '原始价格(优惠前)', '到手价(店铺列表)', '价格说明', 'SKU最低价', 'SKU最高价', 'SKU数量', '总库存', '包邮', '运费', '发货地', '预计送达', '付款人数', '付款人数下限', '估算销售额(到手价×付款人数)', '类目', '关键属性', '热卖榜', '采集状态'];
  writeCsv(`${prefix}_items.csv`, headers, rows);
  writeCsv(`${prefix}_skus.csv`, ['商品ID', '标题', 'SKU ID', 'SKU名称', 'SKU价格', '价格说明', 'SKU库存', '库存状态', '发货时效', '来源'], skuRows);
  fs.writeFileSync(`${prefix}_full.json`, JSON.stringify({ source: input, count: rows.length, items: rows, skus: skuRows }, null, 1), 'utf8');
  console.log(JSON.stringify({ ok: true, processed, errors, totalDone: done.size, itemsCsv: `${prefix}_items.csv`, skusCsv: `${prefix}_skus.csv` }, null, 2));
  await browser.close();
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
