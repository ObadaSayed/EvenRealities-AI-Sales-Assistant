# Design: Rich Account Detail View (text graphics + async LLM talking points)

Date: 2026-07-20
Status: Approved

## Goal

Enhance the on-glasses **account detail view** (`app/src/main.ts` `renderOpps`, reached
by tapping an account) from a plain opportunity list into a richer, prep-oriented
view using **text/Unicode graphics** (no image infrastructure). Add three data
sections: a pipeline bar chart, Main Contacts, Last Interaction, and async
LLM-generated Key Talking Points.

## Constraints

- Display: single monochrome text container, 576×288, ~proportional font. Longer
  content scrolls via the native scrollbar. Bars use a single repeated glyph so
  they render correctly on a proportional font (no multi-column table reliance).
- Proxy: Node ≥20, ESM, `jsforce`; reuse existing modules. No new npm deps for
  tests (`node:test`). New runtime deps only if unavoidable (none expected).
- Never dead-end: talking points fall back to rule-based text when OpenAI is not
  configured or errors, mirroring the prep flow's `composeBrief`.
- Detail view must render fast; the LLM call must not block the initial render.

## Target layout (mockup)

```
NovaMind AI Technologies
Pipeline $10.15M · Open $7.75M

Open by stage
 Negotiation ██████████ $5.8M
 Proposal    ██▌        $1.2M
 Discovery   █▌         $0.75M

Main contacts
 Aisha Al-Rashidi   CEO & Founder
 Priya Nair         CTO
 Khalid Al-Mansoori CFO
Last interaction  12 days ago

Key talking points        (analyzing…)
 • Push Phase 2 ($5.8M), now in Negotiation
 • 3 open cases — check delivery health
 • Reference the Phase 1 win to build trust

Tap: back  x2: ask by voice
```

## Architecture

### Proxy

Reuse `lib/prep/gather.js` (`gatherAccountData({ runQuery, accountId })`) which
already fetches Account + Opportunities + Cases + Contacts in parallel and returns
`{ account, opportunities, cases, contacts, metrics }`.

**Supporting change:** add `LastActivityDate` to `accountByIdSoql` (queries.js) and
surface it as `account.lastActivityDate` in `gather.js` normalization. Additive and
harmless to the prep flow.

**New module `lib/detail/aggregate.js`:**
- `stageBreakdown(opportunities)` → array of `{ stage, amount }` for **open** opps
  (`!isClosed`), summed by stage, sorted by amount desc. Pure.
- `resolveLastInteraction({ account, opportunities, cases })` → `{ date, source }`
  or `null`. Prefers `account.lastActivityDate`; else the most recent of opp/case
  dates available in the bundle. Pure.
- `buildDetail(bundle)` → `{ account, metrics, stages, contacts, lastInteraction }`
  where `contacts` is the top 4 `{ name, title }` and `stages` is the breakdown.

**New module `lib/detail/talkingPoints.js`:**
- `buildPointsPrompt(bundle)` → `{ system, user }`.
- `ruleBasedPoints(bundle)` → `string[]` deterministic fallback (biggest open deal +
  stage, open-case warning, closed-won reference, inactivity nudge). Pure.
- `composeTalkingPoints({ bundle, openaiChat })` → `{ points: string[], source }`
  ('openai' | 'rule'); parses the LLM reply into ≤5 trimmed bullets, falls back to
  `ruleBasedPoints` on error/empty. Mirrors `composeBrief`.

**New routes (mounted in `server.js`, injected deps):**
- `GET /accounts/:id/detail` → `gatherAccountData` + `buildDetail`. Fast (no LLM).
- `GET /accounts/:id/talking-points` → `gatherAccountData` + `composeTalkingPoints`.
  May take a few seconds. Returns `{ points, source }`.

These reuse existing `findAccount`/`runQuery`/`openaiChat` from `server.js`. Both
endpoints resolve the account by id directly (id comes from `/accounts`).

### App (`app/src/main.ts`)

- New interfaces `DetailResult` and `TalkingPoints`.
- Pure render helpers: `bar(value, max, width)` (block-char bar, ≥1 cell when >0)
  and `renderDetail(data, points?)` producing the layout above. When `points` is
  undefined the talking-points section shows `(analyzing…)`.
- `openSelectedAccount` change: fetch `/accounts/:id/detail`, render immediately,
  then fetch `/accounts/:id/talking-points` and re-render with the bullets. On
  talking-points failure, show a short note but keep the rest of the view.
- Preserve existing gestures: single tap = back (from detail), double tap = voice.

## Error handling

- `/detail` failure → existing error text ("Error loading …", Tap: back).
- `/talking-points` failure → view still shows all CRM sections; talking-points
  line shows "(unavailable)". Never blocks the base view.
- Empty stages (no open opps) → omit the chart, show "No open pipeline".
- No contacts → "No contacts on file". No last interaction → "No recent activity".

## Testing

- Proxy (TDD, `node:test` + dependency injection):
  - `aggregate.test.js`: stage grouping (open only, summed, sorted), last-interaction
    resolution (account date vs fallback vs null), `buildDetail` shape/top-4 contacts.
  - `talkingPoints.test.js`: rule-based output, prompt build, LLM success, and
    fallback on throw/empty.
  - `routes` covered by the existing offline router test pattern if a router module
    is added; otherwise thin handlers wired directly with injected deps.
- App: pure `bar`/`renderDetail` helpers kept side-effect free; verified by a clean
  `tsc && vite build`.

## Out of scope

- Server-rendered image charts (future option B/C).
- Month-vs-month order comparison chart (needs date-bucketed order data not queried).
- Changes to the meeting-prep (`/prep`) flow beyond the additive `LastActivityDate`.
