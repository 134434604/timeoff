// scripts/set-domain.mjs, on text only (the docs themselves are left alone).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostsIn, rewrite } from "../scripts/set-domain.mjs";

test("set-domain: every app address, the bare host and the placeholders; nothing else", () => {
  const text = [
    "url: https://timeoff.oldco.com/api/slack/commands",
    "Redirect: https://timeoff.oldco.com/api/auth/google/callback.",
    "DNS: point timeoff.oldco.com at the server.",
    "Open timeoff.<company domain> or timeoff.<your company domain>.",
    "The database is data/timeoff.sqlite; mytimeoff.oldco.com.au stays.",
  ].join("\n");
  assert.deepEqual(hostsIn(text), ["timeoff.oldco.com"]);
  const { text: out, changed } = rewrite(text, "timeoff.acme.com");
  assert.equal(changed, 5);
  assert.match(out, /https:\/\/timeoff\.acme\.com\/api\/slack\/commands/);
  assert.match(out, /callback\.$/m);
  assert.match(out, /DNS: point timeoff\.acme\.com at/);
  assert.match(out, /Open timeoff\.acme\.com or timeoff\.acme\.com\./);
  assert.match(out, /data\/timeoff\.sqlite; mytimeoff\.oldco\.com\.au stays\./);
  assert.equal(rewrite(out, "timeoff.acme.com").changed, 0);
});
