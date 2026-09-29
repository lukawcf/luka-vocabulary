// Run: node --test supabase/functions/judge/parse.test.ts   (Node 22.6+ strips the types)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReply } from "./parse.ts";

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
