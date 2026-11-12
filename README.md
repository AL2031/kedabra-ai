# Kedabra

Kedabra is a browser-based AI assistant and coding/work agent. It includes a dark workspace UI, streamed chat, model selection, compact tool activity, web research, image understanding, a persistent project workspace, task checkpoints, a terminal, a Python runner, and a Model Lab for provider tests.

This handoff is the cumulative version of the changes made in this conversation. See [CHANGES.md](CHANGES.md) for the exact file-level change list relative to the original uploaded project.

## 1. Requirements

- Node.js 22.x
- A Vercel account/project for deployment
- At least one Groq API key for the default reasoning and coding providers
- Turso (SQLite) database for accounts, workspace files and resumable tasks
- A Google Gemini API key is optional; it enables Gemini in the model selector and as a vision fallback

## 2. Deploy to Vercel (recommended)

### A. Put the project in GitHub

1. Download `kedabra-complete-handoff.zip` and extract it.
2. Create a new GitHub repository.
3. Upload the **contents of the `kedabra/` folder** to the repository root. Do not upload an extra enclosing `kedabra/` folder as a nested directory.
4. Confirm that `index.html`, `package.json`, `vercel.json`, `api/`, `runner/`, and `tests/` are directly at the repository root.
5. Commit the files.

### B. Import into Vercel

1. Sign in to Vercel and choose **Add New → Project**.
2. Import the GitHub repository.
3. Choose **Other** as the framework preset if prompted.
4. Keep the Root Directory as `.` (the repository root).
5. Leave the Build Command and Output Directory empty. Vercel serves `index.html` and deploys the files in `api/` as serverless functions.
6. Add the environment variables in the next section, then deploy.

### C. Create a Turso database

Kedabra keeps accounts, workspace files and task checkpoints in a [Turso](https://turso.tech) (hosted SQLite) database. The tables are created automatically on the first request.

1. Create a free Turso account and a database (the dashboard works, or the CLI: `turso db create kedabra`).
2. Copy the database URL (looks like `libsql://kedabra-yourname.turso.io`; the CLI shows it with `turso db show kedabra --url`).
3. Create an auth token for it (`turso db tokens create kedabra`, or the dashboard).
4. Add both as environment variables in Vercel: `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.

The database is private to those credentials. Files are served only to their owner (section 6c). Free-plan limits change, so check Turso's current pricing page before relying on them.

### D. Configure provider keys

In **Vercel → Project → Settings → Environment Variables**, add at least one Groq key:

| Variable | Required | Purpose |
|---|---:|---|
| `GROQ_API_KEY_1` | Yes, unless using `GROQ_API_KEYS` | Primary Groq key |
| `GROQ_API_KEY_2`–`GROQ_API_KEY_4` | No | Extra Groq fallback/rotation keys |
| `GROQ_API_KEYS` | No | Alternative comma-separated list of Groq keys |
| `GOOGLE_API_KEY` | No | Enables Gemini chat and Gemini vision fallback |
| `TURSO_DATABASE_URL` | Yes | Your Turso database URL (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | Yes | Token for that database |
| `TAVILY_API_KEY` | Recommended | Web-search provider. Without it Kedabra scrapes DuckDuckGo, which often rate-limits server IPs (see Web search below) |
| `SEARCH_TIMEOUT_MS` | No | How long one search may take before it is treated as unavailable (default `7000`) |

Never put real API keys in `index.html`, browser JavaScript, a public GitHub repository, or a screenshot. Store them only in server-side environment variables.

**Web search.** Set `TAVILY_API_KEY` if you can. The DuckDuckGo fallback scrapes a web page, and DuckDuckGo soft-blocks many server IPs (it answers HTTP 202 with no results), which made searches slow and unreliable. Searching now fails fast: a blocked or timed-out search is reported as "unavailable", the model is told not to retry, and further searches in that task are skipped for 90 seconds instead of each waiting out a timeout. Several searches or page fetches requested in one model turn now run at the same time. There is still no fixed limit on how many searches a task may make.

### E. Optional model overrides

The app has these defaults; you generally do not need to set them:

| Variable | Default | Purpose |
|---|---|---|
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Reasoning, planning, general work and final synthesis |
| `QWEN_MODEL` | `qwen/qwen3.8-27b` | Coding-focused steps |
| `GOOGLE_MODEL` | `gemini-3.6-flash` | Gemini chat model |
| `QWEN_VISION_MODEL` | `qwen/qwen3.8-27b` | Image understanding through Groq |
| `GOOGLE_VISION_MODEL` | `gemini-3.6-flash` | Image understanding through Google |

The Gemini setting is intentionally pinned to **Gemini 3.6 Flash**, matching the requested app configuration. If an old `GOOGLE_MODEL` or `GOOGLE_VISION_MODEL` value points to Gemini 2.5 Flash/Pro, the code remaps that legacy setting to `gemini-3.6-flash`.

After changing any environment variable, redeploy the project so the serverless functions use the updated values.

### F. Verify deployment

1. Open the Vercel deployment URL.
2. Send a simple prompt such as: `Explain what you can do.`
3. Use the model selector in the top-right to select an available provider.
4. Open **Model Lab** using the settings gear and test text/image providers.
5. Open `/api/chat` and `/api/vision` on your deployment to inspect configured model availability. These endpoints report model IDs and availability, not API keys.

## 3. Run locally

1. Extract the project and open a terminal in the `kedabra/` folder (the folder containing `package.json`).
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env.local` and fill in your own keys. Keep `.env.local` out of Git.
4. Link the folder to your Vercel project (first time only):

   ```bash
   npx vercel link
   ```

5. To pull the Vercel environment variables into `.env.local`, run:

   ```bash
   npx vercel env pull .env.local
   ```

   This may replace the local file with the project's environment values. Keep a backup of any local-only variables before running it.

6. Start the local Vercel development server:

   ```bash
   npx vercel dev
   ```

7. Open the local URL printed by Vercel (usually `http://localhost:3000`).

Run the automated tests with:

```bash
npm test
```

The included tests use source-level checks and mocked provider responses; they do not require real model keys or consume provider credits. They are regression tests, not a substitute for checking the live deployment.

## 4. Model selector

The top-right selector offers:

- **Auto** — choose a configured provider automatically.
- **Coder** — Qwen 3.8 27B on Groq; coding, debugging and implementation.
- **Thinker** — GPT-OSS 120B on Groq; reasoning, planning, analysis and synthesis.
- **Genius** — Gemini 3.6 Flash on Google; general and multimodal tasks; requires `GOOGLE_API_KEY`.

These are display names; the provider model IDs remain in server-side configuration.

Unavailable providers are disabled in the selector. The chosen model is saved in browser local storage and sent with each chat request. Web search is a one-request toggle and resets after the message is sent.

## 5. Image attachments and vision

Normal chat accepts up to three PNG, JPEG, or WebP images. The browser compresses images before sending them. The server sends them to the configured vision-capable provider before planning/execution, then stores the resulting text specification in the task checkpoint so later text models do not repeatedly receive the original image bytes.

The server-side validation currently limits each image to 1 MB and the combined image payload to 2.45 MB. Use Model Lab to compare configured vision providers with the same prompt and images.

## 6. Token-use and completion safeguards

- Straightforward questions and focused research can skip a separate planning call. Larger plans can contain as many execution steps as required; there is no hard-coded eight-step ceiling.
- One-step tasks can return their completed result directly rather than paying for redundant summarization and final-answer calls.
- Earlier chat context is bounded and clipped before transmission.
- Web searches and source-page fetches have no fixed per-task count ceiling; repeated URLs/queries are cached to avoid wasted calls.
- Tool outputs are limited before they enter the model context.
- Provider streams have a longer timeout. Output-token truncation is detected and retried with a larger allowance.
- Progress narration is not accepted as a completed answer. If final synthesis cannot finish, the app reports saved work and makes the incomplete state explicit.
- There is no fixed task-step count, agent-round count, web-search count, source-fetch count, or per-step tool-call count. Long-running tasks checkpoint their progress and continue across serverless requests until completion, cancellation, or an infrastructure/provider boundary.
- Research/tool activity is grouped into a collapsible section rather than rendering every event as a separate large card.

Output-size, context-size, timeout, and serverless invocation limits remain because providers and hosting impose real technical constraints. They do not impose a fixed number of task steps or tool operations.

## 6b. Background execution (keeps working when your computer is off)

Tasks now run on the server, not in your browser. You can close the tab, lock your phone or shut down your computer, and the task keeps going on Vercel.

How it works:

1. Each `/api/chat` invocation works for up to ~3 minutes, then saves a checkpoint to the database.
2. Before it exits, the server schedules the next invocation of itself (`waitUntil` + a signed request to `/api/chat`). The chain continues until the task finishes, is stopped, fails, or hits the safety cap.
3. A lock ("lease") in the database makes sure only one runner works on a job at a time. The database grants it to exactly one of any number of simultaneous requests, and only the lock holder can save progress. If you reopen the page mid-task, it attaches to the running job (status updates, then the final answer) instead of starting a second copy.
4. Closing the tab does **not** stop a task. The **Stop** button sends an explicit cancel to the server, which ends the task and the chain.
5. When you come back, the page resumes the pending chat automatically and shows the finished answer.

Optional environment variables (all have working defaults; none are required):

| Variable | Default | Purpose |
|---|---|---|
| `MAX_BACKGROUND_INVOCATIONS` | `120` | Safety cap on chained invocations per task (about 6 hours) |
| `BACKGROUND_MODE` | unset | Set to `off` to disable background continuation. Tasks then advance only while a browser tab is attached |
| `CANCEL_POLL_MS` | `5000` | How often a running task checks for Stop (one cheap row read) |
| `KEDABRA_CONTINUE_SECRET` | derived from `AUTH_SECRET` / `TURSO_AUTH_TOKEN` | Secret used to sign the server-to-server continuation request |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | unset | Only needed if Vercel Deployment Protection blocks the server's own request to `/api/chat` (for example on protected preview deployments) |
| `INVOCATION_BUDGET_MS` | `180000` | Work time per invocation |

Limits and caveats:

- This is not "offline" in the sense of no internet: the models (Groq, Gemini) and web search are cloud services, so the server needs them to be reachable. What changed is that your own device no longer needs to be on.
- Vercel must be able to call its own `/api/chat`. If your deployment sits behind Deployment Protection, set `VERCEL_AUTOMATION_BYPASS_SECRET`.
- If every provider is down or out of quota, the task keeps retrying until the invocation cap, then stops with its progress saved.
- Background tasks still consume provider quota and Vercel function time while you are away. Lower `MAX_BACKGROUND_INVOCATIONS` if you want a tighter ceiling.
- Every step writes a checkpoint (one row update) to your database. Turso meters rows read and written per month rather than API calls, but a very long-running agent still counts against your plan. Check the current limits.
- If a runner crashes, its lease expires after 5 minutes. Reopening the page then resumes the task. There is no scheduled watchdog, so an unattended task that dies mid-chain waits for you to return.

## 6c. Accounts (username + password)

The app now requires you to sign in. There is no email: an account is just a username and a password.

- Open the site and use **Create account**. Usernames are 3-32 characters (letters, numbers, `.`, `-`, `_`); passwords are 8-200 characters.
- Your workspace and background tasks belong to your account. The server takes the workspace ID from your signed session, so other people cannot reach your workspace by sending a different ID. Chats are stored per account in the browser you use.
- **Sign out** is the arrow icon at the bottom of the sidebar. Signing out does not stop a task that is running in the background.
- The first account created in a browser that was used before accounts existed keeps that browser's saved chats. Tasks that were unfinished are marked stopped. Workspace files and task state from before accounts or before the move to Turso are not carried over.

Optional environment variables (only the database variables are required):

| Variable | Purpose |
|---|---|
| `SIGNUP_CODE` | **Recommended for any public deployment.** When set, creating an account requires this invite code. Without it, anyone who finds your site can create an account and use your provider quota. |
| `AUTH_SECRET` | Long random string used to sign sessions. If unset, a key is derived from `TURSO_AUTH_TOKEN`. Set it explicitly if you ever rotate the database token, otherwise everyone is signed out. |

How it is protected:

- Passwords are stored as salted scrypt hashes, never in plain text.
- Sessions are signed cookies (`HttpOnly`, `SameSite=Lax`, `Secure` on https) that last 30 days and are refreshed whenever you open the app. POSTs from other sites are rejected.
- Five wrong passwords lock an account for 15 minutes. Unknown usernames and wrong passwords return the same message.
- Chat, file and model-lab routes return `401` without a session.

**Forgotten password.** There is no email, so there is no self-service reset. The person running the deployment can reset it:

```bash
npx vercel env pull .env.local
NEW_PASSWORD='a-new-password' node --env-file=.env.local scripts/auth-admin.mjs reset <username>
```

Limitations to know about:

- Sessions are stateless. Signing out clears the cookie on that browser, but a stolen cookie stays valid until it expires (30 days) or `AUTH_SECRET` changes. Changing `AUTH_SECRET` signs everyone out.
- There is no password-change screen yet, and no per-user usage limits.
- Account records and workspace files live in your Turso database, which is private to your credentials. Passwords are stored only as salted hashes. Files are served by `/api/file` to their owner only, with headers that stop a generated HTML page from running scripts inside your session.
- Do not store secrets in the workspace: the database operator (you) and anyone with your Turso token can read everything in it.

## 7. Security and operating notes

- Accounts (section 6c) protect the app's API routes. There are still no per-user usage limits, and anyone who can create an account can use your provider quota, so set `SIGNUP_CODE` before sharing the site.
- Workspace files and task checkpoints are stored in your Turso database. Anyone with your Turso credentials can read them, so keep `TURSO_AUTH_TOKEN` secret.
- Vercel Functions have runtime limits. The agent checkpoints long tasks and continues them through server-scheduled invocations (see section 6b); it does not run indefinitely in one function invocation.
- Model usage may incur charges or consume free-tier limits. Check each provider's current pricing, rate limits, and model availability.

## 8. Project structure

```text
kedabra/
├── index.html
├── favicon.svg
├── favicon.png
├── favicon.ico
├── apple-touch-icon.png
├── package.json
├── vercel.json
├── README.md
├── CHANGES.md
├── .env.example
├── .gitignore
├── .github/workflows/tests.yml
├── api/
│   ├── _auth.js
│   ├── _background.js
│   ├── _lib.js
│   ├── _secret.js
│   ├── _store.js
│   ├── agent-guards.js
│   ├── auth.js
│   ├── chat.js
│   ├── file.js
│   ├── gemini-compat.js
│   ├── terminal.js
│   └── vision.js
├── login.html
├── runner/
│   └── py.mjs
├── scripts/
│   └── auth-admin.mjs
└── tests/
    ├── helpers/db.js
    ├── file-route.test.js
    ├── search.test.js
    ├── store.test.js
    ├── agent-guards.test.js
    ├── auth.test.js
    ├── background.test.js
    ├── background-handler.test.js
    ├── chat-final-answer.test.js
    ├── chat-vision-wiring.test.js
    ├── gemini-thought-signatures.test.js
    ├── model-selection.test.js
    └── vision.test.js
```

## Gemini 3 function-calling compatibility

Kedabra preserves Google's `extra_content.google.thought_signature` field on the original assistant tool-call message and sends it back unchanged with the next Gemini request. Do not strip or reconstruct this field when changing the streaming parser or conversation storage. The app also fails fast on non-retryable provider 4xx responses rather than retrying the same invalid payload forever.
