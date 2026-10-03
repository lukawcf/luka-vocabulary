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
  let r = value as Record<string, unknown>;
  // the server's narrow "does the word fit" reply: {fits, note, praise, usage}
  if (r.verdict === undefined && typeof r.fits === "boolean") {
    r = { ...r, verdict: r.fits ? "good" : "bad", issues: r.fits ? [] : [{ type: "usage", note: r.note }] };
  }
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

// Feedback rules the product promises: plain words, no grammar jargon, and no answers except for
// small linking words. Models do not always follow the prompt, so the server checks. A note breaks
// the rules when it uses a grammar term, or contains an English word that is neither in the
// learner's own sentence nor a small linking word (that would be handing them the answer).
const GRAMMAR_TERMS = /主语|谓语|宾语|表语|定语|状语|补语|及物|不及物|词性|从句|时态|语法成分|语序|动词|名词|形容词|副词|介词|冠词|代词|连词|单数|复数|第三人称|过去式|过去分词|现在分词|被动语态|主动语态|不定式|动名词|可数|不可数/;
const QUOTED = /'([^']+)'|‘([^’]+)’|"([^"]+)"|“([^”]+)”/g;
export const SMALL_WORDS = new Set(("a an the and but or so because if when while than that which who whom whose what where " +
  "in on at to of for with from by about into onto over under after before since until as it its there this these those").split(" "));
const englishWords = (s: string) => (s.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []);

export function ruleBreaks(note: string, sentence: string): boolean {
  if (GRAMMAR_TERMS.test(note)) return true;
  const own = new Set(englishWords(sentence));
  if (englishWords(note).some((w) => !own.has(w) && !SMALL_WORDS.has(w))) return true;
  // a quoted phrase made of the learner's own words in a new order is an answer too
  // (small linking words in it are ignored, since those may be given)
  const text = " " + englishWords(sentence).join(" ") + " ";
  for (const m of note.matchAll(QUOTED)) {
    const plain = englishWords(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").filter((w) => !SMALL_WORDS.has(w));
    if (plain.length > 1 && !text.includes(" " + plain.join(" ") + " ")) return true;
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

// Correction pre-pass. A small model grading a sentence that also has a typo or a grammar slip
// tends to blame the target word for it ("'rare' 不能形容 place"). So the server first asks for a
// minimally corrected sentence, grades the corrected one for how the target word is used, and
// finds the slips itself by comparing the two word by word (diffWords). A one-word change that
// looks like a typo is only pointed out; any other change is a real mistake at that spot.
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
  // same stem with a different ending (study → studies, make → making) is a word form, not a typo
  let k = 0;
  while (k < w.length && k < r.length && w[k] === r[k]) k++;
  if (w.length !== r.length && k >= Math.min(w.length, r.length) - 1) return false;
  return editDistance(w, r) <= (r.length >= 7 ? 3 : 2);
}

export type Spot = { word: string; kind: "wrong" | "missing" | "extra"; fix: string[] };
export type WordDiff = { typos: string[]; spots: Spot[]; changed: number; total: number };

const WORD = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
const words = (s: string) => [...String(s ?? "").matchAll(WORD)].map((m) => m[0]);

// Longest-common-subsequence alignment of the two word lists; every run of unmatched words is one
// change. Punctuation and letter case are ignored.
export function diffWords(original: string, fixed: string, target: string): WordDiff {
  const a = words(original), b = words(fixed);
  const A = a.map((w) => w.toLowerCase()), B = b.map((w) => w.toLowerCase());
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: WordDiff = { typos: [], spots: [], changed: 0, total: n };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { i++; j++; continue; }
    const i0 = i, j0 = j;
    while ((i < n || j < m) && !(i < n && j < m && A[i] === B[j])) {
      if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) i++; else j++;
    }
    const gone = a.slice(i0, i), added = b.slice(j0, j);
    out.changed += Math.max(gone.length, added.length);
    if (gone.length === 1 && added.length === 1 && looksLikeTypo(gone[0], added[0], target)) out.typos.push(gone[0]);
    else if (gone.length) out.spots.push({ word: gone.join(" "), kind: added.length ? "wrong" : "extra", fix: added });
    else out.spots.push({ word: a[i0 - 1] ?? a[i0] ?? "", kind: "missing", fix: added });
  }
  out.spots = out.spots.filter((x) => x.word);
  return out;
}

// Used when no rule-following hint could be written for a spot. Small linking words get the answer.
export function spotNote(x: Spot): string {
  const small = (ws: string[]) => ws.length > 0 && ws.every((w) => SMALL_WORDS.has(w.toLowerCase()));
  const fix = x.fix.map((w) => w.toLowerCase()).join(" ");
  if (x.kind === "missing" && small(x.fix)) return `'${x.word}' 后面少了 '${fix}'。`;
  if (x.kind === "extra" && small(x.word.split(" "))) return `'${x.word}' 这里多余，去掉它。`;
  if (x.kind === "wrong" && small(x.word.split(" ")) && small(x.fix)) return `'${x.word}' 这里要用 '${fix}'。`;
  if (x.kind === "missing") return `'${x.word}' 附近少了一点东西，读一读，想想这里还缺什么。`;
  if (x.kind === "extra") return `'${x.word}' 这里好像多了点什么，读一读，想想去掉会不会更顺。`;
  return `'${x.word}' 这里不太对，再读一遍这一处，想想哪里要变一变。`;
}

// finish_reason "length" means the reply was cut off, so even parseable JSON is incomplete.
export function parseReply(content: string, finishReason: string | null | undefined): Judgement | null {
  if (finishReason === "length") return null;
  return toJudgement(extractJson(content ?? ""));
}
