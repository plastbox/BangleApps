(function() {
  var storage = require("Storage");
  var CACHE = "xdripclock.json";
  var BASE = "http://127.0.0.1:17580";
  var WINDOW = 7200000;
  var PERIOD = 310000;
  var RETRY = 60000;
  var DAY = 86400000;
  var MGDL = 18.01559;
  var active = true;
  var busy = false;
  var timer;
  var saved;
  var state = {
    version: 1, bg: [], latest: null, treatments: [], lastTreatment: 0,
    thresholds: null, thresholdTime: 0, units: "mgdl", lastAttempt: 0
  };

  function positive(value) {
    return typeof value === "number" && isFinite(value) && value > 0;
  }

  function timestamp(value) {
    return typeof value === "number" && isFinite(value) && value >= 0;
  }

  function pair(value) {
    return Array.isArray(value) && value.length === 2 &&
      positive(value[0]) && positive(value[1]);
  }

  function thresholds(value) {
    return pair(value) && value[0] < value[1];
  }

  function save() {
    try {
      var json = JSON.stringify(state);
      if (json !== saved) {
        storage.write(CACHE, json);
        saved = json;
      }
    } catch (error) {
      console.log("xDrip cache write:", error);
    }
  }

  var raw = storage.read(CACHE);
  if (raw) {
    try {
      var cached = storage.readJSON(CACHE);
      if (!cached || cached.version !== 1 ||
          !Array.isArray(cached.bg) || !Array.isArray(cached.treatments) ||
          !cached.bg.every(pair) || !cached.treatments.every(pair) ||
          (cached.latest !== null && !pair(cached.latest)) ||
          (cached.thresholds !== null && !thresholds(cached.thresholds)) ||
          (cached.units !== "mgdl" && cached.units !== "mmol") ||
          !timestamp(cached.lastAttempt) || !timestamp(cached.lastTreatment) ||
          !timestamp(cached.thresholdTime))
        throw new Error("Invalid snapshot");
      state = cached;
      state.bg = state.bg.slice(-26);
      state.treatments = state.treatments.slice(-100);
      var now = Date.now();
      if (state.lastAttempt > now) {
        console.log("xDrip: clock moved backwards; resetting retry timing");
        state.lastAttempt = 0;
      }
      if (state.thresholdTime > now) state.thresholdTime = 0;
      saved = raw;
    } catch (error) {
      console.log("xDrip cache read:", error);
    }
  }
  raw = undefined;
  var needThresholds = !state.thresholds || Date.now() - state.thresholdTime > DAY;

  function acceptBG(rows, now) {
    if (!Array.isArray(rows) || rows.length > 26)
      throw new Error("Invalid glucose response");
    var hint = rows.length && rows[0] ? rows[0].units_hint : undefined;
    if (hint !== undefined && hint !== "mgdl" && hint !== "mmol")
      throw new Error("Unknown glucose units");
    var valid = 0;
    var points = state.bg.filter(function(p) {
      return p[0] >= now - WINDOW && p[0] <= now;
    });
    var latest = state.latest;
    rows.forEach(function(row) {
      if (!row || !positive(row.date) || row.date > now || !positive(row.sgv)) return;
      valid++;
      var point = [row.date, row.sgv];
      if (!latest || point[0] >= latest[0]) latest = point;
      if (point[0] < now - WINDOW) return;
      for (var i = 0; i < points.length; i++) {
        if (points[i][0] === point[0]) {
          points[i] = point;
          return;
        }
      }
      points.push(point);
    });
    if (rows.length && !valid) throw new Error("No valid glucose readings");
    if (valid < rows.length) console.log("xDrip: ignored invalid glucose records");
    points.sort(function(a, b) { return a[0] - b[0]; });
    state.bg = points.slice(-26);
    state.latest = latest;
    if (hint) state.units = hint;
  }

  function acceptTreatments(rows, now) {
    if (!Array.isArray(rows) || rows.length > 100 ||
        rows.some(function(row) { return !row || typeof row !== "object"; }))
      throw new Error("Invalid treatment response");
    var latest = 0;
    var invalid = false;
    var points = [];
    rows.forEach(function(row) {
      if (!positive(row.insulin) ||
          (typeof row.notes === "string" && row.notes.indexOf("Priming") === 0)) return;
      if (!positive(row.created_at)) {
        invalid = true;
        return;
      }
      if (row.created_at > now) return;
      latest = Math.max(latest, row.created_at);
      if (row.created_at >= now - WINDOW) points.push([row.created_at, row.insulin]);
    });
    if (invalid) throw new Error("Invalid injection timestamps");
    state.treatments = points;
    state.lastTreatment = latest;
  }

  function acceptThresholds(data, now) {
    var value = data && data.settings && data.settings.thresholds;
    if (!value || !thresholds([value.bgLow, value.bgHigh]))
      throw new Error("Invalid settings.thresholds");
    state.thresholds = [value.bgLow, value.bgHigh];
    state.thresholdTime = now;
  }

  function draw() {
    if (!active) return;
    var now = Date.now();
    var r = Bangle.appRect;
    var left = r.x + 3, right = r.x2 - 3;
    var top = r.y + 3, bottom = r.y2 - 3;
    var low = state.thresholds ? state.thresholds[0] / MGDL : 4;
    var high = state.thresholds ? state.thresholds[1] / MGDL : 9;
    var min = Math.max(0, low - 2), max = high + 2;
    function visible(p) { return p[0] >= now - WINDOW && p[0] <= now; }
    function expand(value) { min = Math.min(min, value); max = Math.max(max, value); }
    state.bg.forEach(function(p) { if (visible(p)) expand(p[1] / MGDL); });
    state.treatments.forEach(function(p) { if (visible(p)) expand(p[1]); });
    function x(time) { return Math.round(left + (time - now + WINDOW) * (right - left) / WINDOW); }
    function y(value) { return Math.round(bottom - (value - min) * (bottom - top) / (max - min)); }
    g.reset().setClipRect(r.x, r.y, r.x2, r.y2);
    g.clearRect(r.x, r.y, r.x2, r.y2);
    g.setColor(g.theme.fg);
    function thresholdLine(value) {
      var yy = y(value);
      if (state.thresholds) g.drawLine(left, yy, right, yy);
      else for (var xx = left; xx <= right; xx += 8)
        g.drawLine(xx, yy, Math.min(xx + 4, right), yy);
    }
    thresholdLine(low);
    thresholdLine(high);
    state.bg.forEach(function(p) {
      if (!visible(p)) return;
      var value = p[1] / MGDL;
      g.setColor(value >= low && value <= high ? "#00ff00" : "#ff0000");
      g.fillCircle(x(p[0]), y(value), 2);
    });
    g.setColor("#00ffff");
    state.treatments.forEach(function(p) {
      if (!visible(p)) return;
      var xx = x(p[0]), yy = y(p[1]);
      g.drawPoly([xx, yy - 3, xx + 3, yy, xx, yy + 3, xx - 3, yy], true);
      g.drawLine(xx - 5, yy, xx + 5, yy);
    });
    var text = state.latest ?
      (state.units === "mmol" ? (state.latest[1] / MGDL).toFixed(1) : "" + Math.round(state.latest[1])) : "--";
    g.setFont("Vector", 24).setFontAlign(-1, -1);
    var width = g.stringWidth(text), height = g.getFontHeight();
    g.clearRect(left - 1, top - 1, left + width, top + height);
    g.setColor(g.theme.fg).drawString(text, left, top);
    if (state.latest && now >= state.latest[0] + PERIOD)
      g.drawLine(left, top + Math.floor(height / 2), left + width - 1, top + Math.floor(height / 2));
    g.setClipRect(0, 0, g.getWidth() - 1, g.getHeight() - 1);
  }

  function request(endpoint, accept) {
    return Promise.resolve().then(function() {
      if (!active) return;
      if (typeof Bangle.http !== "function") throw new Error("Android Integration HTTP is unavailable");
      return Bangle.http(BASE + endpoint, { timeout: 10000 });
    }).then(function(reply) {
      if (!active) return false;
      if (!reply || typeof reply.resp !== "string") throw new Error("Missing HTTP response");
      accept(JSON.parse(reply.resp), Date.now());
      save();
      draw();
      return true;
    }).catch(function(error) {
      if (active) console.log("xDrip " + endpoint + ":", error);
      return false;
    });
  }

  function fetchThresholds() {
    needThresholds = true;
    return request("/status.json", acceptThresholds).then(function(ok) {
      if (ok) needThresholds = false;
    });
  }

  function feedback() {
    Bangle.buzz(100).catch(function(error) { console.log("xDrip vibration:", error); });
  }

  function bgDue(now) {
    return !state.latest || now >= state.latest[0] + PERIOD;
  }

  function schedule() {
    if (!active) return;
    if (timer !== undefined) clearTimeout(timer);
    var now = Date.now();
    var next = now + 60000 - now % 60000;
    var deadline = state.latest ? state.latest[0] + PERIOD : now;
    if (deadline > now) next = Math.min(next, deadline);
    if (!busy) next = Math.min(next, Math.max(deadline, state.lastAttempt + RETRY, now));
    timer = setTimeout(tick, Math.max(1, next - now));
  }

  function refresh(manual) {
    var now = Date.now();
    if (!active || busy || now - state.lastAttempt < RETRY || (!manual && !bgDue(now))) return;
    busy = true;
    state.lastAttempt = now;
    save();
    if (manual) feedback();
    request("/sgv.json?brief_mode=Y&all_data=Y&count=26", acceptBG).then(function(ok) {
      if (!active || !ok) return;
      var treatments = manual || Date.now() - state.lastTreatment >= WINDOW ?
        request("/treatments.json?count=100", acceptTreatments) : Promise.resolve();
      return treatments.then(function() {
        if (active && (manual || needThresholds)) return fetchThresholds();
      });
    }).then(function() {
      busy = false;
      if (!active) return;
      if (manual) feedback();
      schedule();
    });
    schedule();
  }

  function tick() {
    timer = undefined;
    draw();
    refresh(false);
    schedule();
  }

  function touch(button, event) {
    var r = Bangle.appRect;
    if (event && event.type === 2 && !Bangle.isLocked() &&
        event.x >= r.x && event.x <= r.x2 && event.y >= r.y && event.y <= r.y2)
      refresh(true);
  }

  Bangle.setUI({ mode: "clock", remove: function() {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    Bangle.removeListener("touch", touch);
  } });
  Bangle.loadWidgets();
  g.clear();
  Bangle.drawWidgets();
  Bangle.on("touch", touch);
  draw();
  if (bgDue(Date.now()) && Date.now() - state.lastAttempt >= RETRY) refresh(false);
  else if (needThresholds) {
    busy = true;
    fetchThresholds().then(function() {
      busy = false;
      schedule();
    });
  }
  schedule();
})();
