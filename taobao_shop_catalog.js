#!/usr/bin/env node
/**
 * 淘宝店铺全量宝贝链接采集
 *
 * 用法：
 *   node taobao_shop_catalog.js --shop-name "示例旗舰店"
 *   node taobao_shop_catalog.js --shop-id 67095450
 *   node taobao_shop_catalog.js --shop-url "https://shop67095450.taobao.com"
 *
 * 依赖：一个已登录淘宝的 Chrome，以 --remote-debugging-port=9222 启动。
 * 首次使用可运行：node taobao_shop_catalog.js --launch-login
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CDP = process.env.TB_CDP || 'http://127.0.0.1:9222';
const PROFILE = process.env.TB_PROFILE || path.join(process.env.HOME, '.tbshop-profile');
const OUT_DIR = path.join(__dirname, 'out');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (name) => process.argv.includes(`--${name}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min = 2500, max = 4500) => sleep(min + Math.random() * (max - min));
const norm = (s) => (s || '').replace(/\s+/g, '').replace(/[【】\[\]（）()]/g, '').toLowerCase();

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function connect() {
  try {
    const browser = await chromium.connectOverCDP(CDP);
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => (p.url() || '').includes('taobao.com')) || ctx.pages()[0];
    return { browser, ctx, page, launched: false };
  } catch (e) {
    if (!has('launch-login')) throw new Error(`无法连接 ${CDP}。请先运行：node taobao_shop_catalog.js --launch-login`);
    fs.mkdirSync(PROFILE, { recursive: true });
    const { spawn } = require('child_process');
    spawn(CHROME, [
      `--user-data-dir=${PROFILE}`,
      '--remote-debugging-port=9222',
      '--no-first-run',
      '--no-default-browser-check',
      'https://www.taobao.com',
    ], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const browser = await chromium.connectOverCDP(CDP);
        const ctx = browser.contexts()[0];
        const page = ctx.pages().find((p) => (p.url() || '').includes('taobao.com')) || ctx.pages()[0];
        return { browser, ctx, page, launched: true };
      } catch (_) {}
    }
    throw new Error('Chrome 启动超时');
  }
}

async function checkLogin(page) {
  await page.goto('https://www.taobao.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const text = await page.locator('body').innerText().catch(() => '');
  if (/亲，请登录|请登录/.test(text)) {
    await page.screenshot({ path: path.join(OUT_DIR, 'login-required.png') }).catch(() => {});
    return { ok: false, reason: '未登录', url: page.url() };
  }
  return { ok: true, url: page.url(), snippet: text.slice(0, 120) };
}

function extractShopCandidates() {
  const out = [];
  const seen = new Set();
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.href || '';
    const text = (a.innerText || a.textContent || a.getAttribute('title') || '').trim();
    if (!href || seen.has(href)) return;
    const isShop =
      /shop\d+\.taobao\.com/i.test(href) ||
      /\.tmall\.com/i.test(href) ||
      /store\.taobao\.com\/shop/i.test(href) ||
      /user_number_id=|seller_id=|shop_id=/i.test(href);
    if (!isShop) return;
    if (!text || text.length < 2) return;
    seen.add(href);
    out.push({ href, text: text.slice(0, 80) });
  });
  return out;
}

function idsFromUrl(url) {
  const out = {};
  let m;
  if ((m = url.match(/shop(\d+)\.taobao\.com/i))) out.shopId = m[1];
  if ((m = url.match(/(?:user_number_id|seller_id|shop_id)=(\d+)/i))) out.shopId = out.shopId || m[1];
  if ((m = url.match(/^https?:\/\/([a-z0-9-]+)\.tmall\.com/i))) out.handle = m[1];
  return out;
}

async function idsFromPage(page) {
  const html = await page.content().catch(() => '');
  const url = page.url();
  const out = idsFromUrl(url);
  const patterns = [
    [/"shopId"\s*:\s*"?(\d+)/i, 'shopId'],
    [/"sellerId"\s*:\s*"?(\d+)/i, 'sellerId'],
    [/"shop_id"\s*:\s*"?(\d+)/i, 'shopId'],
    [/"user_number_id"\s*:\s*"?(\d+)/i, 'sellerId'],
    [/shop_id=(\d+)/i, 'shopId'],
    [/seller_id=(\d+)/i, 'sellerId'],
    [/user_number_id=(\d+)/i, 'sellerId'],
  ];
  for (const [re, key] of patterns) {
    const m = html.match(re);
    if (m && !out[key]) out[key] = m[1];
  }
  return out;
}

async function resolveShop(page, name) {
  const q = encodeURIComponent(name);
  const urls = [
    `https://s.taobao.com/search?q=${q}&search_type=shop&tab=shop`,
    `https://s.taobao.com/search?q=${q}`,
  ];
  for (const url of urls) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 1200).catch(() => {});
      await page.waitForTimeout(1200);
    }
    const candidates = await page.evaluate(extractShopCandidates).catch(() => []);
    const scored = candidates
      .map((c) => ({ ...c, score: norm(c.text).includes(norm(name)) || norm(name).includes(norm(c.text)) ? 2 : 1 }))
      .sort((a, b) => b.score - a.score);
    console.log(`[resolve] ${url}\n  候选 ${candidates.length} 个`);
    for (const c of scored.slice(0, 8)) console.log(`  - ${c.text} => ${c.href}`);

    for (const c of scored.slice(0, 5)) {
      let info = idsFromUrl(c.href);
      if (info.shopId || info.handle) {
        return { input: name, shopId: info.shopId, handle: info.handle, shopUrl: c.href, matchedText: c.text };
      }
      // 链接里没有 ID：打开店铺页从 HTML 里挖
      await page.goto(c.href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
      info = await idsFromPage(page);
      if (info.shopId || info.handle) {
        return { input: name, ...info, shopUrl: page.url(), matchedText: c.text };
      }
    }
  }
  return { input: name, error: '未解析到 shopId' };
}

async function extractItems() {
  // 优先店铺商品网格：老版店铺页是 dl.item，新版可能用 [class*=item] 卡片
  let cards = Array.from(document.querySelectorAll('dl.item'));
  if (cards.length === 0) cards = Array.from(document.querySelectorAll('.item, [class*="item-card"], [class*="product-card"]'));
  const anchors = cards.length
    ? cards.flatMap((c) => Array.from(c.querySelectorAll('a[href]')))
    : Array.from(document.querySelectorAll('a[href]'));
  const map = new Map();
  for (const a of anchors) {
    const href = a.href || '';
    const m = href.match(/[?&](?:id|itemId)=(\d+)/i);
    if (!m) continue;
    if (!/item\.taobao\.com|detail\.tmall\.com|item\.tmall\.com|detail\.liangxinyao\.com/i.test(href)) continue;
    const itemId = m[1];
    if (map.has(itemId)) continue;
    const card = a.closest('dl.item, .item, [class*="item"], [class*="card"]') || a;
    const titleEl = card.querySelector('a.item-name, dd.detail a, [class*="title"], .title');
    const title = (titleEl ? titleEl.textContent : a.getAttribute('title') || a.textContent || '').trim();
    const img = card.querySelector('img[src], img[data-ks-lazyload-custom], img[data-src]');
    let imageUrl = '';
    if (img) {
      imageUrl = img.src || img.getAttribute('data-ks-lazyload-custom') || img.getAttribute('data-src') || '';
      if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
    }
    const cleanUrl = /detail\.tmall\.com|item\.tmall\.com/i.test(href)
      ? `https://detail.tmall.com/item.htm?id=${itemId}`
      : `https://item.taobao.com/item.htm?id=${itemId}`;
    map.set(itemId, { item_id: itemId, title: title.replace(/\s+/g, ' ').slice(0, 300), item_url: cleanUrl, image_url: imageUrl });
  }
  return Array.from(map.values());
}

async function crawl(page, shop, maxPages, outBase) {
  const pages = [];
  const seen = new Set();
  let prevSig = '';
  let emptyStreak = 0;
  let base;
  if (shop.shopId) base = `https://shop${shop.shopId}.taobao.com/category.htm?search=y&pageNo=`;
  else if (shop.handle) base = `https://${shop.handle}.tmall.com/category.htm?search=y&pageNo=`;
  else throw new Error('缺少 shopId / handle');

  for (let p = 1; p <= maxPages; p++) {
    const url = base + p;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3500);
    if (/login\.taobao\.com|login\.tmall\.com/i.test(page.url())) {
      throw new Error(`第 ${p} 页被跳到登录页，登录态失效`);
    }
    // 触发懒加载
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 1600).catch(() => {});
      await page.waitForTimeout(700);
    }
    let items = await page.evaluate(extractItems).catch(() => []);
    if (items.length === 0) {
      await page.waitForTimeout(3000);
      items = await page.evaluate(extractItems).catch(() => []);
    }
    const fresh = items.filter((it) => !seen.has(it.item_id));
    const sig = items.map((it) => it.item_id).sort().join(',');
    console.log(`[page ${p}] ${items.length} 条，新增 ${fresh.length} 条  ${page.url()}`);
    if (items.length === 0) break;
    // 分页越过末页时，部分店铺会重复上一页或只重复置顶商品
    if (p > 1 && sig === prevSig) { console.log('  页面与上一页完全相同，停止'); break; }
    if (p > 1 && fresh.length === 0) {
      emptyStreak++;
      if (emptyStreak >= 2) { console.log('  连续两页无新增，停止'); break; }
    } else {
      emptyStreak = 0;
    }
    prevSig = sig;
    fresh.forEach((it) => (it.page = p));
    pages.push(...fresh);
    fresh.forEach((it) => seen.add(it.item_id));
    // 每页落盘，长任务可断点查看
    if (outBase) writeCsv(outBase + '.partial.csv', pages);
    await jitter();
  }
  return pages;
}

function writeCsv(file, rows) {
  const headers = ['item_id', 'title', 'item_url', 'image_url', 'page'];
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(','));
  fs.writeFileSync(file, '﻿' + lines.join('\n') + '\n', 'utf8');
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const shopName = arg('shop-name');
  const shopId = arg('shop-id');
  const shopUrl = arg('shop-url');
  const maxPages = Number(arg('max-pages', 100));

  const { browser, page, launched } = await connect();
  if (launched) {
    console.log('已启动 Chrome，请在弹出的窗口登录淘宝。');
    for (let i = 0; i < 300; i++) {
      const st = await checkLogin(page);
      if (st.ok) break;
      if (i % 15 === 0) console.log('等待登录中...');
      await sleep(2000);
    }
  }

  const st = await checkLogin(page);
  if (!st.ok) {
    console.log(JSON.stringify({ ok: false, error: '未登录', hint: '请在 9222 端口的 Chrome 窗口完成淘宝登录后重试' }));
    process.exitCode = 2;
    await browser.close().catch(() => {});
    return;
  }
  console.log('登录态 OK');

  let shop = { input: shopName, shopId: shopId || undefined };
  if (shopUrl) Object.assign(shop, idsFromUrl(String(shopUrl)), { shopUrl: String(shopUrl) });
  if (!shop.shopId && !shop.handle && shopName) shop = await resolveShop(page, String(shopName));
  if (!shop.shopId && !shop.handle) {
    console.log(JSON.stringify({ ok: false, error: '未能解析店铺', shop }, null, 2));
    process.exitCode = 3;
    await browser.close().catch(() => {});
    return;
  }
  console.log('店铺解析:', JSON.stringify(shop));
  if (has('resolve-only')) {
    await browser.close().catch(() => {});
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const safe = String(shopName || shop.shopId || shop.handle).replace(/[^\w一-龥-]/g, '_').slice(0, 40);
  const outBase = path.join(OUT_DIR, `${safe}_${stamp}`);
  const rows = await crawl(page, shop, maxPages, outBase);
  const csv = outBase + '.csv';
  const json = outBase + '.json';
  writeCsv(csv, rows);
  fs.writeFileSync(json, JSON.stringify({ shop, count: rows.length, items: rows }, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, count: rows.length, csv, json }, null, 2));
  await browser.close().catch(() => {});
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
