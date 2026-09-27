# 云端免费模式（Supabase + DeepSeek）

用户打开网页就能用，不用注册：页面在后台用 Supabase 的匿名登录给每个访客一个自己的账号，进度存在云端，AI 判断由服务器函数用你的 DeepSeek Key 完成，每人每天有免费次数。想在手机和电脑间同步的用户可以在「设置」里绑定邮箱（可选）。

`config.js` 里的 Supabase 地址留空时，网站按原来的本地模式运行，所以下面的步骤做完之前，线上网站不受影响。

## 结构

| 位置 | 作用 |
|---|---|
| `migrations/20260927000000_init.sql` | 数据表（`user_state`、`user_cards`、`ai_usage`）、行级权限、用量统计函数 |
| `functions/judge/index.ts` | 判断句子：检查每日次数、每个 IP 的次数、每月总预算和句子长度，再调用 DeepSeek，记录花费 |
| `../config.js` | 前端用的 Supabase 地址和公开 key |

## 部署步骤

1. **建项目**：在 [supabase.com](https://supabase.com) 新建项目，区域选离用户近的（例如 Singapore 或 Sydney）。
2. **建表**：打开 SQL Editor，粘贴 `migrations/20260927000000_init.sql` 的全部内容并运行。
3. **开启匿名登录**：Authentication → Sign In / Providers → 打开 **Anonymous sign-ins**。Email 登录保持开启（绑定邮箱要用）。
4. **设置网址**：Authentication → URL Configuration，Site URL 填 `https://lukawcf.github.io/luka-vocabulary/`，Redirect URLs 也加上这个地址。
5. **建服务器函数**：Edge Functions → Deploy a new function → 用网页编辑器，名字填 `judge`，把 `functions/judge/index.ts` 的内容粘进去部署。
6. **填密钥**：Edge Functions → Secrets，添加：
   - `DEEPSEEK_API_KEY`：在 [platform.deepseek.com](https://platform.deepseek.com) 创建
   - `IP_SALT`：任意一串随机字符
   - 可选：`DAILY_LIMIT`（默认 60）、`IP_DAILY_LIMIT`（默认 180）、`MONTHLY_BUDGET_USD`（默认 20）、`PRICE_IN_PER_M` / `PRICE_OUT_PER_M`（按 DeepSeek 官网当前价格填，单位：美元/百万 token）
7. **填前端配置**：Project Settings → API，把 Project URL 和 anon public key 填进 `config.js`，提交并推送。

## 防刷（建议）

- **人机验证**：在 Cloudflare 免费开通 Turnstile，拿到 site key 和 secret key；在 Supabase Authentication → Attack Protection 里开启 CAPTCHA 并填 secret key；把 site key 填进 `config.js` 的 `turnstileSiteKey`。匿名账号很容易批量创建，强烈建议开启。
- **DeepSeek 后台**：设置余额提醒，不要一次充太多。
- **每月总预算**：`MONTHLY_BUDGET_USD` 用完后，当月 AI 判断自动暂停，背单词功能照常可用。

## 查看用量

在 SQL Editor 里运行：

```sql
select date_trunc('day', created_at) as day, count(*) as calls, sum(cost_usd) as usd
from ai_usage group by 1 order by 1 desc limit 30;
```
