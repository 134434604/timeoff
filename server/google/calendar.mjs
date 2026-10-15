// The only place in the app that reads or writes Google Calendar. Same
// shape as the Google API client of an earlier project: an injectable fetch so tests
// never leave the box, a Bearer header from calendar-grant.mjs, a hard
// timeout, one forced token refresh on a 401, one retry on 429/5xx, and
// errors that carry .googleStatus with a redacted body (not .status: the
// server shows a browser only errors with an HTTP status of its own).
//
// Time off is an all-day event. Google's all-day end date is exclusive, so
// an event for Oct 19-21 is sent as start 2026-10-19, end 2026-10-22.
//
// With CALENDAR_FIXTURE on, the same three calls read and write
// <DATA_DIR>/calendar-fixture.json instead. An event on a calendar that is
// not in that file fails the way a deleted Google calendar would (404), so
// the "approval kept, calendar write queued" path can be walked offline.

import { addDays } from "../domain/dates.mjs";
import { calendarSwitch, getAccessToken, readFixture, safeErrorBody, writeFixture } from "./calendar-grant.mjs";

const BASE = "https://www.googleapis.com/calendar/v3";
const DEFAULT_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dataDirOf = (env) => String(env.DATA_DIR ?? "").trim() || "data";

function apiError(status, body) {
  return Object.assign(new Error(`Google Calendar ${status}: ${safeErrorBody(body)}`), { googleStatus: status, code: "calendar_api" });
}

async function request(url, { method = "GET", body, env, dataDir, fetchImpl, timeoutMs }) {
  let force = false;
  let refreshed = false;
  let retried = false;
  for (;;) {
    const token = await getAccessToken({ env, dataDir, fetchImpl, force });
    force = false;
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return response.status === 204 ? null : response.json().catch(() => null);
    // An expired access token looks exactly like a revoked grant here, so
    // try one forced refresh before believing the 401.
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      force = true;
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && !retried) {
      retried = true;
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    throw apiError(response.status, await response.text().catch(() => ""));
  }
}

function options(opts = {}) {
  const env = opts.env || process.env;
  return { env, dataDir: opts.dataDir || dataDirOf(env), fetchImpl: opts.fetchImpl || globalThis.fetch, timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS };
}

function fixtureConnected(dataDir) {
  const data = readFixture(dataDir);
  if (!data.account_email) throw Object.assign(new Error("The shared calendar is not connected."), { status: 409, code: "calendar_not_connected" });
  return data;
}

/** [{ id, name, writable }] for every calendar the connected account can see. */
export async function listCalendars(opts) {
  const o = options(opts);
  if (calendarSwitch(o.env).fixture) return fixtureConnected(o.dataDir).calendars.map((row) => ({ id: String(row.id), name: String(row.name), writable: row.writable === true }));
  const calendars = [];
  let pageToken = null;
  for (let page = 0; page < 5; page += 1) {
    const params = new URLSearchParams({ maxResults: "250" });
    if (pageToken) params.set("pageToken", pageToken);
    const payload = await request(`${BASE}/users/me/calendarList?${params}`, o);
    for (const item of payload?.items || []) {
      calendars.push({ id: String(item.id), name: String(item.summaryOverride || item.summary || item.id), writable: item.accessRole === "owner" || item.accessRole === "writer" });
    }
    pageToken = payload?.nextPageToken || null;
    if (!pageToken) break;
  }
  return calendars;
}

/**
 * The event id for a request, the same every time: Google ids are base32hex
 * (0-9, a-v), 5 to 1024 characters, and a request id's hex fits. Sending it
 * makes the insert idempotent: a retry after a timeout, a double click or a
 * restart mid-write gets 409 instead of a second event.
 */
export function eventIdFor(requestId) {
  return `timeoff${String(requestId ?? "").toLowerCase().replace(/^req_/, "").replace(/[^0-9a-v]/g, "")}`;
}

/**
 * Add one all-day event with the given id; returns { id, existed }. An
 * event with that id already there (Google's 409) counts as added.
 */
export async function insertAllDayEvent({ eventId, calendarId, summary, description, start_date, end_date }, opts) {
  const o = options(opts);
  if (!/^[0-9a-v]{5,1024}$/.test(String(eventId ?? ""))) throw new Error("insertAllDayEvent needs a base32hex event id");
  const event = { id: eventId, summary, description, start: { date: start_date }, end: { date: addDays(end_date, 1) } };
  if (calendarSwitch(o.env).fixture) {
    const data = fixtureConnected(o.dataDir);
    const calendar = data.calendars.find((row) => row.id === calendarId);
    if (!calendar || calendar.writable !== true) throw apiError(404, "Not Found");
    if (data.events.some((row) => row.id === eventId && row.calendarId === calendarId)) return { id: eventId, existed: true };
    data.events.push({ calendarId, ...event, created_at: new Date().toISOString() });
    writeFixture(o.dataDir, data);
    return { id: eventId, existed: false };
  }
  try {
    const payload = await request(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events`, { ...o, method: "POST", body: event });
    return { id: String(payload?.id || eventId), existed: false };
  } catch (error) {
    if (error.googleStatus === 409) return { id: eventId, existed: true };
    throw error;
  }
}

/** Remove one event. An event already gone (404/410) counts as removed. */
export async function deleteEvent({ calendarId, eventId }, opts) {
  const o = options(opts);
  if (calendarSwitch(o.env).fixture) {
    const data = fixtureConnected(o.dataDir);
    data.events = data.events.filter((row) => !(row.id === eventId && row.calendarId === calendarId));
    writeFixture(o.dataDir, data);
    return { removed: true };
  }
  try {
    await request(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { ...o, method: "DELETE" });
  } catch (error) {
    if (error.googleStatus === 404 || error.googleStatus === 410) return { removed: true };
    throw error;
  }
  return { removed: true };
}

/** A plain sentence for the screen about why a calendar write did not land. */
export function calendarErrorWords(error) {
  const status = Number(error?.googleStatus);
  if (error?.code === "calendar_not_connected") return "The shared calendar is not connected. Connect it in Settings.";
  if (status === 401 || status === 403) return "The calendar connection no longer has permission. Reconnect the calendar in Settings.";
  if (status === 404 || status === 410) return "The chosen calendar was not found. Choose another in Settings.";
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "The calendar did not answer in time. It will be tried again.";
  return "The shared calendar could not be updated. It will be tried again.";
}
