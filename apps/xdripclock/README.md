# xDrip Glucose

A Bangle.js 2 watchface showing the last two hours of glucose readings and
insulin injections from xDrip on your phone. It does not show the time: use
compatible widgets for that. Updates continue while this face is locked or
its backlight is off, but stop when you open another app.

## Setup

1. Enable **Local Web Service** in xDrip's Inter-App settings. Leave **Open
   Web Service** off; requests use the phone's loopback interface.
2. Use the internet-enabled **Bangle.js Gadgetbridge** Android app, enable
   **Allow Internet Access** for the watch, and keep both phone apps allowed
   to run in the background.
3. Install **Android Integration** on the watch, then install this clock.
   Keep the watch's time synchronized with the phone.

Gadgetbridge performs requests to `http://127.0.0.1:17580` on the phone, not
on the watch. The installed Gadgetbridge version must support this local
HTTP connection. No cloud server, API secret, phone helper, or watch Wi-Fi
is needed.

## Display

- The chart always spans Now minus two hours through Now. It moves each
  minute, immediately on data arrival, and when the last reading becomes
  overdue. Missing data leaves empty space rather than connected lines.
- The latest glucose is at top-left below the widgets. It is struck
  through at five minutes and ten seconds old, and remains visible even
  after its point leaves the chart. `--` means no reading is known yet.
- Green dots are at or within xDrip's low/high thresholds; red dots are
  outside them. Cyan diamonds with horizontal strokes are insulin
  injections. Priming records whose notes start with case-sensitive
  `Priming` are excluded.
- Known thresholds are solid horizontal lines, regardless of their age.
  Before any valid thresholds are available, the app uses **4-9 mmol/L**
  with **dashed** lines.
- The vertical scale starts two mmol/L below the low threshold and two
  above the high threshold, expanding for glucose and injections without
  going below zero. Injection doses use their numeric units on the mmol/L
  scale **only as a visual coordinate convention**.
- Display units follow xDrip's `units_hint` in the first glucose row.
  Without a hint, the previously cached units are retained; a first
  installation defaults to mg/dL. There are no axis labels or dose labels.
- All installed widget areas, including bottom widgets, are preserved.
  Locked and unlocked presentation is identical; this app never controls
  the backlight.

## Fetching and manual refresh

The fixed Dexcom cadence is five minutes. Normal BG fetching is scheduled
for the newest measurement timestamp plus **310 seconds**, not five
minutes after the previous HTTP request. Overdue or failed BG requests
retry at least **60 seconds** apart. There are no overlapping cycles.

After valid BG communication, the app fetches treatments unless its latest
eligible injection is less than two hours old. This intentionally means a
second injection during that cooldown can remain unseen until the cooldown
expires or you manually refresh. A successful response containing old or
no BG readings restores communication but does not make glucose fresh.

Thresholds are fetched on entering the face only when missing or more than
24 hours old. Required threshold refreshes that fail retry after successful
BG fetches. Treatment failures also wait for the next successful BG fetch.
Valid cached data is retained on failures and restored immediately across
app changes or reboot.

**Unlock and long-press the chart** to fetch BG, treatments, and thresholds.
This bypasses freshness and treatment cooldowns, but not the one-minute BG
attempt throttle. Busy or throttled gestures are ignored, not queued.
The watch vibrates once when a manual refresh starts and once when it
finishes, including on failure. Failed BG communication prevents dependent
requests; after BG success, a treatment failure does not prevent a threshold
attempt.

## Compatibility and limitations

The app uses these bounded endpoints:

- `/sgv.json?brief_mode=Y&all_data=Y&count=26`
- `/treatments.json?count=100`
- `/status.json`

It expects numeric epoch-millisecond `date`/`created_at` timestamps and
current xDrip `settings.thresholds.bgLow`/`bgHigh` values in **mg/dL**.
Raw BG is also mg/dL, regardless of display units. The conversion factor is
18.01559 mg/dL per mmol/L. Older top-level threshold schemas are not guessed;
an incompatible response is logged and cached/default thresholds remain.

Responses are fetched and normalized sequentially to limit memory use.
The endpoints do not provide a two-hour server-side filter or treatment
pagination. More than 100 recent treatment records, including priming and
non-insulin entries, can prevent the oldest injections from reaching the
watch. Edited/backfilled phone records can also be affected by xDrip's own
response cache.

Failures are logged to the Espruino console without logging glucose or
treatment payloads. There are no alerts, treatment entry, or extra refresh
indicators. This display is not a replacement for your CGM's medical alarms;
verify phone/watch behavior and the data shown on your own installed versions.

## Development

Run the deterministic app tests with:

```sh
node --test apps/xdripclock/test.js
```

After setting up the emulator dependencies described in the repository's
`TESTING.md`, run:

```sh
node bin/runapptests.js --id xdripclock
```
