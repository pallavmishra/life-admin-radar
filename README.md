# Life-Admin Radar

A local-first macOS app that answers one question every morning: **what paperwork is coming at me, and what do I need to have ready?**

It tracks dates, lead times, and readiness for immigration, license and vehicle renewals, insurance, health appointments, subscriptions, claims, and household admin. It is not a task manager: day-to-day tasks stay in Kanban Board, and Radar pushes a card there when something enters its reminder window.

- **Local only.** One SQLite file in `~/Library/Application Support/Life-Admin Radar/radar.db`. No accounts and no network calls. The only outside actions are opening a cancel URL in your browser and writing the Kanban plist, and both show a preview first.
- **Privacy boundary.** The storage layer refuses to save text that looks like an SSN, a date of birth, a password or credential, or an embedded image (`src/shared/privacy.js`). Radar records *that* you have a document and *where* it lives ("saved in ~/H1 Documents"), never what it says.
- **Quiet by default.** It sends a notification only when a reminder is actually due. The morning digest is off by default and skips days when nothing is due.

## Run it

```bash
npm install
npm start              # build the UI and open the app (simplest)
npm run dev            # Vite + Electron with hot reload (for development)
npm run build          # renderer + DMG and zipped .app in dist/installers (build on macOS)
```

`better-sqlite3` v13 ships N-API prebuilds (including `darwin-arm64`) that load in both Node and Electron, so there is no native rebuild step.

## Tests

```bash
npm test               # vitest: date/reminder math, privacy, dedupe, plist, Kanban planner, engine + DB, sync
npm run test:headless  # the definition-of-done test in the real Electron runtime (below)
npm run test:e2e       # drives the real app UI with Playwright (Linux CI: xvfb-run -a npm run test:e2e)
```

**Headless test** (`test/headless/reminders.headless.js`): seeds the §5 items and launches the engine as separate processes on the same database file, advancing the clock from 2026-09-28 to 2026-12-15 and then to 2027-03-25. It asserts that each reminder fires exactly once, that re-running changes nothing, that two thresholds crossed at once produce one notification rather than two, and that dateless subscriptions never fire.

**E2E test** (`test/e2e/app.e2e.mjs`) walks the whole flow in the real app. It adds a driver's license renewal from a template, checks that its reminder fires, ticks off a document, runs the Kanban dry run, writes to a temporary copy of the board, and confirms the card appears on "My First Board" with the checklist state and no duplicates.

## How reminders work (`src/main/reminders.js`, pure)

- A reminder fires on `due_date - days_before`. The item's status, whether the reminder has fired, and today's date are all passed in, so the result is deterministic.
- **No burst.** If several of an item's reminders are due at once (the app was closed, or you created an item 10 days before its due date with a 60/30/7 schedule), only the latest one notifies. The others are marked as superseded.
- **No double firing.** The engine marks the reminder fired and writes the notification log in one transaction (`UPDATE … WHERE fired_at IS NULL`), then shows the notification. Re-running is a no-op.
- **Changing the due date** re-arms any reminder whose new fire day is still in the future.
- **Dateless items** (subscriptions without a known renewal date) have no eligible reminders. That is the normal case, not an error.
- **"To book" health items** nudge every 14 days until you enter the appointment date. The item then becomes a dated appointment with reminders at 7 days and 1 day.
- **Subscriptions** remind 7 days before renewal with a keep/cancel prompt. *Keep* logs the decision and rolls the date forward one billing cycle. A renewal date that passes with no decision is logged as `auto-renewed`, which is how the Subscriptions view spots renewals nobody chose.

## Kanban push: read this before the first real write

Radar pushes one way into `~/Library/Preferences/app.pallavmishra.KanbanBoard.plist` (key `kanban_v3_data`, board "My First Board").

**Recommended first run:**

1. Quit Kanban Board and copy the plist:
   `cp ~/Library/Preferences/app.pallavmishra.KanbanBoard.plist ~/Desktop/kanban-copy.plist`
2. Dry run against the copy, in the app (**Kanban push ▸ Dry run against a copy…**) or in the terminal:
   `npm run kanban:dry-run -- ~/Desktop/kanban-copy.plist --out ~/Desktop/kanban-would-be.plist`
   This prints how Radar reads the board and the exact JSON of every card it would write. It writes nothing except the optional `--out` file, which must be a new file.
3. Check the matches. With the seed data you should see *Book colonoscopy appointment → "Colonoscopy Appointment"*, *Book prostate appointment → "Prostate Appointment"*, and *H-1B: I-94 expires → "Visa Renewal"*. All three are **links**, not new cards.
4. Then use **Preview push** and **Write to Kanban Board** on the real file.

**Safety rules, in order:**

- **Never while Kanban Board is running.** Radar checks for the running app by bundle id (`osascript … is running` plus a `pgrep` fallback). If the check fails, Radar treats the app as running. It checks again right before the swap. If Kanban Board is running, the cards stay queued and you get *"Quit Kanban Board so Radar can add your '<title>' card"*, once per queued card.
- **Never in chunks.** Radar builds the complete new plist in memory, writes it to a temp file in the same folder, fsyncs it, converts it back to binary with `plutil`, lints it, and reads it back to confirm it matches exactly. Only then does it `rename()` the file into place.
- **Never blind.** Before the swap it re-checks the original file's SHA-256 against the one from the preview. If the file changed, nothing is written.
- **Backups.** Each write saves the previous file to `~/Library/Application Support/Life-Admin Radar/kanban-backups/`.
- **cfprefsd.** macOS caches preferences in memory. After the swap, Radar runs `defaults import` on the file it just wrote so the cache matches the disk. It then reads the board back with `defaults export`, the same path Kanban Board uses, and checks that it matches. This step runs only for the real preferences file, never for a copy.
- **Invariant check.** Before anything is written, Radar compares the board before and after. It blocks the write if any existing card would disappear, if the card count moves by anything other than the new cards, if lists change, or if any card, board setting, or data outside "My First Board" that the plan didn't intend to touch would change.

**The board's JSON format is inferred, not assumed.** I didn't have the Kanban app's source. A wrong type in a Swift Codable model breaks decoding for the *whole* board, so Radar works only from evidence already on the board:

- New cards are clones of an existing card. Sub-arrays are emptied, done flags are cleared, and other values such as colors are kept as they were.
- Dates are written in the format already on the board. Seconds since 2001, epoch seconds or milliseconds, ISO strings, and plain dates are all detected.
- Priority uses the board's own vocabulary. Tags are added only if the board's tag format is known.
- Anything Radar has to guess shows up as a ⚠️ in the dry run, and the live write needs you to tick **"I checked the dry run"**. Examples: no card has a due date yet, or no tags exist yet.
- You can override any guess in **Settings ▸ Advanced**, e.g. `{"dueKey":"deadline","dateFormat":"iso8601","tagStyle":"string"}`.

**Sync rules:**

- A card is created or updated when an item enters its first reminder window (its largest `days_before`). "To book" items qualify right away.
- A card is updated again when the item's due date or checklist changes. The checklist lives in a `--- Radar checklist ---` block in the card notes, which Radar replaces in place rather than appending again.
- Marking an item done moves its card to **Done**.
- Radar never reads task state back from Kanban. If you delete a linked card, Radar does not recreate it.
- **Dedupe:** titles are matched case-insensitively after dropping words like book, appointment, renewal, and check status. Immigration terms (H-1B, I-94, I-797, visa) count as the same word. The dry run lets you override any match.
- Subscriptions are left off the board by default (a setting turns them on), since keep/cancel happens in Radar.
- **Auto-push** stays off until you've done one reviewed push. Even with it on, title matches and new guesses still wait for you to review.

## Layout

```
main.js, preload.js          Electron shell (sandbox, strict CSP, navigation guards, single instance)
src/shared/                  dates (local day keys, DST-safe), constants, privacy guard, templates
src/main/reminders.js        pure reminder math
src/main/status.js           status + dashboard buckets (Overdue / 7 / 30 / 90 days)
src/main/db.js               SQLite schema + store
src/main/engine.js           tick: claim-then-notify, nags, subscription roll-forward, digest
src/main/kanban/             plistXml (lossless), plistFile (atomic I/O), board (schema adapter),
                             match (dedupe), plan (planner + invariants), sync (queue/preview/execute)
src/renderer/                React UI
```

## Deliberate limits

- **Household consumables** are tracked as present or absent only ("have it / out of it"). There are no quantities, no depletion, and no days-of-supply estimates. Adding an item is one text field and Enter.
- **No gamification, streaks, or charts.**
- **Reminders fire only while Radar is running.** Closing the window keeps it running in the Dock. Turn on **Settings ▸ Open at login**.
