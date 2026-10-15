// Slack signs every request it sends us (the slash command and button
// clicks): v0=HMAC-SHA256(signing secret, "v0:{timestamp}:{raw body}"). The
// signature is the whole guard for /api/slack/*, which is why those routes
// read the raw body and skip the JSON-only rule the browser routes use: a
// forged or replayed request is refused here, before anything is parsed.
//
// Timestamps more than five minutes from now are refused too, so a
// captured request cannot be replayed later.

import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_SECONDS = 5 * 60;

export function slackSignature(secret, timestamp, rawBody) {
  return `v0=${createHmac("sha256", String(secret)).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

/** True only for a fresh request signed with `secret`. */
export function verifySlackRequest({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret) return false;
  const ts = String(timestamp ?? "");
  if (!/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(slackSignature(secret, ts, rawBody));
  const given = Buffer.from(String(signature ?? ""));
  return expected.length === given.length && timingSafeEqual(expected, given);
}
