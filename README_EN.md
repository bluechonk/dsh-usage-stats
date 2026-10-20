# dsh-usage-stats

[![CI](https://github.com/bluechonk/dsh-usage-stats/actions/workflows/ci.yml/badge.svg)](https://github.com/bluechonk/dsh-usage-stats/actions/workflows/ci.yml)
[![version](https://img.shields.io/github/v/tag/bluechonk/dsh-usage-stats?label=version)](https://github.com/bluechonk/dsh-usage-stats/tags)
[![license](https://img.shields.io/github/license/bluechonk/dsh-usage-stats?label=license)](https://github.com/bluechonk/dsh-usage-stats/blob/main/LICENSE)

[中文](README.md) | English

DeepSeek Harness plugin: adds a **Usage Stats** section to the settings page, showing local token usage through a **six-cell summary strip**, a **GitHub-style token activity heatmap**, a **per-model trend chart**, and a **model usage donut**. All data comes from local session logs — nothing is uploaded, and there are no runtime dependencies.

![Usage stats panel](docs/images/01-使用统计面板.png)

## Plugin identity

| Item | Value |
|---|---|
| npm package name | `@bluechonk/dsh-usage-stats` |
| loader row id | `dsh-usage-stats` |
| client module id | `@bluechonk/dsh-usage-stats` (must match the package name character for character, otherwise the host refuses to load the whole plugin) |
| settings section id | `dsh-usage-stats` (the section key inside the `settings.section` slot) |
| section order | `order: 13` — between "Models" (10) and "Built-in Plugins" (15) |
| section title | Usage Stats |

The loader row id and the client module id are **not** shared: the `id` in `cordis.patch.yml` is the stable identifier inside the host, while `name` is the npm package name. The client half's `__ModuleLoader__.load({id})` must match `package.json`'s `name` character for character — otherwise the host reports "loaded without registering … via __ModuleLoader__.load" and the plugin fails to load at all.

## Interface

| Area | Description |
|---|---|
| Title row | "Usage Stats" + an "App Usage" pill badge + the subtitle "A rough view of session activity and model usage." |
| Six-cell summary strip | Total Tokens / Peak Tokens / Cache Hit Rate / Longest Chat / Current Streak / Longest Streak; when the width is too narrow the **whole cell wraps** instead of truncating the label |
| Token activity | Heatmap cells for 52 calendar weeks (starting Sunday); pills in the top-right switch between Daily / Weekly / Total |
| Time range | Pills switch between Last 7 Days / Last 30 Days, affecting **only the trend chart below** |
| Daily token trend | One coloured line per model, drawn with monotone cubic interpolation; the legend on top is display-only, hovering shows each model's usage for that day |
| Model usage | Donut chart on the left (total tokens in the centre) plus a per-model list on the right (name + share + token count) |
| Footer | "Updated at HH:MM" + a refresh button |

The model usage card (donut + model list + the merged "Other models" row):

![Model usage donut](docs/images/02-模型用量环形图.png)

Light theme (same layout, both themes verified):

![Light theme](docs/images/03-浅色主题.png)

## Design baseline

The interface is aligned with the local **ZCode** "Settings → Usage Stats" page. Measured parameters and the item-by-item comparison live in [docs/设计与验证.md](docs/设计与验证.md):

| Element | Value |
|---|---|
| Title | 22px / 600 / letter-spacing -.01em (ZCode uses 30px / 600 / -.75px; the DSH settings panel is narrower, so the scale is adjusted) |
| Badge | Pill shaped, `padding 3px 12px`, `font-weight 500` (same shape as ZCode's `rounded-full px-3 py-1`) |
| Summary strip | Numbers at 17px, labels at 13px, number above and label below |
| Card | 12px radius, no border |
| Heatmap cell | 3px rounded square, solid fill with no stroke |
| Chart colours | Six-colour palette, see below |

The palette is taken verbatim from ZCode's CSS variables (`--color-usage-chart-1..6` / `--color-usage-heatmap-0..4`, defined in oklch), with each theme forming its own set:

| Purpose | Dark theme | Light theme |
|---|---|---|
| Chart colour 1 | sky-600 `oklch(58.8% .158 241.966)` | sky-500 `oklch(68.5% .169 237.323)` |
| Chart colour 2 | teal-600 `oklch(60% .118 184.704)` | teal-400 `oklch(77.7% .152 181.912)` |
| Chart colour 3 | violet-600 `oklch(54.1% .281 293.009)` | violet-400 `oklch(70.2% .183 293.541)` |
| Chart colour 4 | rose-500 `oklch(64.5% .246 16.439)` | rose-400 `oklch(71.2% .194 13.428)` |
| Chart colour 5 | indigo-500 `oklch(58.5% .233 277.117)` | indigo-400 `oklch(67.3% .182 276.935)` |
| Chart colour 6 | cyan-600 `oklch(60.9% .126 221.723)` | cyan-400 `oklch(78.9% .154 211.53)` |

The five heatmap levels mix a blue into the empty-cell background with `color-mix`, so they harmonise with any theme without hand-tuning the scale.

## Data semantics

The blocks use different scopes — do not mix them up:

| Data | Scope | Affected by "Last 7 Days / Last 30 Days" |
| --- | --- | --- |
| Six-cell summary strip | All time | No |
| Token activity heatmap | Last 52 calendar weeks | No |
| Daily token trend | Last 7 days / Last 30 days | Yes |
| Model usage donut | All time | No |

Definitions per metric:

| Metric | Definition |
| --- | --- |
| Total Tokens | Input + output + cache reads + cache writes, summed over all time |
| Peak Tokens | The day with the largest sum of the four buckets |
| Cache Hit Rate | Cache-read tokens ÷ (cache reads + uncached input); an em dash when there is no input |
| Longest Chat | Longest single chat per (session, day); cross-day chats are cut at day boundaries |
| Current / Longest Streak | A day counts when it has usage; if today has none, counting starts from yesterday |

Every token figure on the page uses the short form (≥ 10,000 shows "12.3K", ≥ 100,000,000 shows "1.2B"); the exact value with thousands separators only appears in the element's `title` tooltip.

## Data sources and collection

The host pushes session events to the plugin, which **folds** them into per-record deltas before writing them to disk:

| Source | Path | Description |
|---|---|---|
| Live events | `ctx.on("session/event", …)` | The host pushes `assistant/message` and friends, carrying `data.message.source` (provider / model) and `data.usage` |
| Past sessions | `~/.dsh/sessions/<workspace>/<sid>/session.v4.jsonl.zstd` | Replayed in the background on load |
| Source of truth | `~/.dsh/usage-stats/records-YYYY-MM.jsonl` | Per-record delta log, one file per month |
| Daily aggregate cache | `~/.dsh/usage-stats/daily/YYYY-MM-DD.json` | Always rebuildable from the records; damaged or stale days self-heal |
| Backfill cursor | `~/.dsh/usage-stats/backfill-marker.json` | Tracks folded sessions and mtime sentinels so the steady state costs zero decompression |

The folding semantics match the official `@deepseek-ai/dsh-token-meter` `tokenUsage` projection: same-key samples produce a difference, `llm/retry-started` clears the slot so the next same-key sample accumulates, and the sum over the delta stream always equals the official totals. The backfill path replays whole session files to preserve slot baselines and only persists records with `seq` above the watermark.

## Installation

```bash
# 1. Register into a profile (Windows: junction; macOS / Linux: ln -s)
mkdir -p ~/.dsh/profiles/desktop/node_modules/@bluechonk
ln -s <absolute path to this directory> ~/.dsh/profiles/desktop/node_modules/@bluechonk/dsh-usage-stats

# 2. Append to the profile's cordis.patch.yml
#    - insert:
#        - id: dsh-usage-stats
#          name: "@bluechonk/dsh-usage-stats"
#          config: {}

# 3. Restart that profile's DSH instance and refresh the page
```

The client half is injected while the page loads, so editing `lib/client.js` takes effect on **refresh**; changes to the host half (`lib/index.js`) need a **DSH restart** (Electron exclusively manages the profile and cannot hot-reload it).

## Configuration

Three keys are accepted in the `config` section of `cordis.patch.yml` (unknown keys raise an error instead of being ignored):

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Set to `false` to disable the plugin (no collection, no writes) |
| `storageRoot` | `~/.dsh/usage-stats` | Statistics directory (JSONL log + daily cache + lock + backfill cursor) |
| `sessionsRoot` | `~/.dsh/sessions` | Session log directory (the source scanned during backfill) |

```yaml
- insert:
    - id: dsh-usage-stats
      name: "@bluechonk/dsh-usage-stats"
      config:
        storageRoot: "D:/dsh-stats"
```

## Data channel

The host half registers same-origin routes on `ctx.webServer` (all guarded by a loopback and same-origin check):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dsh-usage-stats/summary` | The six summary cells |
| GET | `/api/dsh-usage-stats/heatmap?days=N` | Per-day token activity (default 366, upper bound 3660) |
| GET | `/api/dsh-usage-stats/trend?days=N` | Per-model trend points (days=7 / 30, 0 = hourly) |
| GET | `/api/dsh-usage-stats/models?days=N` | Model usage shares (default 0 = all time) |
| GET | `/api/dsh-usage-stats/backfill/status` | Backfill progress (scanned / backfilled / records / error) |
| POST | `/api/dsh-usage-stats/backfill` | Trigger a backfill manually (202 accepted, 409 when one is already running) |

## Security and boundaries

- **Writes are guarded by a single-writer lock with ownership verification**: once the lock is taken over, the previous writer stops writing immediately and degrades to a read-only mirror, so two instances can never wipe each other's ledger. The takeover claim file is reclaimed once it goes stale, so a leftover claim cannot block takeover forever.
- **Session logs are only read**, never modified.
- **Routes are loopback-guarded**: only local requests are accepted, and the Host header and Origin must be same-origin.
- **Nothing is uploaded** — no telemetry, no third-party requests; all statistics land in `~/.dsh/usage-stats/`.
- The plugin writes nothing to the host outside session logs; deleting `~/.dsh/usage-stats/` clears the statistics without touching sessions.

## Resilience and degradation

- Three states: loading / empty / failed (with an inline retry).
- A failing route only degrades its own card instead of taking down the panel; **even when old data is present it says "stale, showing the last values" and offers an inline retry**.
- Every refresh records "Updated at HH:MM"; when a route fails the timestamp freezes and is marked "(some data not updated)"; a failing first load still produces a visible signal.
- The panel is wrapped in an error boundary: a render failure degrades to a fallback banner instead of blanking the whole settings page.
- A silent poll runs every 60 seconds without flashing "Loading"; background tabs skip a beat, coming back to the foreground catches up, closing the page stops it.
- Backfill progress is visible the whole time (including in the ready state), and finishing triggers one full refresh.

## Repository layout

```
dsh-usage-stats/
├─ package.json          # dsh.bundle.patch + dsh.client
├─ cordis.patch.yml      # loader insertion row (id / name)
├─ lib/index.js          # host half: event collection, backfill, routes, lock
├─ lib/fold.js           # folding state machine (replace / clear / sample, pure)
├─ lib/store.js          # write discipline, atomic writes, single-writer lock
├─ lib/aggregate.js      # aggregation semantics (streak / peak / hit rate / share)
├─ lib/locale.js         # client copy dictionary (zh / en)
├─ lib/client.js         # client half: settings.section panel and every chart
├─ docs/                 # design and verification notes, audit report, screenshots
├─ test/                 # node:test unit and end-to-end tests
└─ SPEC.md               # full technical specification
```

## Development

```bash
npm run check        # syntax check
npm test             # unit tests (148 cases)
npm run verify:e2e   # end to end: runs a backfill over the local session logs and checks the shape of all four API responses
npm run verify:ui    # real-machine UI smoke test: drives a real browser into the settings page and asserts the panel renders without console errors
```

No runtime dependencies; tests use Node's built-in `node:test`. `verify:e2e` only reads `~/.dsh/sessions` and writes its statistics to a temporary directory that it cleans up afterwards, leaving `~/.dsh/usage-stats/` untouched.

See [docs/设计与验证.md](docs/设计与验证.md) for the design and verification details (design baseline, audit and fix log), [SPEC.md](SPEC.md) for the complete interface contract, and [CHANGELOG.md](CHANGELOG.md) for version history.

## Known limitations

- The heatmap always looks back 52 calendar weeks; older usage only counts towards the all-time figures such as the summary strip.
- Longest chat time is bucketed per (session, day) and takes the extreme, so cross-day chats are cut at day boundaries — an approximation.
- The trend tooltip lists at most 8 model rows; the rest is summarised as "N more models not listed".
- The cache hit rate only covers cache reads and uncached input, excluding output and reasoning.
- Sessions that were already running when the plugin was installed are not backfilled for their earlier usage (better to miss than to double count).
- A sequence gap left by a failed write is skipped by the derived watermark, so that delta is not re-collected (only reachable when several consecutive events fail to write).
- The full list lives in [SPEC.md §9](SPEC.md).

## Repository

- GitHub: <https://github.com/bluechonk/dsh-usage-stats>
- Plugin identity: npm package name `@bluechonk/dsh-usage-stats`, loader row id `dsh-usage-stats`.

## Localization

The panel copy **follows the host language automatically** (DSH Settings → General → Language); no page reload is needed.

- It uses the host's `@deepseek-ai/dsh-client-locale`: the plugin registers a `dsh-usage-stats` namespace with Chinese and English dictionaries, and the host injects the translate function into the panel. Switching language re-renders the panel.
- Numbers and dates are localized too: Chinese uses 万/亿, 天/小时/分, 月/日; English uses K/B, d/h/min, MM/DD.
- When the host provides no locale service the panel falls back to Chinese and logs a warning rather than failing silently.
- 中文说明见 [README.md](README.md)。

## Credits and licence

- The interface follows the "Usage Stats" panel of [zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0); the palette is taken from its CSS variables.
- Collection and folding semantics follow the official `@deepseek-ai/dsh-token-meter` `tokenUsage` projection.
- The dashboard implementation is based on [axuan-1314/dsh-usage-stats](https://github.com/axuan-1314/dsh-usage-stats) (MIT).
- The early version came from [Make0209/dsh-usage-stats](https://github.com/Make0209/dsh-usage-stats) (MIT); this repository rebuilds the dashboard on top of it.

MIT License, see [LICENSE](LICENSE).
