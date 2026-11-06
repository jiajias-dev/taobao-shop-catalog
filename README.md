# 淘宝/天猫店铺商品采集与比价工具

按店铺名称、店铺 ID 或店铺 URL，采集店铺在售商品列表，并进一步补充 SKU、价格、包邮、发货地、付款人数等前台可见信息，输出 CSV / JSON，便于做竞品比价和商品结构分析。

> **合规提示**：本项目仅用于学习、研究及已获授权的店铺数据分析。使用前请确认符合淘宝/天猫的服务条款与 robots 规则，控制请求频率，不要用于商业转售或大规模抓取。仓库内不包含任何真实店铺数据。

## 功能

| 脚本 | 作用 |
|---|---|
| `taobao_shop_catalog.js` | 按店铺名 / shopId / 店铺 URL 解析店铺，抓取商品列表（兼容老版 `dl.item` 与新版卡片布局），适合小批量或结构探查 |
| `fetch_shop_items.js` | 通过店铺页的 `mtop.taobao.shop.simple.item.fetch` 接口分页拉取**全部在售商品**，支持断点续跑 |
| `enrich_shop_items.js` | 通过 `mtop.taobao.pcdetail.data.get` 补充商详：SKU 名称、SKU 价格、SKU 库存、优惠前价、包邮、运费、发货地、预计送达，并汇总为商品表和 SKU 表 |

## 环境要求

- Node.js >= 20
- `playwright-core`（`npm install` 已包含）
- 本机安装 Google Chrome
- 一个已登录淘宝/天猫的账号

## 快速开始

1. 安装依赖：

```bash
npm install
```

2. 用一个**独立的 Chrome 配置目录**启动远程调试（不要用日常浏览器配置）：

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/.tbshop-profile" \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check \
  https://www.taobao.com
```

```powershell
# Windows PowerShell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="$env:USERPROFILE\.tbshop-profile" `
  --remote-debugging-port=9222 `
  --no-first-run --no-default-browser-check `
  https://www.taobao.com
```

```bash
# Linux
google-chrome \
  --user-data-dir="$HOME/.tbshop-profile" \
  --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check \
  https://www.taobao.com
```

在弹出的窗口里手动完成登录。脚本通过 CDP 复用这个登录态，不会读取或上传 Cookie。

> Chrome 不在默认安装路径时，用 `CHROME_PATH` 指定可执行文件；配置目录不同时用 `TB_PROFILE` 指定，例如 `TB_PROFILE=D:\tb-profile`。

> Windows 成员如果不想手动敲命令，可以把 [`docs/windows-agent-prompt.md`](docs/windows-agent-prompt.md) 里的提示词交给本机 AI 助手，按步骤执行。

3. 解析店铺并抓取列表：

```bash
# 方式一：店铺名称
node taobao_shop_catalog.js --shop-name "示例旗舰店"

# 方式二：已知 shopId
node taobao_shop_catalog.js --shop-id <SHOP_ID> --max-pages 20

# 方式三：店铺 URL
node taobao_shop_catalog.js --shop-url "https://shop<SHOP_ID>.taobao.com"
```

4. 拉取全量在售商品（推荐，速度快、字段全）：

```bash
node fetch_shop_items.js \
  --shop-id <SHOP_ID> \
  --seller-id <SELLER_ID> \
  --shop-url https://<SHOP_HANDLE>.tmall.com/ \
  --out out/shop_items.json \
  --resume --batch-size 2
```

> `shopId` 和 `sellerId` 可以从店铺页源码或 `taobao_shop_catalog.js --resolve-only` 的输出里拿到。

5. 补充商详与 SKU：

```bash
node enrich_shop_items.js \
  --input out/shop_items.json \
  --prefix out/shop \
  --batch 50 --cooldown 1200
```

脚本每处理一条就追加到 `out/shop_progress.jsonl`，中断后重跑会自动跳过已成功的商品。

## 输出

以 `--prefix out/shop` 为例：

| 文件 | 内容 |
|---|---|
| `out/shop_items.csv` | 商品级汇总，一行一个商品 |
| `out/shop_skus.csv` | SKU 级明细，一行一个 SKU |
| `out/shop_full.json` | 上述两张表的结构化全量 |
| `out/shop_progress.jsonl` | 断点续跑用的原始记录 |

### 商品表主要字段

`商品ID`、`标题`、`商品链接`、`商品主图`、`原始价格(优惠前)`、`到手价(店铺列表)`、`价格说明`、`SKU最低价`、`SKU最高价`、`SKU数量`、`总库存`、`包邮`、`运费`、`发货地`、`预计送达`、`付款人数`、`付款人数下限`、`估算销售额(到手价×付款人数)`、`类目`、`关键属性`、`热卖榜`、`采集状态`

### 销售额口径

淘宝前台不公开成交金额，只展示“8000+人付款”这类区间。表中的：

```
估算销售额 = 到手价 × 付款人数下限
```

是**估算下限**，不等于真实 GMV。需要真实成交数据，请使用店铺后台（生意参谋）导出。

## 风控与频率

淘宝对商详接口有较严格的风控，实测连续请求约 200 次后会返回 `RGV587` 或 `TIMEOUT::接口超时`，且恢复速度远慢于预期。建议：

- 商详按 **50 条/批**跑，批间冷却 **20–30 分钟**；
- 第一次出现 `TIMEOUT` 就**立即停止**，不要用 60/120/180 秒反复重试，重试会继续加深风险分；
- 列表接口的风控阈值比商详宽松，但同样不要并发；
- 多人协作时不要同时跑，采集由一人执行，结果通过网盘/企微共享；
- 被风控后至少间隔 24 小时再试，先发 1 次请求探路，成功再继续。

脚本已内置上述策略：`--batch`、`--cooldown`、首次超时即停。

## 目录结构

```
.
├── taobao_shop_catalog.js   # 店铺解析 + 列表抓取（DOM）
├── fetch_shop_items.js      # 全量在售商品（mtop 列表接口）
├── enrich_shop_items.js     # 商详 / SKU 补充
├── docs/
│   └── windows-agent-prompt.md  # 给 Windows 成员的本机 AI 执行提示词
├── package.json
└── README.md
```

## 常见问题

**`connectOverCDP ... Browser context management is not supported`**
Chrome 长时间运行后偶发。关闭该调试实例，用同样的 `--user-data-dir` 和 `--remote-debugging-port` 重启即可，登录态会保留。

**`no mtop` / 页面被跳到登录页**
登录态失效，重新在弹出的 Chrome 窗口登录。

**商详字段为空、`采集状态` 为“未采集详情”**
该商品商详请求被限流或失败。`采集状态` 会保留错误原因，重跑 `enrich_shop_items.js` 会跳过已成功的，只补失败项。

**`no var b（可能被风控/登录页）`**
商详 HTML 被风控页替换。改用 `mtop.taobao.pcdetail.data.get`（本项目 `enrich_shop_items.js` 已采用），或等风控解除。

**Windows 下 `taobao-native` / 命令找不到、中文乱码**
- 确认已安装 Node.js 20+，`node -v` 能输出版本；
- PowerShell 里换行用反引号 `` ` ``，不是 `\`；
- 路径含空格时整体加引号；
- 控制台中文乱码先执行 `chcp 65001`；
- Chrome 不在默认目录时设置 `CHROME_PATH`。

## 贡献

1. 从 `main` 拉分支：`git checkout -b feat/xxx`
2. 提交前确认没有把 `out/` 数据、Cookie、账号信息带进仓库
3. 发起 Pull Request，说明改动内容和测试方式

## 免责声明

本项目按“现状”提供，不保证接口长期可用。淘宝/天猫页面和接口随时可能调整，使用风险由使用者自行承担。
