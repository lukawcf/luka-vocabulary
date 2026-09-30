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
// The place a dropped note pointed at (a quoted word from the learner's own sentence) is kept, so
// the learner still knows where to look.
export function sanitize(j: Judgement, sentence: string): Judgement {
  const issues = j.issues.filter((x) => !ruleBreaks(x.note, sentence));
  if (j.verdict === "bad" && !issues.length) {
    const own = sentence.toLowerCase();
    const spots = [...new Set(j.issues.flatMap((x) => [...x.note.matchAll(QUOTED)]
      .map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim())
      .filter((q) => /[a-z]/i.test(q) && own.includes(q.toLowerCase()))))].slice(0, 2);
    issues.push({ type: "naturalness", note: spots.length
      ? `${spots.map((q) => `'${q}'`).join("、")} 这里不太对，再读一遍这一处，想想少了或多了什么。`
      : "这句还有地方不太对，再读一遍，想想哪里少了或多了什么。" });
  }
  return { ...j, issues, usage: GRAMMAR_TERMS.test(j.usage) ? "" : j.usage };
}

// Spelling pre-pass. A typo like "fureture" makes a small model reject a sentence for made-up
// reasons, so the server first asks for spelling fixes and grades the fixed sentence. The model
// may also "fix" grammar (have → has, issue → issues), which would let a wrong sentence pass, so a
// change is kept only when it looks like a typo: same number of words, small edit, not a word
// growing an ending, not a common little word, and never the target word.
const COMMON = new Set(("a an the this that these those it its is are was were be been am have has had do does did " +
  "go goes went he she him her his they them their there we us our you your i me my to too of off in on at " +
  "for from by with as than then no not now know new few").split(" "));

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

export function looksLikeTypo(wrong: string, right: string, target: string): boolean {
  const w = wrong.toLowerCase(), r = right.toLowerCase(), t = target.toLowerCase();
  if (w === r || w.startsWith(t) || r.startsWith(t)) return false;
  if (COMMON.has(w) || COMMON.has(r) || w.startsWith(r) || r.startsWith(w)) return false;
  return editDistance(w, r) <= (r.length >= 7 ? 3 : 2);
}

// Returns the sentence with only the accepted typo fixes applied, and the misspelled words.
export function applySpellingFixes(original: string, fixed: string, target: string): { sentence: string; typos: string[] } {
  const WORD = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
  const a = [...original.matchAll(WORD)], b = [...String(fixed ?? "").matchAll(WORD)];
  if (!b.length || a.length !== b.length) return { sentence: original, typos: [] };
  let out = "", at = 0;
  const typos: string[] = [];
  a.forEach((m, i) => {
    if (!looksLikeTypo(m[0], b[i][0], target)) return;
    out += original.slice(at, m.index) + b[i][0];
    at = m.index! + m[0].length;
    typos.push(m[0]);
  });
  return { sentence: out + original.slice(at), typos };
}

// finish_reason "length" means the reply was cut off, so even parseable JSON is incomplete.
export function parseReply(content: string, finishReason: string | null | undefined): Judgement | null {
  if (finishReason === "length") return null;
  return toJudgement(extractJson(content ?? ""));
}
