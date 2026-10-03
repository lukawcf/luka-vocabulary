// Run: node --test supabase/functions/judge/parse.test.ts   (Node 22.6+ strips the types)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReply, followsRules, sanitize, ruleBreaks, diffWords, spotNote } from "./parse.ts";

const good = '{"verdict":"good","issues":[],"praise":"很自然","usage":"常用来描述问题出现：an issue arises"}';

test("plain JSON", () => {
  assert.equal(parseReply(good, "stop")?.verdict, "good");
});

test("JSON inside a ```json fence with text around it", () => {
  const r = parseReply("Here you go:\n```json\n" + good + "\n```\nHope it helps", "stop");
  assert.equal(r?.praise, "很自然");
});

test("reasoning block before the JSON", () => {
  assert.equal(parseReply("<think>let me check { the grammar }</think>\n" + good, "stop")?.verdict, "good");
});

test("one sentence before the object", () => {
  assert.equal(parseReply("Result: " + good, "stop")?.verdict, "good");
});

test("reply cut off by the length limit is rejected", () => {
  assert.equal(parseReply(good, "length"), null);
  assert.equal(parseReply('{"verdict":"bad","issues":[{"type":"grammar","note":"\'may\' 后', "length"), null);
});

test("missing or unknown verdict is rejected, never turned into bad", () => {
  assert.equal(parseReply('{"issues":[],"praise":"","usage":"x"}', "stop"), null);
  assert.equal(parseReply('{"verdict":"pass"}', "stop"), null);
});

test("not JSON at all", () => {
  assert.equal(parseReply("Sorry, I cannot help with that.", "stop"), null);
  assert.equal(parseReply("", "stop"), null);
  assert.equal(parseReply("[1,2,3]", "stop"), null);
});

test("fields are normalised", () => {
  const r = parseReply(JSON.stringify({
    verdict: "bad",
    issues: [{ type: "weird", note: "'may' 后面少了一个动作" }, { type: "grammar" }, 5, { note: "a" }, { note: "b" }, { note: "c" }],
    praise: "should be dropped for bad",
  }), "stop");
  assert.equal(r?.verdict, "bad");
  assert.equal(r?.praise, "");
  assert.equal(r?.usage, "");
  assert.deepEqual(r?.issues[0], { type: "usage", note: "'may' 后面少了一个动作" });
  assert.ok((r?.issues.length ?? 0) <= 4);
  assert.ok(r?.issues.every((x) => x.note));
});

// Real reply from qwen-plus that broke the feedback rules (grammar terms + the answer).
const learner = "AI may arise information dangerous.";
const realBad = {
  verdict: "bad" as const,
  praise: "",
  usage: "'arise' 通常指问题、困难等自己出现。常见搭配有：a problem arises、an issue arises。",
  issues: [
    { type: "usage", note: "'arise' 后面不能直接跟 'information dangerous'，这个词不能像动词一样带宾语" },
    { type: "grammar", note: "'information dangerous' 语序和搭配都错了，'dangerous information' 才是常见说法" },
  ],
};

test("grammar terms and given answers break the rules", () => {
  assert.equal(followsRules(realBad, learner), false);
  assert.equal(ruleBreaks("'dangerous information' 是常见说法", learner), true); // quotes words not in the sentence
  assert.equal(ruleBreaks("'may' 后面少了一个动作", learner), false);
  assert.equal(ruleBreaks("看看 'no' 后面通常接可数的还是不可数的东西", learner), true);
  assert.equal(ruleBreaks("'arise' 后面接的东西不对，想想它通常描述什么自己出现", learner), false);
});

test("usage may name collocations but not grammar terms", () => {
  const ok = { ...realBad, issues: [{ type: "usage", note: "'arise' 后面接的东西不对" }] };
  assert.equal(followsRules(ok, learner), true);
  assert.equal(followsRules({ ...ok, usage: "arise 是不及物动词" }, learner), false);
});

test("sanitize drops offending notes and keeps a bad verdict explained", () => {
  const s = sanitize(realBad, learner);
  assert.equal(s.issues.length, 1);
  assert.ok(!/宾语|才是|动词/.test(s.issues[0].note));
  assert.equal(s.usage, realBad.usage);
});

test("word diff: typos, wrong forms, missing and extra words", () => {
  const d1 = diffWords("CMU is a rare place that invents the fureture.", "CMU is a rare place that invents the future.", "rare");
  assert.deepEqual(d1.typos, ["fureture"]);
  assert.deepEqual(d1.spots, []);
  const d2 = diffWords("It is a rare place that invent the future.", "It is a rare place that invents the future.", "rare");
  assert.deepEqual(d2.typos, []);
  assert.deepEqual(d2.spots, [{ word: "invent", kind: "wrong", fix: ["invents"] }]);
  const d3 = diffWords("He have many issue with his boss.", "He has many issues with his boss.", "issue");
  assert.deepEqual(d3.spots.map((x) => x.word), ["have", "issue"]);
  const d4 = diffWords("It is rare bird.", "It is a rare bird.", "rare");
  assert.deepEqual(d4.spots, [{ word: "is", kind: "missing", fix: ["a"] }]);
  const d5 = diffWords("I very like the issue.", "I like the issue.", "issue");
  assert.deepEqual(d5.spots, [{ word: "very", kind: "extra", fix: [] }]);
  const d6 = diffWords("It is a rair bird.", "It is a rare bird.", "rare");
  assert.deepEqual(d6.spots, [{ word: "rair", kind: "wrong", fix: ["rare"] }]); // the target word itself is never just a typo
  assert.equal(diffWords("We need to discuss this issue.", "We need to discuss this issue.", "issue").changed, 0);
  assert.deepEqual(diffWords("I focus on my study.", "I focus on my studies.", "focus").typos, []); // a word form, not a typo
  assert.deepEqual(diffWords("See you tomorow.", "See you tomorrow.", "see").typos, ["tomorow"]);
});

test("sanitize keeps where the problem is when every note broke the rules", () => {
  const s = "It is a rare place that invent the future.";
  const j = { verdict: "bad" as const, praise: "", usage: "", issues: [{ type: "grammar", note: "'invent' 要用第三人称单数 'invents'" }] };
  const out = sanitize(j, s);
  assert.equal(out.issues.length, 1);
  assert.ok(out.issues[0].note.startsWith("'invent' 这里不太对"));
  assert.ok(!out.issues[0].note.includes("invents"));
});

test("narrow fit reply maps to a judgement", () => {
  assert.deepEqual(parseReply('{"fits":true,"note":"","praise":"不错","usage":"u"}', "stop"),
    { verdict: "good", issues: [], praise: "不错", usage: "u" });
  const bad = parseReply(JSON.stringify({ fits: false, note: "'rare' 这里的意思对不上", praise: "x", usage: "u" }), "stop");
  assert.equal(bad?.verdict, "bad");
  assert.equal(bad?.praise, "");
  assert.deepEqual(bad?.issues, [{ type: "usage", note: "'rare' 这里的意思对不上" }]);
  assert.equal(parseReply('{"fits":"yes"}', "stop"), null);
});

test("small linking words may be given, other answers may not", () => {
  const s = "I am interested this issue because so it matters.";
  assert.equal(ruleBreaks("'interested' 后面要加 'in'", s), false);
  assert.equal(ruleBreaks("'because' 和 'so' 只留一个", s), false);
  assert.equal(ruleBreaks("'interested' 后面要加 'in'，这是介词", s), true);   // grammar term
  assert.equal(ruleBreaks("'issue' 应该改成 'issues'", s), true);            // a real word given away
  assert.equal(ruleBreaks("看看 matters 前面的 it 是不是多了", s), false);    // the learner's own words
  assert.equal(ruleBreaks("改成 mattered 就对了", s), true);                  // unquoted answer
});

test("fallback notes give the answer only for small linking words", () => {
  assert.equal(spotNote({ word: "is", kind: "missing", fix: ["a"] }), "'is' 后面少了 'a'。");
  assert.equal(spotNote({ word: "in", kind: "wrong", fix: ["at"] }), "'in' 这里要用 'at'。");
  assert.equal(spotNote({ word: "in", kind: "extra", fix: [] }), "'in' 这里多余，去掉它。");
  assert.ok(!spotNote({ word: "invent", kind: "wrong", fix: ["invents"] }).includes("invents"));
});
