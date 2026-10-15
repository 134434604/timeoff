// The only place that talks to Slack's Web API. No SDK: one POST per call to
// https://slack.com/api/{method}, form-encoded (every method accepts that;
// blocks and other objects go as JSON strings), the bot token in the
// Authorization header, a 10 second timeout. An error carries Slack's error
// code ("channel_not_found") and never the token.
//
// SLACK_FIXTURE=1 (through fixture-guard.mjs, and only while no real token
// and secret are set) stands in: every call is appended to
// <DATA_DIR>/slack-fixture.json and answered from a small script of canned
// replies. Who is who comes from <DATA_DIR>/slack-fixture-users.json,
// { "U_ADMIN": "admin@example.com", ... }, which tests and the QA walk seed.
// An entry may instead be an object, { email, real_name, display_name,
// team_id, is_stranger, is_bot, deleted, is_email_confirmed, is_restricted,
// delay_ms }, to play a named member, a member from another workspace, a
// bot, or a Slack that answers slowly.
// Nothing leaves the box.

import { readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fixtureFlag } from "../fixture-guard.mjs";
import * as store from "../store.mjs";

const BASE = "https://slack.com/api";
const TIMEOUT_MS = 10_000;
// In fixture mode with no secret of its own, requests are signed with this.
export const FIXTURE_SIGNING_SECRET = "practice-signing-secret";
export const FIXTURE_TEAM = "Practice Workspace";
export const FIXTURE_TEAM_ID = "TPRACTICE";
export const FIXTURE_APP_ID = "APRACTICE";

const trimmed = (value) => String(value ?? "").trim();
const dataDirOf = (ctx) => ctx.dataDir || trimmed(ctx.env?.DATA_DIR) || "data";

/** { on, fixture }: on with a real token and secret, or with the stand-in. */
export function slackSwitch(env = process.env) {
  const real = Boolean(trimmed(env.SLACK_BOT_TOKEN) && trimmed(env.SLACK_SIGNING_SECRET));
  const fixture = fixtureFlag(env, "SLACK_FIXTURE") && !real;
  return { on: real || fixture, fixture };
}

export function signingSecret(env = process.env) {
  const secret = trimmed(env.SLACK_SIGNING_SECRET);
  if (secret) return secret;
  return slackSwitch(env).fixture ? FIXTURE_SIGNING_SECRET : "";
}

// ------------------------------------------------------------ the stand-in --

export const fixtureFile = (dataDir) => path.join(dataDir, "slack-fixture.json");
export const fixtureUsersFile = (dataDir) => path.join(dataDir, "slack-fixture-users.json");

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

export function readSlackFixture(dataDir) {
  const data = readJson(fixtureFile(dataDir), null);
  return { calls: Array.isArray(data?.calls) ? data.calls : [], counter: Number(data?.counter) || 0 };
}

function writeSlackFixture(dataDir, data) {
  mkdirSync(dataDir, { recursive: true });
  const file = fixtureFile(dataDir);
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${file}.tmp`, file);
}

// A practice member as Slack's users.info would describe them.
function fixtureMember(id, entry) {
  const spec = typeof entry === "string" ? { email: entry } : entry || {};
  return {
    id,
    team_id: spec.team_id ?? FIXTURE_TEAM_ID,
    deleted: spec.deleted === true,
    is_bot: spec.is_bot === true,
    is_stranger: spec.is_stranger === true,
    is_restricted: spec.is_restricted === true,
    is_email_confirmed: spec.is_email_confirmed ?? true,
    real_name: spec.real_name ?? "",
    profile: { email: spec.email, real_name: spec.real_name ?? "", display_name: spec.display_name ?? "" },
  };
}

function fixtureAnswer(dataDir, method, body, counter) {
  const users = readJson(fixtureUsersFile(dataDir), {});
  switch (method) {
    case "users.info":
      return users[body.user] ? { ok: true, user: fixtureMember(body.user, users[body.user]) } : { ok: false, error: "user_not_found" };
    case "users.lookupByEmail": {
      const found = Object.entries(users).map(([id, entry]) => fixtureMember(id, entry)).find((member) => String(member.profile.email).toLowerCase() === String(body.email).toLowerCase());
      return found ? { ok: true, user: found } : { ok: false, error: "users_not_found" };
    }
    case "conversations.open":
      return { ok: true, channel: { id: `D${String(body.users).replace(/^U/, "")}` } };
    case "chat.postMessage":
      return { ok: true, channel: body.channel, ts: `${Math.floor(Date.now() / 1000)}.${String(counter).padStart(6, "0")}` };
    case "auth.test":
      return { ok: true, team: FIXTURE_TEAM, team_id: FIXTURE_TEAM_ID, app_id: FIXTURE_APP_ID };
    default:
      // views.open, chat.update, chat.postEphemeral, response_url
      return { ok: true };
  }
}

// How long the practice Slack takes to answer users.info for this member.
function fixtureDelay(dataDir, method, body) {
  if (method !== "users.info") return 0;
  const entry = readJson(fixtureUsersFile(dataDir), {})[body.user];
  return typeof entry === "object" && entry ? Number(entry.delay_ms) || 0 : 0;
}

function fixtureCall(dataDir, method, body, extra = {}) {
  const data = readSlackFixture(dataDir);
  data.counter += 1;
  const answer = fixtureAnswer(dataDir, method, body, data.counter);
  data.calls.push({ method, body, ...extra, ok: answer.ok, at: new Date().toISOString() });
  writeSlackFixture(dataDir, data);
  return answer;
}

// ---------------------------------------------------------------- the API --

function slackError(method, code) {
  return Object.assign(new Error(`Slack ${method}: ${code}`), { slackError: String(code || "unknown"), code: "slack_api" });
}

/**
 * Call one Web API method. Returns Slack's JSON (ok: true) or throws with
 * .slackError set. `ctx` is { env, dataDir, fetchImpl }.
 */
export async function slackCall(ctx, method, body = {}) {
  const env = ctx.env || process.env;
  if (slackSwitch(env).fixture) {
    const delay = fixtureDelay(dataDirOf(ctx), method, body);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const answer = fixtureCall(dataDirOf(ctx), method, body);
    if (!answer.ok) throw slackError(method, answer.error);
    return answer;
  }
  const token = trimmed(env.SLACK_BOT_TOKEN);
  if (!token) throw slackError(method, "not_configured");
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  let response;
  try {
    response = await (ctx.fetchImpl || globalThis.fetch)(`${BASE}/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw slackError(method, error?.name === "TimeoutError" ? "timeout" : "network");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw slackError(method, payload?.error || `http_${response.status}`);
  return payload;
}

/**
 * Answer through a response_url (a delayed reply to a slash command or a
 * button). Only Slack's own hooks host is ever posted to, so a forged
 * payload cannot point this server at another address.
 */
export async function slackRespond(ctx, responseUrl, message) {
  const env = ctx.env || process.env;
  const url = String(responseUrl ?? "");
  if (slackSwitch(env).fixture) {
    fixtureCall(dataDirOf(ctx), "response_url", message, { url });
    return;
  }
  if (!/^https:\/\/hooks\.slack\.com\//.test(url)) throw slackError("response_url", "bad_url");
  let response;
  try {
    response = await (ctx.fetchImpl || globalThis.fetch)(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw slackError("response_url", error?.name === "TimeoutError" ? "timeout" : "network");
  }
  if (!response.ok) throw slackError("response_url", `http_${response.status}`);
}

// ------------------------------------------------------------ our workspace --

/**
 * Our own workspace and app ({ team_id, team_name, app_id }), from auth.test,
 * kept in settings for an hour. Every payload and every member we link is
 * checked against it. Returns null when Slack has not answered yet (the
 * cached value is used if there is one).
 */
export async function ourWorkspace(ctx) {
  const cached = store.getSetting(ctx.db, "slack", {});
  if (cached.team_id && Date.now() - Date.parse(cached.checked_at || 0) < 60 * 60_000) return cached;
  try {
    const answer = await slackCall(ctx, "auth.test", {});
    const fresh = { team_id: String(answer.team_id || "") || null, team_name: String(answer.team || "") || null, app_id: String(answer.app_id || "") || null, checked_at: new Date().toISOString() };
    store.setSetting(ctx.db, "slack", fresh);
    return fresh;
  } catch {
    return cached.team_id ? cached : null;
  }
}

/** Resolve within `ms`, or settle to `{ timedOut: true }`: Slack allows three seconds in all. */
export function withinBudget(promise, ms) {
  let timer;
  const work = Promise.resolve(promise).finally(() => clearTimeout(timer));
  // The work keeps running after the budget is spent; a late failure is not news.
  work.catch(() => {});
  return Promise.race([
    work,
    new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); }),
  ]);
}
