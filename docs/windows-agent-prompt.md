# Windows 执行用提示词（交给本机 AI 助手）

把下面整段复制给 Windows 电脑上的 AI 助手（DeepSeek 等），先把 `{{...}}` 换成真实值。适用于“只负责跑数据、不改代码”的成员。

> `{{SHOP_ID}}`、`{{SELLER_ID}}` 不在公开仓库里，由仓库所有者私下提供。

---

```text
你是我在 Windows 上的执行助手。请帮我运行一个已经公开的淘宝店铺商品采集项目，按步骤执行，不要跳步、不要改代码。

【项目信息】
仓库：https://github.com/jiajias-dev/taobao-shop-catalog.git
目标店铺名称：{{店铺名称}}
店铺 shopId：{{SHOP_ID}}
店铺 sellerId：{{SELLER_ID}}
店铺主页：{{店铺URL}}

【硬性规则】
1. 所有命令都在 PowerShell 里执行，路径用引号包住。
2. 采集必须低频：商详按 50 条/批、批间隔 20–30 分钟；第一次出现 TIMEOUT 就立即停止，不要重试。
3. 不要同时开多个采集进程，不要修改脚本里的请求逻辑。
4. 遇到登录、滑块、验证码，停下来让我手动处理，不要尝试绕过。
5. 每一步执行后把关键输出贴给我；报错要保留原始错误信息。

【步骤】

第 1 步：检查环境
- 执行 node -v，要求 v20 以上；没有就告诉我，不要自己装。
- 执行 git --version。
- 确认 Chrome 已安装，路径通常是：
  C:\Program Files\Google\Chrome\Application\chrome.exe

第 2 步：获取代码
在桌面打开 PowerShell，执行：
  cd $env:USERPROFILE\Desktop
  git clone https://github.com/jiajias-dev/taobao-shop-catalog.git
  cd taobao-shop-catalog
  npm install

第 3 步：启动独立 Chrome 并登录
执行：
  & "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
    --user-data-dir="$env:USERPROFILE\.tbshop-profile" `
    --remote-debugging-port=9222 `
    --no-first-run --no-default-browser-check `
    https://www.taobao.com

然后停下来告诉我：请在打开的窗口里登录淘宝，登录完成后回复“已登录”。
我确认后，你执行：
  Invoke-WebRequest http://127.0.0.1:9222/json/version -UseBasicParsing | Select-Object -ExpandProperty Content
能看到 Browser 版本号才算成功。

第 4 步：验证店铺解析
执行：
  node taobao_shop_catalog.js --shop-name "{{店铺名称}}" --resolve-only
把输出的 shopId、handle 贴给我，和我提供的 {{SHOP_ID}} 核对。

第 5 步：拉取全量商品列表
执行：
  node fetch_shop_items.js --shop-id {{SHOP_ID}} --seller-id {{SELLER_ID}} --shop-url "{{店铺URL}}" --out out/shop_items.json --resume --batch-size 2
完成后报告：totalCnt、count 两个数字。如果 count 明显小于 totalCnt，先停下来告诉我，不要反复重跑。

第 6 步：补商详（低频）
执行：
  node enrich_shop_items.js --input out/shop_items.json --prefix out/shop --batch 50 --cooldown 1200
运行期间每 10 分钟向我报告一次进度（日志里 “x/总数” 那一行）。
一旦日志出现 “接口限流” 或 TIMEOUT，立即停止进程并告诉我，不要重启重试。

第 7 步：检查结果
执行：
  Get-ChildItem out
  (Import-Csv out\shop_items.csv).Count
  (Import-Csv out\shop_items.csv | Group-Object 采集状态 | Select-Object Name,Count)
把文件大小、商品行数、采集状态分布告诉我。

【常见错误处理】
- 报 “Browser context management is not supported”：关闭调试用的 Chrome 窗口，用第 3 步同样的命令重新启动，登录态会保留。
- 报 “no mtop” 或跳登录页：登录失效，回到第 3 步重新登录。
- 报 “无法连接 http://127.0.0.1:9222”：Chrome 没启动或端口被占用，先确认 9222 是否在监听。
- `采集状态` 出现“未采集详情”：正常，说明该条商详被限流或失败，不是脚本坏了。
- 中文乱码：先执行 chcp 65001。

【不要做的事】
- 不要为了“跑完”而缩短间隔或重复重试。
- 不要使用其他账号、Cookie 或代理来绕过限流。
- 不要上传或外发 out/ 目录里的数据。
```
