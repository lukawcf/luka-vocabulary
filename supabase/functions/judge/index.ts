// Luka Vocabulary — judge one learner sentence with DeepSeek.
//
// The prompt lives here, not in the browser, so the endpoint can only ever grade a sentence for
// a word; the DeepSeek key never leaves the server. Before calling the model it enforces:
//   - a user id (Supabase JWT; anonymous sign-ins count, so visitors need no account)
//   - input sizes (word, meaning, sentence)
//   - DAILY_LIMIT judgements per user and IP_DAILY_LIMIT per IP per UTC day
//   - MONTHLY_BUDGET_USD across all users per UTC month (then AI judging pauses for everyone)
// Every call is recorded in ai_usage with its token cost.
//
// Secrets (supabase secrets set ...): DEEPSEEK_API_KEY
// Optional: DEEPSEEK_MODEL (deepseek-chat), DAILY_LIMIT (60), IP_DAILY_LIMIT (180), MONTHLY_BUDGET_USD (20),
//           IP_SALT (any random string, keeps stored IP hashes unguessable),
//           PRICE_IN_PER_M / PRICE_OUT_PER_M (USD per million tokens; check DeepSeek's pricing page)
import { createClient } from "npm:@supabase/supabase-js@2";

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
const MONTHLY_BUDGET_USD = Number(env("MONTHLY_BUDGET_USD", "20"));
const PRICE_IN = Number(env("PRICE_IN_PER_M", "0.27"));
const PRICE_OUT = Number(env("PRICE_OUT_PER_M", "1.10"));
const MODEL = env("DEEPSEEK_MODEL", "deepseek-chat");

const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

async function ipHash(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const bytes = new TextEncoder().encode(env("IP_SALT", "luka") + ip);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function buildPrompt(word: string, meaning: string, sentence: string) {
  return `You are grading one sentence written by a Chinese learner of spoken English. The learner was asked to make up their own sentence using a target word.

Target word: "${word}" (meaning: ${meaning})
Learner's sentence: """${sentence}"""

Decide:
- "good" if the sentence uses the target word (any inflected form) correctly, is grammatical, and sounds like something an American native speaker would naturally say. Simple sentences are fine and should pass.
- "bad" if it has any grammar error, misuses the target word, does not contain the target word, or sounds unnatural.

Feedback rules:
- Every note in Simplified Chinese, short and specific.
- Say WHERE the problem is by quoting the learner's own words, and in plain everyday Chinese say what is missing or wrong there (e.g. "'may' 后面少了一个动作", "'information' 前面少了一个词"). Do NOT use grammar terms such as 主语、谓语、宾语、及物、不及物、词性、从句、时态、语法成分. NEVER write the corrected sentence and never give the replacement words. A hint question is fine.
- For "good": issues is [] and praise is one short encouraging Chinese sentence. For "bad": praise is "".
- Always fill "usage" (both verdicts), in plain everyday Simplified Chinese, at most 2 short sentences: what this word is usually used to describe (what kind of thing or situation), plus 2-3 common English collocations (short phrases like "an issue arises", never a full example sentence and never a fix for the learner's sentence). No grammar terms (same list as above).

Reply with only JSON: {"verdict":"good"|"bad","issues":[{"type":"grammar"|"naturalness"|"usage","note":"..."}],"praise":"...","usage":"..."}`;
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
  if (Number(status.month_cost) >= MONTHLY_BUDGET_USD) return json({ code: "budget" }, 503);

  // ask DeepSeek
  let res: Response;
  try {
    res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("DEEPSEEK_API_KEY")}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: buildPrompt(word, meaning, sentence) }],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 500,
      }),
    });
  } catch {
    return json({ code: "upstream" }, 502);
  }
  if (!res.ok) return json({ code: "upstream", status: res.status }, 502);
  const out = await res.json();
  const usage = out?.usage ?? {};
  const cost = ((usage.prompt_tokens ?? 0) * PRICE_IN + (usage.completion_tokens ?? 0) * PRICE_OUT) / 1e6;
  await admin.from("ai_usage").insert({
    user_id: user.id,
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    cost_usd: cost,
    ip_hash: iph,
  });

  let r: Record<string, unknown>;
  try { r = JSON.parse(out?.choices?.[0]?.message?.content ?? ""); } catch { return json({ code: "invalid_json" }, 502); }
  const issues = Array.isArray(r.issues) ? r.issues.slice(0, 4) : [];
  return json({
    verdict: r.verdict === "good" ? "good" : "bad",
    issues: issues.map((x: any) => ({ type: String(x?.type ?? ""), note: String(x?.note ?? "") })),
    praise: String(r.praise ?? ""),
    usage: String(r.usage ?? ""),
    remaining: Math.max(0, DAILY_LIMIT - status.today_count - 1),
  });
});
