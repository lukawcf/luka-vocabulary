// Turning a model reply into a judgement. Kept free of Deno and network code so it can be
// tested on its own (node --test supabase/functions/judge/parse.test.ts).

export type Issue = { type: string; note: string };
export type Judgement = { verdict: "good" | "bad"; issues: Issue[]; praise: string; usage: string };

const ISSUE_TYPES = new Set(["grammar", "naturalness", "usage"]);
const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

// Pull one JSON object out of a reply: the whole reply, a ```json fence, or the first "{" to the
// last "}". Reasoning models may prepend <think>...</think>, which is dropped first.
export function extractJson(text: string): unknown {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const attempts = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) attempts.push(fence[1]);
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i >= 0 && j > i) attempts.push(t.slice(i, j + 1));
  for (const a of attempts) {
    try { return JSON.parse(a); } catch { /* try the next form */ }
  }
  return null;
}

// Validate the shape. A missing or unknown verdict is NOT turned into "bad": that would hand the
// learner a 💩 for the model's mistake, so it counts as an unusable reply and is asked again.
export function toJudgement(value: unknown): Judgement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.verdict !== "good" && r.verdict !== "bad") return null;
  const issues = Array.isArray(r.issues) ? r.issues : [];
  return {
    verdict: r.verdict,
    issues: issues.slice(0, 4).map((x) => {
      const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      const type = String(o.type ?? "");
      return { type: ISSUE_TYPES.has(type) ? type : "usage", note: clip(o.note, 200) };
    }).filter((x) => x.note),
    praise: r.verdict === "good" ? clip(r.praise, 120) : "",
    usage: clip(r.usage, 300),
  };
}

// finish_reason "length" means the reply was cut off, so even parseable JSON is incomplete.
export function parseReply(content: string, finishReason: string | null | undefined): Judgement | null {
  if (finishReason === "length") return null;
  return toJudgement(extractJson(content ?? ""));
}
