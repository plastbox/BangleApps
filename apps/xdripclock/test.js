/* eslint-env node, es6 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const START = 1790949600000;
const PERIOD = 310000;
const WINDOW = 7200000;
const DAY = 86400000;

function snapshot(now = START, changes = {}) {
  const latest = [now, 130];
  return {
    version: 1, bg: [latest], latest, treatments: [], lastTreatment: 0,
    thresholds: [70, 180], thresholdTime: now, units: "mmol",
    lastAttempt: now - 60000, ...changes
  };
}

function device(options = {}) {
  let now = options.now || START;
  let nextTimer = 0;
  let color;
  let locked = false;
  let cached = options.rawCache !== undefined ? options.rawCache :
    options.cache ? JSON.stringify(options.cache) : undefined;
  const timers = new Map();
  const requests = [];
  const calls = [];
  const logs = [];
  const writes = [];
  const buzzes = [];
  const bangle = new EventEmitter();
  const g = { theme: { fg: "#ffffff" } };
  for (const method of ["reset", "clear", "setClipRect", "clearRect", "setColor",
    "drawLine", "fillCircle", "drawPoly", "setFont", "setFontAlign", "drawString"]) {
    g[method] = function(...args) {
      if (method === "setColor") color = args[0];
      calls.push({ method, args, color, time: now });
      return g;
    };
  }
  g.getWidth = () => 176;
  g.getHeight = () => 176;
  g.getFontHeight = () => 24;
  g.stringWidth = value => value.length * 14;
  bangle.appRect = options.rect || { x: 0, y: 24, x2: 175, y2: 175, w: 176, h: 152 };
  bangle.setUI = ui => { bangle.ui = ui; };
  bangle.loadWidgets = () => {};
  bangle.drawWidgets = () => {};
  bangle.isLocked = () => locked;
  bangle.buzz = () => { buzzes.push(now); return Promise.resolve(); };
  if (!options.noHTTP) {
    bangle.http = (url, requestOptions) => new Promise((resolve, reject) => {
      requests.push({ url, options: requestOptions, time: now, resolve, reject });
    });
  }
  const storage = {
    read: () => cached,
    readJSON: () => cached && JSON.parse(cached),
    write: (name, value) => { cached = value; writes.push(JSON.parse(value)); }
  };
  const context = vm.createContext({
    Bangle: bangle, g, Promise, Date: { now: () => now },
    console: { log: (...args) => logs.push(args.map(String).join(" ")) },
    require: name => { assert.equal(name, "Storage"); return storage; },
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, time: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id)
  });
  function start() { vm.runInContext(source, context); }
  start();
  async function flush() {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  }
  async function advance(ms) {
    const end = now + ms;
    let iterations = 0;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].time - b[1].time)[0];
      if (!next || next[1].time > end) break;
      assert.ok(++iterations < 10000, "Scheduler must not spin");
      now = next[1].time;
      timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    now = end;
    await flush();
  }
  return {
    bangle, calls, requests, writes, logs, buzzes, timers, start, flush, advance,
    now: () => now,
    cache: () => cached && JSON.parse(cached),
    lock: value => { locked = value; },
    touch: (event = {}) => bangle.emit("touch", 1, { type: 2, x: 88, y: 88, ...event }),
    reply: async (index, value) => {
      requests[index].resolve({ resp: JSON.stringify(value) });
      await flush();
    },
    fail: async index => { requests[index].reject(new Error("offline")); await flush(); },
    remove: () => bangle.ui.remove()
  };
}

function readout(h) {
  return h.calls.filter(call => call.method === "drawString").at(-1).args[0];
}

function strike(h) {
  return h.calls.some(call => call.method === "drawLine" &&
    call.args[1] === h.bangle.appRect.y + 15 && call.args[3] === call.args[1] &&
    call.args[0] === h.bangle.appRect.x + 3);
}

test("restores cached BG without fetching fresh data; preserves bottom widgets", async () => {
  const rect = { x: 0, y: 24, x2: 175, y2: 151, w: 176, h: 128 };
  const h = device({ cache: snapshot(), rect });
  await h.flush();
  assert.equal(readout(h), "7.2");
  assert.equal(h.requests.length, 0);
  assert.equal(h.bangle.ui.mode, "clock");
  for (const call of h.calls.filter(call => call.method === "clearRect")) {
    assert.ok(call.args[1] >= rect.y && call.args[3] <= rect.y2);
  }
  assert.deepEqual(h.calls.filter(call => call.method === "setClipRect").at(-1).args, [0, 0, 175, 175]);
});

test("known thresholds are solid even when old; entry refresh does not fetch fresh BG", async () => {
  const h = device({ cache: snapshot(START, { thresholdTime: START - DAY - 1 }) });
  const lines = h.calls.filter(call => call.method === "drawLine");
  assert.equal(lines.length, 2);
  assert.ok(lines.every(call => call.args[2] === 172));
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].url, /\/status\.json$/);
  await h.fail(0);
  assert.equal(h.cache().thresholds[0], 70);
  assert.ok(h.logs.some(log => log.includes("status.json")));
  await h.advance(PERIOD);
  assert.match(h.requests[1].url, /\/sgv\.json\?/);
});

test("threshold age must exceed 24 hours to trigger entry refresh", async () => {
  const h = device({ cache: snapshot(START, { thresholdTime: START - DAY }) });
  await h.flush();
  assert.equal(h.requests.length, 0);
});

test("only unknown thresholds use dashed 4-9 mmol/L defaults", async () => {
  const h = device({ cache: snapshot(START, { thresholds: null, thresholdTime: 0 }) });
  const lines = h.calls.filter(call => call.method === "drawLine");
  assert.ok(lines.length > 20);
  assert.ok(lines.every(call => call.args[2] - call.args[0] <= 4));
  await h.flush();
  await h.reply(0, { settings: { thresholds: { bgLow: 80, bgHigh: 160 } } });
  h.calls.length = 0;
  await h.advance(60000);
  assert.equal(h.calls.filter(call => call.method === "drawLine").length, 2);
});

test("BG deadline and strikethrough are exactly sample timestamp plus 310 seconds while locked", async () => {
  const h = device({ cache: snapshot() });
  h.lock(true);
  await h.advance(PERIOD - 1);
  assert.equal(h.requests.length, 0);
  assert.equal(strike(h), false);
  h.calls.length = 0;
  await h.advance(1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].time, START + PERIOD);
  assert.equal(strike(h), true);
  assert.equal(h.buzzes.length, 0);
});

test("failed BG blocks dependent requests and retries exactly 60 seconds after the attempt", async () => {
  const h = device({ cache: snapshot(START, { latest: [START - PERIOD, 130] }) });
  await h.flush();
  await h.fail(0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.cache().latest[1], 130);
  await h.advance(59999);
  assert.equal(h.requests.length, 1);
  await h.advance(1);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].time - h.requests[0].time, 60000);
});

test("re-entry and reboot retain the BG attempt throttle", async () => {
  const h = device({ cache: snapshot(START, { latest: [START - PERIOD, 130] }) });
  await h.flush();
  await h.fail(0);
  h.remove();
  h.start();
  await h.flush();
  assert.equal(h.requests.length, 1);
  const reboot = device({ cache: h.cache() });
  await reboot.flush();
  assert.equal(reboot.requests.length, 0);
  await reboot.advance(60000);
  assert.equal(reboot.requests.length, 1);
});

test("valid but old BG resumes treatment communication without becoming fresh", async () => {
  const old = START - PERIOD - 1000;
  const h = device({ cache: snapshot(START, { latest: [old, 130], bg: [[old, 130]] }) });
  await h.flush();
  await h.reply(0, [{ date: old, sgv: 130, units_hint: "mmol" }]);
  assert.match(h.requests[1].url, /\/treatments\.json\?count=100$/);
  await h.reply(1, []);
  assert.equal(strike(h), true);
  await h.advance(60000);
  assert.match(h.requests[2].url, /\/sgv\.json\?/);
});

test("filters the exact time window, normalizes units, merges timestamps, and retains latest", async () => {
  const h = device({ cache: snapshot(START, { latest: [START - PERIOD, 130], bg: [] }) });
  await h.flush();
  await h.reply(0, [
    { date: START, sgv: 180, units_hint: "mgdl" },
    { date: START - WINDOW, sgv: 70 },
    { date: START - WINDOW - 1, sgv: 60 },
    { date: START - 100000, sgv: 140 },
    { date: START - 100000, sgv: 150 },
    { date: START + 1, sgv: 300 }
  ]);
  assert.equal(readout(h), "180");
  assert.deepEqual(h.cache().bg, [[START - WINDOW, 70], [START - 100000, 150], [START, 180]]);
  assert.deepEqual(h.cache().latest, [START, 180]);
  assert.ok(h.logs.some(log => log.includes("invalid glucose")));
  await h.reply(1, []);
});

test("empty BG is valid communication, retains history and cached units", async () => {
  const old = START - PERIOD;
  const h = device({ cache: snapshot(START, { latest: [old, 130], bg: [[old, 130]] }) });
  await h.flush();
  await h.reply(0, []);
  assert.equal(readout(h), "7.2");
  assert.deepEqual(h.cache().bg, [[old, 130]]);
  assert.match(h.requests[1].url, /\/treatments\.json/);
});

test("BG dots include threshold boundaries and do not connect samples", () => {
  const h = device({ cache: snapshot(START, {
    bg: [[START - 40000, 69], [START - 30000, 70], [START - 20000, 180], [START - 10000, 181]]
  }) });
  const dots = h.calls.filter(call => call.method === "fillCircle");
  assert.deepEqual(dots.map(dot => dot.color), ["#ff0000", "#00ff00", "#00ff00", "#ff0000"]);
  assert.equal(h.calls.filter(call => call.method === "drawLine").length, 2);
});

test("eligible injections exclude Priming only, and use crossed cyan diamonds", async () => {
  const h = device({ cache: snapshot(START, { latest: [START - PERIOD, 130] }) });
  await h.flush();
  await h.reply(0, []);
  await h.reply(1, [
    { created_at: START, insulin: 1, notes: "Priming pen" },
    { created_at: START - 1000, insulin: 2, notes: "priming" },
    { created_at: START - 2000, insulin: 3, notes: null },
    { created_at: START - WINDOW, insulin: 4 },
    { created_at: START - WINDOW - 1, insulin: 5 },
    { created_at: START - 4000, carbs: 20 },
    { created_at: START - 5000, insulin: 0 },
    { created_at: START - 6000, insulin: -1 }
  ]);
  assert.deepEqual(h.cache().treatments, [[START - 1000, 2], [START - 2000, 3], [START - WINDOW, 4]]);
  assert.equal(h.cache().lastTreatment, START - 1000);
  const diamonds = h.calls.filter(call => call.method === "drawPoly");
  assert.equal(diamonds.length, 3);
  assert.ok(diamonds.every(call => call.color === "#00ffff" && call.args[1] === true));
});

test("scale expands in both directions for glucose and insulin, then contracts", async () => {
  const latest = [START, 18.01559 * 20];
  const h = device({ cache: snapshot(START, { latest, bg: [latest], treatments: [[START, 1]] }) });
  const dot = h.calls.find(call => call.method === "fillCircle");
  const diamond = h.calls.find(call => call.method === "drawPoly");
  assert.equal(dot.args[1], 27);
  assert.equal(diamond.args[0][3], 172);
  await h.advance(WINDOW + 1);
  assert.equal(readout(h), "20.0");
  h.calls.length = 0;
  await h.advance(60000);
  assert.equal(h.calls.filter(call => call.method === "fillCircle" || call.method === "drawPoly").length, 0);
});

test("recent eligible injection suppresses periodic fetching until the two-hour boundary", async () => {
  const h = device({ cache: snapshot(START, {
    latest: [START - PERIOD, 130], lastTreatment: START - WINDOW + 60000
  }) });
  await h.flush();
  await h.reply(0, []);
  assert.equal(h.requests.length, 1);
  await h.advance(60000);
  await h.reply(1, []);
  assert.match(h.requests[2].url, /\/treatments\.json/);
});

test("unlocked long press overrides freshness and injection cooldown, with two vibrations", async () => {
  const h = device({ cache: snapshot(START, { lastTreatment: START - 1000 }) });
  h.touch({ type: 1 });
  h.touch({ y: 10 });
  h.lock(true);
  h.touch();
  await h.flush();
  assert.equal(h.requests.length, 0);
  h.lock(false);
  h.touch();
  h.touch();
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.buzzes.length, 1);
  await h.reply(0, []);
  await h.reply(1, []);
  assert.match(h.requests[2].url, /\/status\.json$/);
  await h.reply(2, { settings: { thresholds: { bgLow: 80, bgHigh: 170 } } });
  assert.equal(h.buzzes.length, 2);
  assert.deepEqual(h.cache().thresholds, [80, 170]);
  h.touch();
  await h.flush();
  assert.equal(h.requests.length, 3);
  await h.advance(60000);
  assert.equal(h.requests.length, 3, "Blocked touches must not queue a refresh");
});

test("manual BG failure prevents both dependent endpoints and still finishes haptics", async () => {
  const h = device({ cache: snapshot() });
  h.touch();
  await h.flush();
  await h.fail(0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.buzzes.length, 2);
});

test("manual treatment failure retains data and does not prevent threshold fetching", async () => {
  const treatments = [[START - 1000, 5]];
  const h = device({ cache: snapshot(START, { treatments }) });
  h.touch();
  await h.flush();
  await h.reply(0, []);
  await h.fail(1);
  assert.match(h.requests[2].url, /\/status\.json$/);
  await h.fail(2);
  assert.deepEqual(h.cache().treatments, treatments);
  assert.deepEqual(h.cache().thresholds, [70, 180]);
  assert.equal(h.buzzes.length, 2);
  assert.ok(h.logs.some(log => log.includes("treatments.json")));
  assert.ok(h.logs.some(log => log.includes("status.json")));
});

test("failed required thresholds retry only after successful BG", async () => {
  const h = device({ cache: snapshot(START, { thresholdTime: START - DAY - 1 }) });
  await h.flush();
  await h.fail(0);
  await h.advance(PERIOD);
  await h.fail(1);
  assert.equal(h.requests.length, 2);
  await h.advance(60000);
  await h.reply(2, []);
  await h.reply(3, []);
  assert.match(h.requests[4].url, /\/status\.json$/);
});

test("invalid BG JSON and schema are failures, not successful communication", async () => {
  for (const response of ["not JSON", JSON.stringify({ error: "denied" }),
    JSON.stringify([{ date: START, sgv: 130, units_hint: "unknown" }])]) {
    const h = device({ cache: snapshot(START, { latest: [START - PERIOD, 130] }) });
    await h.flush();
    h.requests[0].resolve({ resp: response });
    await h.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.cache().latest[1], 130);
    assert.ok(h.logs.some(log => log.includes("sgv.json")));
  }
});

test("malformed thresholds do not replace cached thresholds", async () => {
  const h = device({ cache: snapshot(START, { thresholdTime: START - DAY - 1 }) });
  await h.flush();
  await h.reply(0, { settings: { thresholds: { bgLow: 180, bgHigh: 70 } } });
  assert.deepEqual(h.cache().thresholds, [70, 180]);
  assert.ok(h.logs.some(log => log.includes("Invalid settings.thresholds")));
});

test("invalid injection timestamps are a failed response and retain cached treatments", async () => {
  const treatments = [[START - 1000, 6]];
  const h = device({ cache: snapshot(START, { treatments }) });
  h.touch();
  await h.flush();
  await h.reply(0, []);
  await h.reply(1, [{ created_at: "2026-10-02T13:00:00Z", insulin: 6 }]);
  assert.deepEqual(h.cache().treatments, treatments);
  assert.ok(h.logs.some(log => log.includes("Invalid injection timestamps")));
  assert.match(h.requests[2].url, /\/status\.json$/);
});

test("non-numeric cached timing is rejected rather than silently disabling the scheduler", async () => {
  const h = device({ cache: snapshot(START, { lastAttempt: "invalid" }) });
  await h.flush();
  assert.ok(h.logs.some(log => log.includes("Invalid snapshot")));
  assert.equal(h.requests.length, 1);
});

test("missing HTTP integration and corrupt cache are explicitly logged", async () => {
  const h = device({ rawCache: "{", noHTTP: true });
  await h.flush();
  assert.equal(readout(h), "--");
  assert.ok(h.logs.some(log => log.includes("cache read")));
  assert.ok(h.logs.some(log => log.includes("HTTP is unavailable")));
  assert.equal(h.timers.size, 1);
});

test("removal clears timers and gestures and ignores in-flight replies", async () => {
  const h = device({ cache: snapshot(START, { latest: [START - PERIOD, 130] }) });
  await h.flush();
  const writeCount = h.writes.length;
  const drawCount = h.calls.length;
  h.remove();
  assert.equal(h.timers.size, 0);
  assert.equal(h.bangle.listenerCount("touch"), 0);
  await h.reply(0, [{ date: START, sgv: 140 }]);
  await h.advance(600000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.writes.length, writeCount);
  assert.equal(h.calls.length, drawCount);
  assert.equal(h.buzzes.length, 0);
  assert.equal(h.timers.size, 0);
});

test("clock rollback resets persisted retry timing instead of indefinitely blocking requests", async () => {
  const h = device({ cache: snapshot(START, {
    latest: [START - PERIOD, 130], lastAttempt: START + DAY
  }) });
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.ok(h.logs.some(log => log.includes("clock moved backwards")));
});
