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

// Feedback rules the product promises: plain words, no grammar jargon, and never the answer.
// Models do not always follow the prompt, so the server checks. A note breaks the rules when it
// uses a grammar term, says what the right wording is, or quotes English that is not in the
// learner's own sentence (that would be handing them replacement words).
const GRAMMAR_TERMS = /主语|谓语|宾语|表语|定语|状语|补语|及物|不及物|词性|从句|时态|语法成分|语序|动词|名词|形容词|副词|介词|冠词|代词|连词|单数|复数|第三人称|过去式|过去分词|现在分词|被动语态|主动语态|不定式|动名词/;
const GIVES_ANSWER = /才是|应该改成|应改为|改成|改为|换成|正确的(说法|写法|是)|应该说|应该用|可以说成/;
const QUOTED = /'([^']+)'|‘([^’]+)’|"([^"]+)"|“([^”]+)”/g;

export function ruleBreaks(note: string, sentence: string): boolean {
  if (GRAMMAR_TERMS.test(note) || GIVES_ANSWER.test(note)) return true;
  const own = sentence.toLowerCase();
  for (const m of note.matchAll(QUOTED)) {
    const q = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim().toLowerCase();
    if (/[a-z]/.test(q) && !own.includes(q)) return true;
  }
  return false;
}
// usage may name collocations (that is its job) but must stay free of grammar terms.
export function followsRules(j: Judgement, sentence: string): boolean {
  return j.issues.every((x) => !ruleBreaks(x.note, sentence)) && !GRAMMAR_TERMS.test(j.usage);
}
// Last resort when a retry still breaks the rules: drop the offending notes rather than show them.
export function sanitize(j: Judgement, sentence: string): Judgement {
  const issues = j.issues.filter((x) => !ruleBreaks(x.note, sentence));
  if (j.verdict === "bad" && !issues.length) issues.push({ type: "naturalness", note: "这句还有地方不太对，再读一遍，想想哪里少了或多了什么。" });
  return { ...j, issues, usage: GRAMMAR_TERMS.test(j.usage) ? "" : j.usage };
}

// finish_reason "length" means the reply was cut off, so even parseable JSON is incomplete.
export function parseReply(content: string, finishReason: string | null | undefined): Judgement | null {
  if (finishReason === "length") return null;
  return toJudgement(extractJson(content ?? ""));
}
