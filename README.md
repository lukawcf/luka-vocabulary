<img src="logo.svg" width="72" alt="Luka Vocabulary logo">

# Luka Vocabulary

用单词自己造句来背雅思核心词汇。AI 判断句子：好句子给 🌸，有问题给 💩，只指出问题不给改好的答案。

## 功能

- **内置雅思核心 3000 词**：第一次打开时随机打乱顺序，之后顺序固定
- **每天最多 20 个新词、20 个复习**，按遗忘曲线（SM-2）安排复习
- 今天的任务做完后进入加练：**每小时刷新 5 个**加练单词
- 中文释义默认隐藏，点「看中文」才显示；看过的词会更早回来复习
- 美式发音，支持语音输入（Chrome / Edge）
- **免费 AI 判断**：网页版用项目自己的千问（qwen-flash）判句子，用户不用注册、不用填 Key，每人每天有免费次数
- **本地模式自带 API Key**：`config.js` 留空时，用户可以接 Claude、OpenAI、Gemini、DeepSeek、通义千问、Kimi、智谱、硅基流动、OpenRouter、Ollama，以及任何兼容 OpenAI 接口的服务
- **更新通知**：每次发布新版本，打开的用户会看到这次改了什么；页面一直开着的用户会收到「刷新」提示
- 导出和导入进度备份（「导出为 Skill」已实现但暂未开放，见 `index.html` 里的 `SKILL_EXPORT`）

## 运行

整个 App 只有一个 `index.html` 文件，不需要构建。

本地预览：

```bash
python -m http.server 5173
```

然后打开 http://localhost:5173 。

## 部署

每次发布：把 `index.html` 里的 `APP_VERSION` 改成新版本号（如 `2026.10.02`，同一天多次发布用 `2026.10.02-2`），并在 `changelog.json` 最前面加一条同版本号的更新说明。

放到任意静态托管平台即可，例如 GitHub Pages、Vercel、Netlify。语音识别需要 https，这些平台默认都是 https。

GitHub Pages：把仓库推送到 GitHub，然后在 Settings → Pages 里选择 `main` 分支的根目录。

## 数据与隐私

- 网页版默认是云端免费模式（见 `supabase/README.md`）：打开即自动创建匿名账号，进度存在 Supabase 数据库，行级权限保证每个人只能读写自己的数据；句子由服务器函数交给千问判断，每人每天有免费次数
- 云端模式不提供自带 Key 的选项，所有判断都经过服务器函数
- 本地模式下用户填的 API Key 只保存在自己浏览器里，判断时浏览器直接请求所选的服务商，不经过我们的服务器
- `config.js` 里的 Supabase 地址留空时，App 回到纯本地模式：进度只存在浏览器 localStorage
- 备份文件不包含 API Key

## 发音

每个单词都有预先生成的美式发音录音，放在 `audio/a00.json` … `audio/a1f.json`（按单词哈希分成 32 组，每组 `{单词: base64 mp3}`）。录音用开源语音模型 [Kokoro](https://github.com/hexgrad/kokoro)（Apache-2.0，通过 [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx)）的美式男声 `am_michael` 生成，生成脚本是 `tools/gen_audio.py`。没有录音的单词才会用浏览器自带的朗读。

## 词库来源

雅思词表取自开源英汉词典 [ECDICT](https://github.com/skywind3000/ECDICT)（Copyright (c) skywind3000，MIT License）：选取标记为雅思（ielts）的单词，去掉中考级别的基础词，按 COCA / BNC 语料库词频取最常用的 3000 个，释义精简为最多两个词性。

## claude.ai 版

`claude-artifact.html` 是发布在 claude.ai 上的版本的源码。它用打开者自己的 Claude 套餐额度判句子，不需要 API Key，只能在 claude.ai 里运行（直接用浏览器打开时 AI 不可用）。两个版本的备份文件通用。
