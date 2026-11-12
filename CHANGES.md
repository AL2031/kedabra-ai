# Change log: original upload → final handoff

Compared against the original `kedabra-ai-main.zip` supplied at the start of this conversation.

## Modified application files

| File | What changed |
|---|---|
| `index.html` | Redesigned the interface around the supplied reference: restrained dark workspace, narrower navigation sidebar, centered welcome area, large composer, quick-action shortcuts, upper-right model selector, compact activity/progress presentation, and responsive layout. Added functional model selection and one-request web-search toggle behavior. Improved handling of streamed/final answers and image attachments. |
| `api/chat.js` | Reduced unnecessary model calls for simple/one-step tasks; bounded and trimmed chat context; capped and cached web research; shortened tool context; increased provider timeout; detected output-token truncation and retried with a larger allowance; rejected progress-only narration as a final result; grouped tool progress; added explicit model selection and Gemini 3.6 Flash configuration with legacy Gemini 2.5 Flash/Pro remapping; preserves Google function-call signatures and stops infinite retries on permanent provider errors. |
| `api/agent-guards.js` | Added/expanded progress-only answer detection, read-operation cache helpers, workspace mutation detection, and bounded execution/read safeguards. |
| `api/vision.js` | Standardized Gemini vision on Gemini 3.6 Flash with legacy 2.5 setting remapping; retained Qwen/Gemini image testing, provider availability reporting, and image validation/fallback behavior. |
| `README.md` | Replaced stale archive references with setup instructions for the final project; documented environment variables, deployment, local development, models, vision, safeguards, and security limitations. |

## Modified test files

| File | What changed |
|---|---|
| `tests/agent-guards.test.js` | Regression coverage for progress-only answers, read caching, cache invalidation, tool budgets, and workspace snapshot reuse. |
| `tests/chat-final-answer.test.js` | Regression coverage for streamed/final answer rendering, avoiding duplicates, and compact activity display. |
| `tests/vision.test.js` | Expanded mocked tests for Qwen/Gemini provider behavior, image input validation, model comparison, and vision fallback. |
| `tests/gemini-thought-signatures.test.js` | Added regression tests for Gemini signature retention, stream-chunk merging, provider fallback sanitization, and non-retryable 4xx handling. |

## Added files

| File | Purpose |
|---|---|
| `tests/model-selection.test.js` | Verifies Gemini 3.6 Flash defaults/remapping and that model selection/web-search state are sent correctly. |
| `api/gemini-compat.js` | Preserves Gemini `extra_content.google.thought_signature` metadata across streaming chunks, checkpoints and provider fallback; strips Google-only metadata when falling back to Groq. |
| `.env.example` | Safe template listing supported environment variables without real credentials. |
| `.gitignore` | Excludes local secrets, dependencies, Vercel metadata, and generated OS files. |
| `.github/workflows/tests.yml` | Runs `npm test` with Node 22 on pushes and pull requests. |
| `CHANGES.md` | This file-level audit. |

## Files carried forward unchanged from the original upload

- `api/_lib.js`
- `api/terminal.js`
- `package.json`
- `runner/py.mjs`
- `vercel.json`
- `tests/chat-vision-wiring.test.js`

These files are included in the complete ZIP but were not changed in the comparison against the original upload.

## Verification

- `npm test`: 33 tests passed, 0 failed (run against this final handoff).
- The test run uses Node's built-in test runner and mocked/source-level regression checks. It does not validate live API credentials or prove a successful Vercel deployment.

## Gemini function-call signature fix

- Added `api/gemini-compat.js` to preserve Gemini 3 `extra_content.google.thought_signature` metadata across streamed tool-call deltas and provider fallback.
- Updated `api/chat.js` to append the complete signature-bearing assistant tool-call message to the next request, reject unsigned Gemini 3 function calls before executing them, and stop retrying permanent 4xx request errors indefinitely.
- Added `tests/gemini-thought-signatures.test.js` covering actual synthetic SSE parsing, signature retention, chunk merging, provider fallback sanitization, and retry classification.
## Unlimited agent execution counts

- Removed the eight-round agent-loop cap. The agent now continues until it returns a concrete result, is cancelled, or reaches the current serverless invocation deadline; checkpoints allow the task to resume in later requests.
- Removed the fixed per-step tool-call budget and hard stop, so tasks are not cut off after a predetermined number of tool operations.
- Removed the planner prompt and parser ceilings on the number of plan steps. Plans can include as many steps as the task requires.
- Increased the planner response allowance to support larger plans.
- Kept cancellation, provider timeouts, per-invocation deadlines, and checkpoint/resume behavior as operational safeguards.


## Unlimited task steps and compact UI/model naming update

- Confirmed the agent loop uses an open-ended loop and no longer applies a fixed eight-round, task-step, or per-step tool-call count. Removed remaining fixed search/page-fetch ceilings and matching prompt instructions that had limited web research.
- Raised the planner and output retry allowance so more substantial plans can be represented, while retaining provider token limits, context compaction, checkpoint/resume, cancellation, and serverless invocation deadlines.
- Reduced the reference-inspired UI scale modestly: narrower sidebar, smaller navigation controls, smaller heading/composer/quick actions, and tighter chat typography and spacing.
- Renamed visible model choices: **Coder** (Qwen 3.8 27B), **Thinker** (GPT-OSS 120B), and **Genius** (Gemini 3.6 Flash). Auto selection remains available. Friendly names are also used in progress/step labels and Model Lab; provider IDs remain server-side.

## Browser tab icon update

- Replaced the old purple inline favicon with a monochrome Kedabra `K` monogram that matches the minimal charcoal-and-white workspace branding.
- Added `favicon.svg` as the primary scalable browser-tab icon, plus `favicon.png`, `favicon.ico`, and `apple-touch-icon.png` fallbacks.
- Added a dark browser theme color and versioned icon URLs to help browsers refresh cached favicons.

## Background execution (tasks continue when the browser or computer is off)

- Added `api/_background.js`: signed (HMAC) server-to-server continuation, explicit cancel marker, per-job lease, and the rules for when a task should keep running.
- `api/chat.js`: the job loop moved into `runJob`. A browser disconnect now only stops streaming to the browser and no longer pauses the task. When an invocation reaches its time budget it saves a checkpoint and schedules the next invocation itself via `waitUntil`. Added `action: "cancel"`, lease-based single-runner protection with an "attach" response for a second runner, a failed-job state, limited retry of transient errors in background mode, and a safety cap on chained invocations.
- `index.html`: the Stop button now also sends the explicit cancel request (closing the tab no longer cancels).
- `package.json`: added `@vercel/functions`; the test script enables Node's module-mock flag.
- Added `tests/background.test.js` (helpers) and `tests/background-handler.test.js` (end-to-end handler tests with an in-memory Blob store and fake provider: completes after disconnect, schedules the next hop, background hop completes, forged token rejected, lease attach and takeover, Stop cancels, disconnect alone does not cancel).
- `npm test`: 53 tests pass. These tests do not exercise a real Vercel deployment; see README section 6b for the caveats.

## Accounts (username + password, no email)

- Added `api/_auth.js` and `api/auth.js`: sign up, sign in, sign out and session check. Passwords use salted scrypt. Sessions are signed `HttpOnly` cookies. Account records live in Blob at an unguessable, secret-derived path. Usernames are claimed atomically, accounts lock for 15 minutes after five wrong passwords, and unknown users take the same time and give the same error as wrong passwords. Optional `SIGNUP_CODE` invite code.
- `api/chat.js`, `api/terminal.js`, `api/vision.js` (POST): now require a session. The workspace ID comes from the session; a client-supplied `sid` is ignored. Server-to-server background continuation still uses its own signed header.
- Added `login.html` (sign in / create account) and changed `index.html`: redirects signed-out visitors to the sign-in page, stores chats per account (`kd_chats:<username>`), redirects to sign-in on any `401`, adds a Sign out button, and shows the account initial.
- The first signup on a browser that predates accounts can adopt its old workspace and saved chats (one-time, first claim wins).
- Added `scripts/auth-admin.mjs` to reset a forgotten password (there is no email reset).
- Tests: `tests/auth.test.js` (19 tests), session coverage added to the chat and vision tests. `npm test`: 72 tests pass. The two pages were also smoke-tested in a simulated browser (18 checks).

## Moved storage from Vercel Blob to Turso (SQLite)

Vercel suspended the Blob store (free-plan limit of 2,000 write/list operations a month), and Blob is the wrong tool for small, frequently changing records.

- Added `api/_store.js`: every database operation in one module (accounts, task checkpoints with lock and Stop flag, workspace files). Production uses libSQL's HTTP client; `file:` URLs use a local SQLite file for tests.
- The task lock is now one atomic SQL statement, so exactly one of any number of simultaneous workers wins. Saves are fenced: only the lock holder can write a task's progress. Stop is a flag that works even if pressed before the task exists, and is polled with a cheap row read every 5 seconds (restored from 30 s; default hop cap restored to 120).
- Usernames are unique by a database constraint. Failed-login counting is a single atomic statement.
- Workspace files are served by the new `api/file.js` to their owner only (they were public Blob URLs). Responses carry `nosniff` and a sandbox CSP.
- Files are capped at 5 MB each. A workspace snapshot loads all files in one query instead of one request per file.
- Removed the "adopt the old browser workspace" signup feature (that data lived in Blob). The first signup in a browser still keeps its saved chats; unfinished tasks are marked stopped.
- `@vercel/blob` removed; `@libsql/client` added. New env vars: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`. Added `.env.example`, `.gitignore`, and a CI workflow.
- Tests now run against a real SQLite file instead of a mock (no experimental Node flags): `tests/store.test.js`, `tests/file-route.test.js`, and rewritten account and background tests.

## Faster, more honest web search

- DuckDuckGo soft-blocks server IPs (HTTP 202 with no results). That was reported as "No results", so the model kept rewriting its query, and each failure could cost up to 12 seconds.
- A blocked, rate-limited or timed-out search is now an explicit "unavailable" result (7 s timeout, `SEARCH_TIMEOUT_MS`) telling the model not to retry. After one outage, later searches in that task skip the network for 90 seconds. Tavily 429/5xx is handled the same way.
- Searches and page fetches requested in the same model turn now run concurrently instead of one after another.
- No cap on the number of searches was added (the project deliberately has none; its tests enforce that).
- `npm test`: 110 tests pass.
