#!/usr/bin/env node
/**
 * 拉取天猫/淘宝店铺全部在售宝贝（走店铺页自己的 mtop 接口，30 条/页）
 *
 * 用法：
 *   node fetch_shop_items.js --shop-id <SHOP_ID> --seller-id <SELLER_ID> \
 *        --shop-url https://<SHOP_HANDLE>.tmall.com/ --out out/shop_items.json --resume
 *
 * 说明：接口连续调用约 6-10 页后会超时/限流，所以每批只取几页，
 *       每批之间重新加载店铺页刷新 mtop 会话，失败自动重试并续跑。
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CDP = process.env.TB_CDP || 'http://127.0.0.1:9222';
const OUT_DIR = path.join(__dirname, 'out');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (name) => process.argv.includes(`--${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const shopId = String(arg('shop-id', ''));
  const sellerId = String(arg('seller-id', ''));
  const shopUrl = String(arg('shop-url', `https://shop${shopId}.taobao.com/`));
  const orderType = String(arg('order', 'uvsum365'));
  const batchSize = Number(arg('batch-size', 2));
  const outFile = String(arg('out', path.join(OUT_DIR, `shop_${shopId}_items.json`)));
  if (!shopId || !sellerId) throw new Error('必须提供 --shop-id 和 --seller-id');

  let all = [];
  let totalCnt = null;
  if (has('resume') && fs.existsSync(outFile)) {
    try {
      const old = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      all = old.items || [];
      totalCnt = old.totalCnt || null;
      console.log(`resume: 已有 ${all.length} 条，目标 ${totalCnt || '?'}`);
    } catch (_) {}
  }
  const seen = new Set(all.map((it) => String(it.item_id || '').trim()).filter(Boolean));
  let startPage = Number(arg('start-page', Math.max(1, Math.floor(all.length / 30))));

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => (p.url() || '').includes('taobao.com')) || ctx.pages()[0];

  const save = () => {
    const payload = { shopId, sellerId, shopUrl, orderType, fetchedAt: new Date().toISOString(), totalCnt, count: all.length, items: all };
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 1), 'utf8');
  };

  let p = startPage;
  let fails = 0;
  while (p <= 300) {
    if (totalCnt != null && all.length >= totalCnt) break;
    await page.goto(shopUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);

    const batch = [];
    for (let i = 0; i < batchSize; i++) batch.push(p + i);

    const res = await page.evaluate(async ({ shopId, sellerId, orderType, batch }) => {
      if (!window.lib || !window.lib.mtop) return { error: 'no mtop' };
      const call = (pageNo) => new Promise((resolve) => {
        const opts = {
          api: 'mtop.taobao.shop.simple.item.fetch',
          type: 'get', v: '1.0', ecode: 0, isSec: 0, timeout: 15000, dataType: 'json',
          sessionOption: 'AutoLoginAndManualLogin', needLogin: true, LoginRequest: true,
          jsonpIncPrefix: '_' + Date.now() + '_',
          data: JSON.stringify({
            page: pageNo, orderType, sortType: '', catId: 0, keyword: '', filterType: '',
            feature: '{"isFullCardSearch":"1"}', shopId, sellerId,
          }),
        };
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        try {
          window.lib.mtop.request(opts, (a) => done(a || null), (e) => {
            let msg = ''; try { msg = typeof e === 'string' ? e : JSON.stringify(e); } catch (_) { msg = String(e); }
            done({ error: msg.slice(0, 400) });
          });
        } catch (e) {
          let msg = ''; try { msg = typeof e === 'string' ? e : JSON.stringify(e); } catch (_) { msg = String(e); }
          done({ error: msg.slice(0, 400) });
        }
        setTimeout(() => done({ error: 'timeout' }), 20000);
      });

      const out = [];
      let tc = null;
      let err = null;
      let lastPage = null;
      for (const pageNo of batch) {
        let r = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          r = await call(pageNo);
          if (r && !r.error) break;
          err = r && r.error;
          await new Promise((res) => setTimeout(res, 2000 * attempt));
        }
        if (!r || r.error) { err = r && r.error; break; }
        const d = r.data || {};
        if (tc == null) tc = d.totalCnt;
        const arr = d.data || [];
        if (!arr.length) { lastPage = pageNo; break; }
        out.push(...arr);
        lastPage = pageNo;
        await new Promise((res) => setTimeout(res, 3000 + Math.random() * 2000));
      }
      return { items: out, totalCnt: tc, error: err, lastPage };
    }, { shopId, sellerId, orderType, batch });

    if (res && res.totalCnt != null) totalCnt = res.totalCnt;
    if (res && res.items && res.items.length) {
      let added = 0;
      for (const it of res.items) {
        const id = String(it.item_id || (it.auctionURL || '').match(/[?&]id=(\d+)/)?.[1] || '');
        if (!id || seen.has(id)) continue;
        seen.add(id); all.push(it); added++;
      }
      console.log(`pages ${batch[0]}-${batch[batch.length - 1]}: +${added}，累计 ${all.length}/${totalCnt || '?'}`);
      save();
    }
    if (res && res.error) console.log(`  batch warning: ${String(res.error).slice(0, 120)}`);
    if (res && res.error) {
      fails++;
      p = (res.lastPage != null ? res.lastPage + 1 : p);
      if (fails >= 5) { console.log('连续失败 5 次，停止；下次用 --resume 继续'); break; }
    } else {
      fails = 0;
      p += batchSize;
    }
    await sleep(10000 + Math.random() * 5000);
  }

  save();
  console.log(JSON.stringify({ ok: true, totalCnt, count: all.length, out: outFile }, null, 2));
  await browser.close();
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
