import assert from "node:assert/strict";
import test from "node:test";
import { ensureScheduleSession } from "../lib/schedule-session.ts";

test("passes: an existing session is reused without creating another one", async () => {
  let createCalls = 0;
  const sessionId = await ensureScheduleSession({
    runtimeSessionId: "existing-session",
    persistedSessionId: "existing-session",
    createSession: async () => {
      createCalls += 1;
      return "unexpected";
    },
    persistSession: async () => assert.fail("existing session must not be persisted"),
    initializeSession: async () => assert.fail("existing session must not be initialized"),
    promoteSession: () => assert.fail("existing session must not be promoted"),
  });

  assert.equal(sessionId, "existing-session");
  assert.equal(createCalls, 0);
});

test("passes: an unsaved chat creates, initializes, and promotes one schedule session", async () => {
  const events: string[] = [];
  const sessionId = await ensureScheduleSession({
    runtimeSessionId: null,
    persistedSessionId: null,
    createSession: async () => {
      events.push("create");
      return "schedule-session";
    },
    persistSession: async (createdSessionId) => {
      events.push(`persist:${createdSessionId}`);
    },
    initializeSession: async (createdSessionId) => {
      events.push(`initialize:${createdSessionId}`);
    },
    promoteSession: (createdSessionId) => {
      events.push(`promote:${createdSessionId}`);
    },
  });

  assert.equal(sessionId, "schedule-session");
  assert.deepEqual(events, [
    "create",
    "persist:schedule-session",
    "initialize:schedule-session",
    "promote:schedule-session",
  ]);
});

test("persists an existing temporary runtime before a slash-menu schedule uses its ID", async () => {
  const events: string[] = [];
  const sessionId = await ensureScheduleSession({
    runtimeSessionId: "temporary-runtime",
    persistedSessionId: null,
    createSession: async () => assert.fail("the existing runtime must be reused"),
    persistSession: async (createdSessionId) => { events.push(`persist:${createdSessionId}`); },
    initializeSession: async (createdSessionId) => { events.push(`initialize:${createdSessionId}`); },
    promoteSession: (createdSessionId) => { events.push(`promote:${createdSessionId}`); },
  });

  assert.equal(sessionId, "temporary-runtime");
  assert.deepEqual(events, [
    "persist:temporary-runtime",
    "initialize:temporary-runtime",
    "promote:temporary-runtime",
  ]);
});

test("fails safely: a missing workspace session does not initialize or promote", async () => {
  let initialized = false;
  let promoted = false;
  const sessionId = await ensureScheduleSession({
    runtimeSessionId: null,
    persistedSessionId: null,
    createSession: async () => null,
    persistSession: async () => assert.fail("missing session must not be persisted"),
    initializeSession: async () => { initialized = true; },
    promoteSession: () => { promoted = true; },
  });

  assert.equal(sessionId, null);
  assert.equal(initialized, false);
  assert.equal(promoted, false);
});

test("fails safely: initialization errors prevent promotion", async () => {
  let promoted = false;
  await assert.rejects(
    ensureScheduleSession({
      runtimeSessionId: null,
      persistedSessionId: null,
      createSession: async () => "schedule-session",
      persistSession: async () => {},
      initializeSession: async () => { throw new Error("SSE unavailable"); },
      promoteSession: () => { promoted = true; },
    }),
    /SSE unavailable/,
  );
  assert.equal(promoted, false);
});
