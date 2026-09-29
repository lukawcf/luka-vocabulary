// Run: node --test supabase/functions/judge/parse.test.ts   (Node 22.6+ strips the types)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReply, followsRules, sanitize, ruleBreaks } from "./parse.ts";

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
