# Kedabra

Kedabra is a browser-based AI assistant and coding/work agent. It includes a dark workspace UI, streamed chat, model selection, compact tool activity, web research, image understanding, a persistent project workspace, task checkpoints, a terminal, a Python runner, and a Model Lab for provider tests.

This handoff is the cumulative version of the changes made in this conversation. See [CHANGES.md](CHANGES.md) for the exact file-level change list relative to the original uploaded project.

## 1. Requirements

- Node.js 22.x
- A Vercel account/project for deployment
- At least one Groq API key for the default reasoning and coding providers
- Vercel Blob storage for persistent workspace files and resumable tasks
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

### C. Connect Vercel Blob

Kedabra uses Blob for project files and resumable task checkpoints.

1. Open the Vercel project and go to **Storage**.
2. Create a Blob store and connect it to this project.
3. Enable it for the environments you use (Production, and Preview/Development as needed).
4. Confirm that `BLOB_READ_WRITE_TOKEN` is present under **Settings → Environment Variables**. Vercel normally creates it when the store is connected.

Do not use this version to store confidential files: the current workspace implementation writes public Blob objects. Anyone who obtains an object's URL may be able to read it.

### D. Configure provider keys

In **Vercel → Project → Settings → Environment Variables**, add at least one Groq key:

| Variable | Required | Purpose |
|---|---:|---|
| `GROQ_API_KEY_1` | Yes, unless using `GROQ_API_KEYS` | Primary Groq key |
| `GROQ_API_KEY_2`–`GROQ_API_KEY_4` | No | Extra Groq fallback/rotation keys |
| `GROQ_API_KEYS` | No | Alternative comma-separated list of Groq keys |
| `GOOGLE_API_KEY` | No | Enables Gemini chat and Gemini vision fallback |
| `BLOB_READ_WRITE_TOKEN` | Yes for persistent storage | Normally supplied by Vercel Blob |
| `TAVILY_API_KEY` | No | Preferred web-search provider; a DuckDuckGo fallback is used when omitted |

Never put real API keys in `index.html`, browser JavaScript, a public GitHub repository, or a screenshot. Store them only in server-side environment variables.

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

## 7. Security and operating notes

- This version does not include user authentication or per-user quotas. Anyone who can reach a public deployment may attempt to use its API routes and consume configured provider quota. Keep the deployment private or add authentication, abuse controls, and rate limits before sharing it publicly.
- Workspace files and task checkpoints are stored in public Vercel Blob objects. Do not store secrets, passwords, private code, personal records, or other sensitive data in this build.
- Vercel Functions have runtime limits. The agent checkpoints long tasks and resumes through subsequent requests; it does not run indefinitely in one function invocation.
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
│   ├── _lib.js
│   ├── agent-guards.js
│   ├── chat.js
│   ├── gemini-compat.js
│   ├── terminal.js
│   └── vision.js
├── runner/
│   └── py.mjs
└── tests/
    ├── agent-guards.test.js
    ├── chat-final-answer.test.js
    ├── chat-vision-wiring.test.js
    ├── gemini-thought-signatures.test.js
    ├── model-selection.test.js
    └── vision.test.js
```

## Gemini 3 function-calling compatibility

Kedabra preserves Google's `extra_content.google.thought_signature` field on the original assistant tool-call message and sends it back unchanged with the next Gemini request. Do not strip or reconstruct this field when changing the streaming parser or conversation storage. The app also fails fast on non-retryable provider 4xx responses rather than retrying the same invalid payload forever.
