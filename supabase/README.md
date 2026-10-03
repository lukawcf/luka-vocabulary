# 云端免费模式（Supabase + 千问）

用户打开网页就能用，不用注册：页面在后台用 Supabase 的匿名登录给每个访客一个自己的账号，进度存在云端，AI 判断由服务器函数用你的千问（阿里云百炼）Key 完成，不限次数（每月总预算用完时暂停）。想在手机和电脑间同步的用户可以在「设置」里绑定邮箱（可选）。

线上网站已经按下面的步骤部署好。`config.js` 里的 Supabase 地址留空时，网站会退回本地模式（进度存在浏览器里，判断用用户自己填的 API Key）。

## 结构

| 位置 | 作用 |
|---|---|
| `migrations/20260927000000_init.sql` | 数据表（`user_state`、`user_cards`、`ai_usage`）、行级权限、用量统计函数 |
| `functions/judge/index.ts` | 判断句子：检查每月总预算和句子长度（也可以设置每日次数上限）；先让千问改出最小修正，再判断单词的意思用对没有，再为每个出错的地方写提示；提示不合规则时让模型改写；服务临时出错时重试一次；每次调用都记录花费 |
| `functions/judge/parse.ts` | 不依赖网络的部分：解析模型回复、检查提示规则（语法术语、给答案）、逐词对比原句和修正句、区分拼写错误和其他错误、生成兜底提示。测试：`node --test supabase/functions/judge/parse.test.ts` |
| `../config.js` | 前端用的 Supabase 地址和公开 key |

## 部署步骤

1. **建项目**：在 [supabase.com](https://supabase.com) 新建项目，区域选离用户近的（例如 Singapore 或 Sydney）。
2. **建表**：打开 SQL Editor，粘贴 `migrations/20260927000000_init.sql` 的全部内容并运行。
3. **开启匿名登录**：Authentication → Sign In / Providers → 打开 **Anonymous sign-ins**。Email 登录保持开启（绑定邮箱要用）。
4. **设置网址**：Authentication → URL Configuration，Site URL 填 `https://lukawcf.github.io/luka-vocabulary/`，Redirect URLs 也加上这个地址。
5. **建服务器函数**：Edge Functions → Deploy a new function → 用网页编辑器，名字填 `judge`，建 `index.ts` 和 `parse.ts` 两个文件，分别粘入 `functions/judge/` 下同名文件的内容，然后部署。
6. **填密钥**：Edge Functions → Secrets，添加：
   - `AI_API_KEY`：阿里云百炼的 API Key
   - `AI_BASE_URL`：中国站填 `https://dashscope.aliyuncs.com/compatible-mode/v1`，国际站填 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
   - `IP_SALT`：任意一串随机字符
   - 可选：`AI_MODEL`（代码默认 `qwen-plus`，线上现在设的是 `qwen3.7-flash`）、`DAILY_LIMIT` / `IP_DAILY_LIMIT`（每人 / 每个 IP 每天的次数上限，默认 0 = 不限）、`MONTHLY_BUDGET_CNY`（默认 150）、`PRICE_IN_PER_M_CNY` / `PRICE_OUT_PER_M_CNY`（按百炼控制台当前价格填，单位：元/百万 token）
7. **填前端配置**：Project Settings → API，把 Project URL 和 anon public key 填进 `config.js`，提交并推送。

## 更新服务器函数

改了 `functions/judge/` 下的文件后：打开 Edge Functions → `judge` → Code，把 `index.ts` 和 `parse.ts` 的内容换成新版本，点 **Deploy updates**。改动提示规则时，同时把 `index.ts` 里的 `PROMPT_VERSION` 加一，`ai_usage` 表会记下每次调用用的是哪一版。

换模型：在 Secrets 里修改 `AI_MODEL`，不用重新部署。记得把 `PRICE_IN_PER_M_CNY` / `PRICE_OUT_PER_M_CNY` 改成新模型的价格，每月预算才算得准。

## 防刷（建议）

- **人机验证**：在 Cloudflare 免费开通 Turnstile，拿到 site key 和 secret key；在 Supabase Authentication → Attack Protection 里开启 CAPTCHA 并填 secret key；把 site key 填进 `config.js` 的 `turnstileSiteKey`。匿名账号很容易批量创建，强烈建议开启。
- **百炼控制台**：设置费用预警，不要一次充太多。
- **每月总预算**：`MONTHLY_BUDGET_CNY` 用完后，当月 AI 判断自动暂停，背单词功能照常可用。

## 查看用量

在 SQL Editor 里运行：

```sql
select date_trunc('day', created_at) as day, count(*) as calls,
       count(*) filter (where not counted) as unusable, sum(cost_cny) as cny
from ai_usage group by 1 order by 1 desc limit 30;
```
