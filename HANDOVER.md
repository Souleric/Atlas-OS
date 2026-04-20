# Atlas OS — AI Handover Document
**Last updated:** 2026-03-23
**Handed over by:** Claude Sonnet 4.6 (claude-sonnet-4-6)

---

## What This Project Is

**Atlas OS** is an Electron macOS desktop app — an AI-powered executive assistant for Eric Cheah (Co-Founder @ BETA Social Malaysia). It combines:
- Real email (IMAP fetch + SMTP send) with multi-account support
- AI chat sidebar powered by Claude API (claude-sonnet-4-20250514)
- Task management, calendar view, projects, scheduling queue
- Voice input (Web Speech API) + TTS output
- Local memory system (localStorage) injected into every AI prompt
- Email compose drawer with AI draft, tone check, shorten, translate

The entire frontend is a **single HTML file** (`atlas-os_1.html`, ~1984 lines). All styling and JS are inline. There is no build step.

---

## File Structure

| File | Role |
|------|------|
| `atlas-os_1.html` | Entire app: HTML, CSS, JS. All UI sections, modals, email logic, AI chat, memory system |
| `main.js` | Electron main process. IPC handlers: `email:get-accounts`, `email:add-account`, `email:remove-account`, `email:test-account`, `email:fetch-messages`, `email:fetch-body`, `email:send`, `email:mark-read`. Also: window creation, CSP header injection for Anthropic API CORS |
| `preload.js` | `contextBridge` exposing `window.emailAPI` to renderer with: `getAccounts`, `addAccount`, `removeAccount`, `testAccount`, `fetchMessages`, `fetchBody`, `send`, `markRead`, `onNewMessages`, `onSyncStatus` |
| `package.json` | `electron ^41` declared, but `v24.14.0` is what's installed in node_modules (functional). Deps: `imapflow`, `mailparser`, `nodemailer` |
| `Desktop/Atlas OS.app` | AppleScript `.app` launcher on ~/Desktop. Ad-hoc signed — Gatekeeper blocks it on first launch. User must right-click → Open once. After that, double-click works |
| `Desktop/Launch Atlas OS.command` | Shell script alternative launcher. Same first-run Gatekeeper prompt applies |

**How to run:**
```bash
cd '/Users/ericcheah/Antigravity/Atlas OS'
npm start
# or: env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .
```

---

## UI Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ HEADER (logo + status pill + clock)          [88px left padding] │
├──────────┬──────────────────────────────────────┬───────────────┤
│ NAV      │  MAIN CONTENT (scrollable sections)  │  CHAT PANEL   │
│ sidebar  │                                      │  (collapsible)│
│ 220px    │  Home / Email / Tasks / Calendar /   │  340px        │
│          │  Projects / Memory / Accounts        │               │
└──────────┴──────────────────────────────────────┴───────────────┘
```

Active section controlled by `switchSection(id, navEl)` toggling `.active` class and `display` on section divs.

---

## What Was Done This Session (in order)

### 1. Header overlap with macOS traffic light buttons
- **File:** `atlas-os_1.html:25`
- **Change:** `padding: 0 20px` → `padding: 0 20px 0 88px`
- **Why:** The header logo was overlapping the red/yellow/green window control buttons (titleBarStyle: 'hiddenInset')

### 2. Desktop `.app` not opening (Gatekeeper)
- **Diagnosis:** App is ad-hoc signed (`flags=0x2(adhoc)`), no Apple Developer ID → `spctl --assess` returns "rejected"
- **Fix created:** `~/Desktop/Launch Atlas OS.command` — shell script that runs Electron directly
- **User action needed:** Right-click → Open on either `.app` or `.command` once to bypass Gatekeeper permanently

### 3. Email thread modal — all buttons broken (close, Draft, Send)
**Root cause:** A critical JS syntax bug — `sendMessage()` function opened at HTML line 947 with `{` but was never closed. Its body had been moved elsewhere, leaving ALL subsequent code nested inside an unclosed function. This caused a silent JS crash on page load, breaking every `onclick` handler in the app.

- **Fix:** `atlas-os_1.html:961-967` — closed `sendMessage()` properly:
  ```js
  async function sendMessage() {
    if (loading) return;
    const inp = document.getElementById('chat-input');
    const txt = inp.value.trim();
    if (!txt) return;
    askAtlas(txt);   // ← added this + closing }
  }
  ```
- **`askAtlas(txt)` function** at line 1438 contains the actual Claude API call logic (was orphaned top-level code, now a proper `async function`)

### 4. `undefined@undefined` in thread modal from field
- **File:** `main.js` — envelope parsing
- **Fix:** `const fromAddress = (f.mailbox && f.host) ? f.mailbox + '@' + f.host : (f.mailbox || f.host || account.email)`
- **Also:** `atlas-os_1.html:1736` — `openImapThread()` now shows `"Name <email>"` format instead of raw address

### 5. Draft button broken for real IMAP emails
- **Root cause:** `aiDraftReply()` at line 1335 checked `if (!currentThread)` — but real IMAP emails set `currentImapMsg`, not `currentThread`. So it always returned early.
- **Fix:** Function now checks `currentImapMsg` first, falls back to `currentThread`

### 6. Send button broken for real IMAP emails
- **Root cause:** `sendReply()` at line 1370 checked `if (!currentThread)` — same issue as above
- **Fix:** When `currentImapMsg` is set, calls `window.emailAPI.send()` with correct `accountId`, `to` (sender's address), subject prefixed `Re:`, body, and optional cc/bcc

### 7. CC / BCC added to thread reply
- **HTML:** `atlas-os_1.html:858-870` — CC/BCC input rows inside `#th-cc-fields` (hidden by default)
- **Toggle:** `toggleCcBcc()` at line 1326 shows/hides the fields
- **Backend:** `main.js` `email:send` handler now accepts `cc` and `bcc` in the data object and passes to nodemailer

### 8. Forward button + To field
- **HTML:** `atlas-os_1.html:859-862` — `#th-to-row` with `#th-to` input (hidden by default, shown only for forwards)
- **`forwardEmail()`** at line 1412: pre-fills reply textarea with forwarded message body, shows To row, focuses it, sets subject to `Fwd: ...`
- **`sendReply()`** at line 1370: detects forward mode by checking `th-to-row` visibility; validates To field (highlights red if empty); uses To field value as recipient; uses `Fwd:` subject prefix

### 9. Chat panel collapse
- **CSS:** `.chat-panel.collapsed` — collapses to 44px width, hides messages/input/quick-actions, `transition: width 0.2s ease`
- **HTML:** Added `‹` button `#chat-collapse-btn` to chat header
- **JS:** `toggleChatPanel()` at line 1318 — toggles `.collapsed` class, switches button text `‹` ↔ `›`

---

## Current Known Issues / TODOs

1. **`askAtlas(text)` name collision** — there are TWO functions named `askAtlas`:
   - Line 959: `function askAtlas(text) { document.getElementById('chat-input').value=text; sendMessage(); }` (quick-action shorthand)
   - Line 1438: `async function askAtlas(txt) { ... }` (actual Claude API call)
   - The second definition overrides the first. This means quick-action buttons (morning briefing, etc.) call the API version directly with the text, skipping the input field. Functionally this works but is confusing. Consider renaming one.

2. **Electron v24 vs package.json ^41** — `npm install` would try to upgrade to v41. Currently running v24 which works fine. Don't run `npm install` without testing first.

3. **Sample/demo data mixed with real data** — `SAMPLE_THREADS` object and `openThread(key)` function still exist for demo inbox items (KK panel, etc.). Real IMAP emails use `openImapThread(key)`. Both paths exist in parallel. The demo items in the Email section hardcode thread data.

4. **Summarize button uses email subject only (no body)** — `aiSumThread()` for real IMAP messages only sends subject/from/date to Claude (not the actual body), because body requires a separate async `fetchBody()` call. Should fetch body first before summarizing.

5. **`composeFromAccountId` not set on modal send** — `sendReply()` uses `currentImapMsg.accountId` which is correct. But `realSendEmail()` used by the compose drawer uses `composeFromAccountId` which relies on chip selection — if no account selected it shows "No email account" error.

6. **No real-time sync** — `onNewMessages` IPC listener is wired but the main process doesn't push new messages proactively. There's no polling loop in `main.js`. The sync button in Email section manually re-fetches.

7. **Voice (speech recognition)** — uses `window.SpeechRecognition` which is available in Electron's Chromium. Works on macOS if microphone permission is granted. TTS uses `window.speechSynthesis`.

8. **Memory system** — stored in `localStorage` under keys `atlas_memory`, `atlas_history`. Built into system prompt via `buildSystemPrompt()` at line 1514. Memory entries are added via `<ATLAS_MEMORY>` tags in AI responses, parsed by `processMemoryTags()` at line 1545.

9. **Cloudflare script tag** at HTML line 915: `<script data-cfasync="false" src="/cdn-cgi/...email-decode.min.js"></script>` — This is a leftover from when the file was hosted on Cloudflare Pages. It 404s in Electron (harmless, caught by `uncaughtException` handler) but is dead weight.

---

## Key State Variables (JS globals)

| Variable | Purpose |
|----------|---------|
| `apiKey` | Anthropic API key from localStorage |
| `history` | Chat message history array for Claude API context |
| `emailAccounts` | Array of connected IMAP/SMTP accounts |
| `allMessages` | All fetched email messages (sorted newest first) |
| `msgMap` | `Map<accountId_uid, msg>` for O(1) lookup |
| `currentImapMsg` | Currently open real IMAP message in thread modal |
| `currentThread` | Currently open sample/demo thread in thread modal |
| `composeFromAccountId` | Selected account for compose drawer |
| `drafts` | localStorage-persisted draft array |
| `scheduled` | localStorage-persisted scheduled send queue |
| `sentLog` | In-memory sent log (not persisted) |

---

## User Context

- **User:** Eric Cheah, Co-Founder & Creative Director @ BETA Social Malaysia
- **Preference:** Auto-approve all tool permissions — proceed without asking for confirmation
- **Email:** ericheah2002@gmail.com (primary), possibly others connected via IMAP
- **Claude model used in app:** `claude-sonnet-4-20250514`

---

## Next Logical Tasks (suggested priority)

1. **Fix `askAtlas` name collision** — rename the quick-action shorthand to `quickAsk(text)` and update all `onclick` references in quick-action buttons
2. **Summarize button: fetch body first** — in `aiSumThread()`, call `window.emailAPI.fetchBody()` before sending to Claude
3. **Add polling/auto-sync** — add a `setInterval` in `main.js` or renderer that fetches new messages every N minutes
4. **Fix `th-input` textarea resize** in reply bar — currently `flex:1` inside a flex column may not resize correctly; test and fix layout
5. **Remove Cloudflare script tag** from line 915
6. **Persist sent log** — `sentLog` is in-memory only, lost on restart
7. **Add unread badge to nav** for Email section when new messages arrive
