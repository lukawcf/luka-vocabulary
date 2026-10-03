// Luka Vocabulary — judge one learner sentence with Qwen (any OpenAI-compatible model works).
//
// The prompt lives here, not in the browser, so the endpoint can only ever grade a sentence for
// a word; the model API key never leaves the server. Before calling the model it enforces:
//   - a user id (Supabase JWT; anonymous sign-ins count, so visitors need no account)
//   - input sizes (word, meaning, sentence)
//   - optional DAILY_LIMIT per user and IP_DAILY_LIMIT per IP per UTC day (unset or 0: unlimited)
//   - MONTHLY_BUDGET_CNY across all users per UTC month (then AI judging pauses for everyone)
// A correction pass runs first: typos are only pointed out, other slips fail the sentence with a
// hint at that spot, and the corrected sentence is graded for how the target word is used. A reply
// that is cut off, not JSON, or missing the verdict is asked for once more; notes that break the
// feedback rules are rewritten once, then filtered. Transient upstream failures (network, 429, 5xx)
// are retried once too. Every model call is recorded in
// ai_usage with its cost; only a judgement that reached the learner counts toward their quota.
//
// Secrets (supabase secrets set ...). Any OpenAI-compatible chat API works; two are tuned for:
//   Google Gemini   AI_BASE_URL https://generativelanguage.googleapis.com/v1beta/openai
//                   AI_MODEL gemini-3.5-flash-lite, AI_API_KEY a Gemini API key
//   Qwen (百炼)     AI_BASE_URL https://dashscope.aliyuncs.com/compatible-mode/v1 (China site)
//                   or https://dashscope-intl.aliyuncs.com/compatible-mode/v1 (international),
//                   AI_MODEL e.g. qwen3.7-flash, AI_API_KEY a DashScope key
//   IP_SALT       any random string, keeps stored IP hashes unguessable
// Optional: AI_MODEL (qwen-plus), DAILY_LIMIT / IP_DAILY_LIMIT (0 = unlimited), MONTHLY_BUDGET_CNY (150),
//           PRICE_IN_PER_M_CNY / PRICE_OUT_PER_M_CNY (yuan per million tokens; check the console's price list)
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseReply, followsRules, sanitize, diffWords, spotNote, fixArticles, extractJson, type WordDiff, type Judgement } from "./parse.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const DAILY_LIMIT = Number(env("DAILY_LIMIT", "0"));
const IP_DAILY_LIMIT = Number(env("IP_DAILY_LIMIT", "0"));
const MONTHLY_BUDGET_CNY = Number(env("MONTHLY_BUDGET_CNY", "150"));
const PRICE_IN = Number(env("PRICE_IN_PER_M_CNY", "0.8"));
const PRICE_OUT = Number(env("PRICE_OUT_PER_M_CNY", "2"));
const BASE_URL = env("AI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
const MODEL = env("AI_MODEL", "qwen-plus");
const PROMPT_VERSION = "judge-v18";

// Server-side key: the legacy service role key, or the first of the newer secret keys
// (SUPABASE_SECRET_KEYS is a JSON dictionary). Either bypasses RLS; never sent to browsers.
function serverKey() {
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { return Object.values(JSON.parse(env("SUPABASE_SECRET_KEYS", "{}")))[0] as string; } catch { return ""; }
}
const admin = createClient(env("SUPABASE_URL"), serverKey());

async function ipHash(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const bytes = new TextEncoder().encode(env("IP_SALT", "luka") + ip);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type ModelReply = { content: string; finish: string | null; promptTokens: number; completionTokens: number };

const IS_GEMINI = BASE_URL.includes("generativelanguage.googleapis.com");
const IS_QWEN = BASE_URL.includes("dashscope");

// Provider-specific request settings.
// Qwen: JSON mode needs "JSON" in the prompt and thinking turned off.
// Gemini 3.x: thinking cannot be turned off, only kept minimal; it counts toward max_tokens, so the
// limit is higher. Google advises leaving temperature at its default for Gemini 3, and JSON is
// requested by the prompt (the replies are parsed tolerantly).
const PROVIDER_OPTIONS = IS_GEMINI
  ? { reasoning_effort: "minimal", max_tokens: 1500 }
  : { response_format: { type: "json_object" }, ...(IS_QWEN ? { enable_thinking: false } : {}), temperature: 0.2, max_tokens: 500 };

// One chat completion. Throws "transient" for network errors, timeouts, 429 and 5xx (worth one
// retry) and "upstream" for anything else.
async function callModel(prompt: string): Promise<ModelReply> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("AI_API_KEY")}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        ...PROVIDER_OPTIONS,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error("transient");
  }
  if (!res.ok) {
    // the provider's own error text (never contains our key) goes to the function logs
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    console.error(`model call failed: ${res.status} ${MODEL} ${detail}`);
    throw new Error(res.status === 429 || res.status >= 500 ? "transient" : "upstream");
  }
  const out = await res.json();
  return {
    content: out?.choices?.[0]?.message?.content ?? "",
    finish: out?.choices?.[0]?.finish_reason ?? null,
    promptTokens: out?.usage?.prompt_tokens ?? 0,
    // thinking tokens are billed as output; some providers leave them out of completion_tokens
    completionTokens: Math.max(out?.usage?.completion_tokens ?? 0, (out?.usage?.total_tokens ?? 0) - (out?.usage?.prompt_tokens ?? 0)),
  };
}

function correctionPrompt(word: string, sentence: string) {
  return `Correct this sentence written by an English learner, changing as little as possible: fix spelling and clear grammar mistakes only (wrong word forms, missing or extra small words). Do not change word choice, style or meaning, do not make it sound more natural, and keep the word "${word}" (only its form may change if the grammar needs it). Leave anything that is already acceptable English alone, even if another wording or form is also possible (for example "my study" is fine). If it is already correct, return it unchanged.

Sentence: """${sentence}"""

Reply with only JSON: {"fixed":"..."}`;
}

// How every note must be written; shared by the grading prompt and the rewrite prompt.
const NOTE_RULES = `- Be specific: say WHERE the problem is by quoting the learner's own words, what is wrong there and why, in plain everyday Chinese (e.g. "'may' 后面少了一个动作", "'arise' 后面接的东西不对，它说的是问题自己出现，不能带别的东西").
- Small linking words (a, an, the, and, but, or, so, because, if, than, that, which, who, in, on, at, to, of, for, with, from, by, about, it, there and the like) may be given directly: say which one to add, remove or use (e.g. "'interested' 后面要加 'in'", "'is' 后面少了 'a'", "'because' 和 'so' 只留一个").
- For any other word, do not write the right word; say how it should change instead (e.g. "'invent' 这个词的样子不对，前面说的是一个地方，词尾要变", "'go' 说的是昨天的事，这个词要换成过去的样子"). Never write the whole corrected sentence.
- Use everyday words only. Do NOT use any grammar term: 主语、谓语、宾语、表语、定语、状语、及物、不及物、词性、动词、名词、形容词、副词、介词、冠词、连词、从句、时态、语序、单复数、可数、不可数、语法成分.
- A hint question is fine.`;

// Grammar and spelling are handled by the correction pass, so this asks one narrow question about
// the already-corrected sentence: is the target word used with a meaning it really has?
function buildPrompt(word: string, meaning: string, sentence: string) {
  return `A Chinese learner of English made up a sentence with the word "${word}" (dictionary meaning: ${meaning}). Its grammar and spelling have already been checked; do not judge them.

Sentence: """${sentence}"""

Question: is "${word}" (any form of it) used here with a meaning it really has, either the dictionary meaning above or another real meaning of the word?
- Answer true unless that meaning clearly does not fit. Figurative, creative, formal and casual uses are true. Quotes from real speeches are true.
- Do NOT judge whether the statement is true, logical, common, stylish or how the word is "usually" used. A rare, unusual or bold claim is still true.
- Answer false only if the word is missing, or it is used as if it meant something it never means.

If false, write "note" for the learner:
- Every note in Simplified Chinese, short and specific.
${NOTE_RULES}
If true, "praise" is one short encouraging Chinese sentence; otherwise "".
Always fill "usage" with only the suggested fixed collocations and how the word is used, in plain everyday Simplified Chinese: one short sentence on what it usually describes, then 2-3 common English collocations (short phrases like "an issue arises"). Never a full example sentence, never a comment on the learner's sentence. No grammar terms.

Reply with only JSON: {"fits":true|false,"note":"...","praise":"...","usage":"..."}`;
}

// Notes that broke the rules are rewritten for this sentence instead of replaced by a stock line.
function rewritePrompt(word: string, sentence: string, j: Judgement) {
  return `A Chinese learner of English wrote this sentence using the word "${word}":
"""${sentence}"""

A teacher left these notes about it, but some use grammar terms or give away the answer:
${JSON.stringify(j.issues.map((x) => x.note))}

Rewrite every note for this learner so it points at the same place and the same problem, following these rules:
- Every note in Simplified Chinese, short and specific.
${NOTE_RULES}

Reply with only JSON: {"notes":["...", "..."]}`;
}

// One hint per mistake the correction pass found, written from the hidden corrected sentence.
function hintPrompt(sentence: string, fixed: string, spots: WordDiff["spots"]) {
  const where = spots.map((x) => `'${x.word}'` + (x.kind === "missing" ? "（附近少了东西）" : x.kind === "extra" ? "（这里多了东西）" : "")).join("、");
  return `A Chinese learner of English wrote:
"""${sentence}"""
A teacher's corrected version, which the learner must NOT see (never reveal it or any word of it that the learner did not write):
"""${fixed}"""

For each of these places, in this order: ${where}
1. "wrong": is the learner's own wording there really a mistake that an English teacher would mark? Answer false if it is acceptable English as written, even if the corrected version is also possible or more common (for example "my study" is fine).
2. "note": only when wrong is true, one short specific note about that place, following these rules:
- Every note in Simplified Chinese, short and specific.
${NOTE_RULES}

Reply with only JSON: {"spots":[{"wrong":true,"note":"..."}, ...]} with one item per place, in order.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ code: "method" }, 405);

  // who is asking
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  const user = auth?.user;
  if (!user) return json({ code: "unauthorized" }, 401);

  // what they sent
  let body: { word?: unknown; meaning?: unknown; sentence?: unknown };
  try { body = await req.json(); } catch { return json({ code: "bad_request" }, 400); }
  const word = String(body.word ?? "").trim();
  const meaning = String(body.meaning ?? "").trim().slice(0, 200);
  const sentence = String(body.sentence ?? "").trim().replace(/\s+/g, " ");
  if (!word || word.length > 40 || !/^[A-Za-z][A-Za-z' -]*$/.test(word)) return json({ code: "bad_request" }, 400);
  if (!sentence || sentence.length > 200) return json({ code: "too_long" }, 400);

  // limits
  const iph = await ipHash(req);
  const { data: st, error: stErr } = await admin.rpc("usage_status", { uid: user.id, iph }).single();
  if (stErr || !st) return json({ code: "server" }, 500);
  const status = st as { today_count: number; ip_today: number; month_cost: number };
  if (DAILY_LIMIT > 0 && status.today_count >= DAILY_LIMIT) return json({ code: "daily_limit", limit: DAILY_LIMIT }, 429);
  if (IP_DAILY_LIMIT > 0 && status.ip_today >= IP_DAILY_LIMIT) return json({ code: "daily_limit", limit: DAILY_LIMIT }, 429);
  if (Number(status.month_cost) >= MONTHLY_BUDGET_CNY) return json({ code: "budget" }, 503);

  const logUsage = (reply: ModelReply, counted: boolean) => admin.from("ai_usage").insert({
    user_id: user.id,
    ip_hash: iph,
    prompt_tokens: reply.promptTokens,
    completion_tokens: reply.completionTokens,
    cost_cny: (reply.promptTokens * PRICE_IN + reply.completionTokens * PRICE_OUT) / 1e6,
    counted,
    prompt_version: PROMPT_VERSION,
  });

  // correction pass (see diffWords): find typos and slips, then grade the corrected sentence for how
  // the target word is used. If it fails or rewrote too much, grade the sentence as written.
  let graded = sentence;
  let diff: WordDiff = { typos: [], spots: [], changed: 0, total: 0 };
  try {
    const c = await callModel(correctionPrompt(word, sentence));
    await logUsage(c, false);
    const fixed = (extractJson(c.content) as { fixed?: unknown } | null)?.fixed;
    if (c.finish !== "length" && typeof fixed === "string" && fixed.trim()) {
      const d = diffWords(sentence, fixed, word);
      if (d.changed <= Math.max(3, Math.ceil(d.total / 2))) { graded = fixed.trim(); diff = d; }
    }
  } catch { /* grade as written */ }

  // ask the model: at most two calls (one retry for a transient failure or an unusable reply)
  const prompt = buildPrompt(word, meaning, graded);
  let result: Judgement | null = null;
  let lastError = "invalid_json";
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800 + Math.random() * 700));
    let reply: ModelReply;
    try {
      reply = await callModel(prompt);
    } catch (e) {
      lastError = "upstream";
      if ((e as Error).message !== "transient") break;
      continue;
    }
    result = parseReply(reply.content, reply.finish);
    if (!result) lastError = "invalid_json";
    // the call cost money either way; only a judgement the learner receives counts toward quotas
    await logUsage(reply, !!result);
  }
  if (!result) return json({ code: lastError }, 502);
  // mistakes found by the correction pass: the sentence is bad, with one hint per spot
  let slipSpots: WordDiff["spots"] = [];
  if (diff.spots.length) {
    // the hint call also double-checks each spot: a correction pass may "fix" acceptable English
    let checks: { wrong?: unknown; note?: unknown }[] = [];
    try {
      const h = await callModel(hintPrompt(sentence, graded, diff.spots));
      await logUsage(h, false);
      const items = (extractJson(h.content) as { spots?: unknown } | null)?.spots;
      if (h.finish !== "length" && Array.isArray(items) && items.length === diff.spots.length) checks = items;
    } catch { /* keep every spot, with spotNote */ }
    slipSpots = diff.spots
      .map((x, i) => ({ x, c: checks[i] ?? {} }))
      .filter(({ c }) => c.wrong !== false)
      .slice(0, 3)
      .map(({ x }) => x);
    const slips = diff.spots
      .map((x, i) => ({ x, c: checks[i] ?? {} }))
      .filter(({ c }) => c.wrong !== false)
      .slice(0, 3)
      .map(({ x, c }) => {
        const note = String(c.note ?? "").trim().slice(0, 200);
        return { type: "grammar", note: note || spotNote(x) };
      });
    if (slips.length) {
      const wordNotes = result.verdict === "bad" ? result.issues : [];
      result = { ...result, verdict: "bad", praise: "", issues: [...slips, ...wordNotes].slice(0, 4) };
    }
  }
  // feedback that uses grammar jargon or gives the answer: have it rewritten for this sentence;
  // anything still breaking the rules after that is dropped (sanitize keeps where the problem is)
  if (!followsRules(result, sentence)) {
    try {
      const rw = await callModel(rewritePrompt(word, sentence, result));
      await logUsage(rw, false);
      const notes = (extractJson(rw.content) as { notes?: unknown } | null)?.notes;
      if (rw.finish !== "length" && Array.isArray(notes) && notes.length) {
        const types = result.issues.map((x) => x.type);
        result.issues = notes.slice(0, 4).map((n, i) => ({ type: types[i] ?? "usage", note: String(n ?? "").trim().slice(0, 200) }))
          .filter((x) => x.note);
      }
    } catch { /* fall through to sanitize */ }
    if (!followsRules(result, sentence)) result = sanitize(result, sentence, slipSpots);
  }
  result.usage = fixArticles(result.usage);
  if (diff.typos.length) {
    const typos = diff.typos;
    const note = `${typos.map((t) => `'${t}'`).join("、")} 拼错了，再检查一下拼写。`;
    if (result.verdict === "good") result.praise = `${result.praise} 小提示：${note}`.trim();
    else result.issues = [...result.issues.slice(0, 3), { type: "usage", note }];
  }
  return json({ ...result, remaining: DAILY_LIMIT > 0 ? Math.max(0, DAILY_LIMIT - status.today_count - 1) : null });
});
