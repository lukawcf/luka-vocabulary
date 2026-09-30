// Luka Vocabulary — judge one learner sentence with Qwen (any OpenAI-compatible model works).
//
// The prompt lives here, not in the browser, so the endpoint can only ever grade a sentence for
// a word; the model API key never leaves the server. Before calling the model it enforces:
//   - a user id (Supabase JWT; anonymous sign-ins count, so visitors need no account)
//   - input sizes (word, meaning, sentence)
//   - DAILY_LIMIT judgements per user and IP_DAILY_LIMIT per IP per UTC day
//   - MONTHLY_BUDGET_CNY across all users per UTC month (then AI judging pauses for everyone)
// A correction pass runs first: typos are only pointed out, other slips fail the sentence with a
// hint at that spot, and the corrected sentence is graded for how the target word is used. A reply
// that is cut off, not JSON, or missing the verdict is asked for once more; notes that break the
// feedback rules are rewritten once, then filtered. Transient upstream failures (network, 429, 5xx)
// are retried once too. Every model call is recorded in
// ai_usage with its cost; only a judgement that reached the learner counts toward their quota.
//
// Secrets (supabase secrets set ...):
//   AI_API_KEY    DashScope (Alibaba Cloud Model Studio) API key
//   AI_BASE_URL   https://dashscope.aliyuncs.com/compatible-mode/v1        (China site)
//                 https://dashscope-intl.aliyuncs.com/compatible-mode/v1   (international site)
//   IP_SALT       any random string, keeps stored IP hashes unguessable
// Optional: AI_MODEL (qwen-plus), DAILY_LIMIT (60), IP_DAILY_LIMIT (180), MONTHLY_BUDGET_CNY (150),
//           PRICE_IN_PER_M_CNY / PRICE_OUT_PER_M_CNY (yuan per million tokens; check the console's price list)
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseReply, followsRules, sanitize, diffWords, spotNote, ruleBreaks, extractJson, type WordDiff, type Judgement } from "./parse.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const DAILY_LIMIT = Number(env("DAILY_LIMIT", "60"));
const IP_DAILY_LIMIT = Number(env("IP_DAILY_LIMIT", "180"));
const MONTHLY_BUDGET_CNY = Number(env("MONTHLY_BUDGET_CNY", "150"));
const PRICE_IN = Number(env("PRICE_IN_PER_M_CNY", "0.8"));
const PRICE_OUT = Number(env("PRICE_OUT_PER_M_CNY", "2"));
const BASE_URL = env("AI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
const MODEL = env("AI_MODEL", "qwen-plus");
const PROMPT_VERSION = "judge-v13";

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
        response_format: { type: "json_object" }, // Qwen: needs "JSON" in the prompt and non-thinking mode
        ...(BASE_URL.includes("dashscope") ? { enable_thinking: false } : {}),
        temperature: 0.2,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error("transient");
  }
  if (res.status === 429 || res.status >= 500) throw new Error("transient");
  if (!res.ok) throw new Error("upstream");
  const out = await res.json();
  return {
    content: out?.choices?.[0]?.message?.content ?? "",
    finish: out?.choices?.[0]?.finish_reason ?? null,
    promptTokens: out?.usage?.prompt_tokens ?? 0,
    completionTokens: out?.usage?.completion_tokens ?? 0,
  };
}

function correctionPrompt(word: string, sentence: string) {
  return `Correct this sentence written by an English learner, changing as little as possible: fix spelling and clear grammar mistakes only (wrong word forms, missing or extra small words). Do not change word choice, style or meaning, do not make it sound more natural, and keep the word "${word}" (only its form may change if the grammar needs it). Leave anything that is already acceptable English alone, even if another wording or form is also possible (for example "my study" is fine). If it is already correct, return it unchanged.

Sentence: """${sentence}"""

Reply with only JSON: {"fixed":"..."}`;
}

// How every note must be written; shared by the grading prompt and the rewrite prompt.
const NOTE_RULES = `- Say WHERE the problem is by quoting the learner's own words, and in plain everyday Chinese say what is missing or wrong there (e.g. "'may' 后面少了一个动作", "'information' 前面少了一个词", "'arise' 后面接的东西不对，想想它通常描述什么自己出现"). When a word has the wrong form, say so in everyday words and hint at why without naming the fix: "'invent' 这个词的样子不对，看看前面说的是一个东西还是好几个", "'go' 说的是昨天的事，这个词的样子要跟着变".
- Only quote words that appear in the learner's sentence. Never write any English the learner did not write, never write the correct wording (not even part of it), and never say what it "should be" (no "才是", "应该改成", "换成").
- Use everyday words only. Do NOT use any grammar term: 主语、谓语、宾语、表语、定语、状语、及物、不及物、词性、动词、名词、形容词、副词、介词、冠词、从句、时态、语序、单复数、语法成分.
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
Always fill "usage", in plain everyday Simplified Chinese, at most 2 short sentences: what this word is usually used to describe (what kind of thing or situation), plus 2-3 common English collocations (short phrases like "an issue arises", never a full example sentence and never a fix for the learner's sentence). No grammar terms.

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

Write one short hint for each of these places, in this order: ${where}
Each hint says what is wrong at that place without giving the answer, following these rules:
- Every note in Simplified Chinese, short and specific.
${NOTE_RULES}

Reply with only JSON: {"notes":["...", "..."]}`;
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
  if (status.today_count >= DAILY_LIMIT) return json({ code: "daily_limit", limit: DAILY_LIMIT }, 429);
  if (status.ip_today >= IP_DAILY_LIMIT) return json({ code: "daily_limit", limit: DAILY_LIMIT }, 429);
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
  // feedback that uses grammar jargon or gives the answer: have it rewritten for this sentence;
  // anything still breaking the rules after that is dropped (sanitize keeps where the problem is)
  if (result && !followsRules(result, sentence)) {
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
    if (!followsRules(result, sentence)) result = sanitize(result, sentence);
  }
  if (!result) return json({ code: lastError }, 502);
  // mistakes found by the correction pass: the sentence is bad, with one hint per spot
  if (diff.spots.length) {
    let hints: string[] = [];
    try {
      const h = await callModel(hintPrompt(sentence, graded, diff.spots));
      await logUsage(h, false);
      const notes = (extractJson(h.content) as { notes?: unknown } | null)?.notes;
      if (h.finish !== "length" && Array.isArray(notes)) hints = notes.map((n) => String(n ?? "").trim().slice(0, 200));
    } catch { /* fall back to spotNote */ }
    const ok = (n?: string) => !!n && !ruleBreaks(n, sentence);
    const slips = diff.spots.slice(0, 3).map((x, i) => ({ type: "grammar", note: ok(hints[i]) ? hints[i] : spotNote(x) }));
    const wordNotes = result.verdict === "bad" ? result.issues : [];
    result = { ...result, verdict: "bad", praise: "", issues: [...slips, ...wordNotes].slice(0, 4) };
  }
  if (diff.typos.length) {
    const typos = diff.typos;
    const note = `${typos.map((t) => `'${t}'`).join("、")} 拼错了，再检查一下拼写。`;
    if (result.verdict === "good") result.praise = `${result.praise} 小提示：${note}`.trim();
    else result.issues = [...result.issues.slice(0, 3), { type: "usage", note }];
  }
  return json({ ...result, remaining: Math.max(0, DAILY_LIMIT - status.today_count - 1) });
});
