# Kedabra

Kedabra is a browser-based AI coding/work agent with a persistent cloud workspace, AI task planning, per-step model routing, resumable checkpoints, compact project memory, a terminal, Python/JavaScript execution, web search, subagents, a text/vision Model Lab, and image-aware normal chat. The repository is ready to import into Vercel.

## 1. Deploy to Vercel (recommended)

### A. Put the files in GitHub

1. Download and extract `kedabra-github-ready.zip`.
2. Create a new GitHub repository.
3. Upload the **contents** of the extracted folder, not the folder itself. The repository root must directly contain `index.html`, `package.json`, `vercel.json`, `api/`, and `runner/`.
4. Commit the files to the repository's main branch.

The repository should look like this:

```text
kedabra/
├── index.html
├── package.json
├── vercel.json
├── .env.example
├── .gitignore
├── README.md
├── .github/
│   └── workflows/
│       └── tests.yml
├── api/
│   ├── _lib.js
│   ├── chat.js
│   ├── terminal.js
│   └── vision.js
├── runner/
│   └── py.mjs
└── tests/
    ├── chat-vision-wiring.test.js
    └── vision.test.js
```

### B. Import the repository into Vercel

1. Open https://vercel.com and sign in.
2. Select **Add New → Project**.
3. Import the GitHub repository you just created.
4. Select **Other** as the framework preset if Vercel asks.
5. Keep the project root at `/` (the repository root).
6. Leave the build command and output directory empty; this project serves `index.html` directly and runs the files in `api/` as Vercel Functions.
7. Deploy.

### C. Create persistent storage

Kedabra needs Vercel Blob for saved workspace files and resumable task checkpoints.

1. Open the Vercel project.
2. Go to **Storage**.
3. Select **Create Database → Blob** and create a store.
4. Connect the Blob store to this Kedabra project.
5. Enable the environments you use (at least Production; also Preview/Development if needed).
6. Confirm `BLOB_READ_WRITE_TOKEN` appears in Project → Settings → Environment Variables.

Redeploy after connecting storage or changing environment variables. Vercel's Blob integration normally creates the token automatically.

### D. Add AI provider keys

Open **Project → Settings → Environment Variables**. Add at least one Groq key:

| Variable | Required? | Purpose |
|---|---|---|
| `GROQ_API_KEY_1` | Yes, at least one provider key is required | Primary Groq key |
| `GROQ_API_KEY_2` – `GROQ_API_KEY_4` | Optional | Extra Groq fallback keys |
| `GROQ_API_KEYS` | Optional alternative | Several Groq keys separated by commas |
| `GOOGLE_API_KEY` | Optional | Gemini fallback and comparison tests |
| `BLOB_READ_WRITE_TOKEN` | Required for persistent tasks | Normally added by connecting Blob |
| `TAVILY_API_KEY` | Optional | Preferred web search provider; DuckDuckGo fallback is used without it |

Do not put API keys in `index.html`, JavaScript sent to the browser, GitHub, or a public repository. Add them only as Vercel environment variables. You can add multiple Groq keys either as separate `GROQ_API_KEY_1` through `_4` variables or as one comma-separated `GROQ_API_KEYS` variable.

### E. Optional model settings

Add these only when you want to override the defaults:

| Variable | Default | Used for |
|---|---|---|
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Reasoning, planning, summarization and final answers |
| `QWEN_MODEL` | `qwen/qwen3.8-27b` | Coding and code-focused steps |
| `GOOGLE_MODEL` | `gemini-2.5-flash` | General Gemini fallback |
| `QWEN_VISION_MODEL` | `qwen/qwen3.8-27b` | Groq image/vision tests in Model Lab |
| `GOOGLE_VISION_MODEL` | `gemini-3.8-flash` | Gemini image/vision tests in Model Lab |

`QWEN_VISION_MODEL` can be set separately from `QWEN_MODEL`. Keep it set to a vision-capable model. The included default is `qwen/qwen3.8-27b`.

After adding or changing variables, go to **Deployments**, open the latest deployment menu, and redeploy so the new function environment receives them.

### F. Open and test the deployment

1. Open the Vercel deployment URL.
2. Send a normal message, such as: `Create a small HTML page with a counter. Run a test and show me the file.`
3. Click **Workspace** to inspect the files and open **Terminal** to run commands.
4. Click **Model Lab** in the top bar to test models separately.
5. Open `https://YOUR-DEPLOYMENT.vercel.app/api/vision` to see which vision providers are configured. This endpoint returns model names and key availability, never the keys themselves.

## 2. Attach screenshots and images in normal chat

The normal chat composer now has an image-attachment button. It accepts up to three PNG, JPG/JPEG or WebP images per message.

1. Click the image button beside the message box.
2. Choose up to three screenshots, mockups, diagrams, photos or other visual references.
3. Optionally describe what Kedabra should do with them, then send the message.
4. Kedabra compresses the files in the browser and stores the temporary upload bytes in IndexedDB so an interrupted first request can resume after a refresh.
5. Before planning, the server sends the images to a vision-capable model. It tries the configured Qwen vision model through Groq first and falls back to Gemini when a Google key is configured.
6. The vision model produces an implementation-ready visual report. That report is checkpointed and passed to the planner and every execution step, including coding steps. The original image bytes are then removed from browser attachment storage; only small thumbnails and the text report remain in chat history.

This lets Kedabra work from screenshots without sending the full original conversation or raw image data to every later text model. Coding and reasoning models receive the detailed visual report; they do not each receive the original binary image. The visual report is shown as an expandable **Visual references analyzed** block in the assistant response.

Example requests:

```text
Recreate this screenshot as a responsive HTML page. Match the layout, spacing, typography and colors as closely as possible.

Find the visual bugs in these screenshots and fix the relevant files in my workspace.

Use the attached diagram as the specification. Implement the flow and test every state.

Compare this reference image with the current page in my project, then update the UI to match.
```

## 3. Use Model Lab for vision and model testing

Click **Model Lab** in the app's top bar.

- **Qwen 3.8 Vision · Groq**: tests the Groq Qwen vision model.
- **Gemini Vision · Google**: tests the configured Gemini vision model (requires `GOOGLE_API_KEY`).
- **Compare both models**: sends the same prompt and images to both and displays the two results side by side in separate result cards.
- **Groq Reasoning · text-only**: tests the configured reasoning model without an image.
- **Text-only tests**: leave the image picker empty and enter any prompt. The all-model comparison includes Qwen, Gemini and Groq Reasoning when their providers are configured.
- **Image tests**: choose up to three PNG, JPG or WebP images. The browser resizes and compresses them before sending, to stay under the Vercel request-size limit. The image upload is not added to chat history.

Useful prompts to try:

```text
Describe every visible object. Separate what you can directly observe from assumptions.

Read all text in the image. Preserve the original spelling and line breaks.

Inspect this screenshot like a QA tester. List visible bugs, alignment issues, unclear labels, and suggested fixes.

Analyze this chart. Identify the axes, trends, outliers, and anything that cannot be determined from the image alone.

Compare the two screenshots and list every visible UI difference.
```

The Model Lab is a practical manual test bench, not a standardized benchmark. For fair comparisons, use the same prompt and same images, and remember that model output quality, speed, and token usage can vary.

## 4. Run locally

You need Node.js 22 and a Vercel account/project linked to the repository.

1. Download and extract the project.
2. Open a terminal in the project root.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Link the folder to your Vercel project (first time only):

   ```bash
   npx vercel link
   ```

5. Pull your Vercel development environment variables into `.env.local`:

   ```bash
   npx vercel env pull .env.local
   ```

6. Start the local Vercel development server:

   ```bash
   npx vercel dev
   ```

7. Open the local URL printed by the CLI (normally http://localhost:3000).

Run the included integration and vision-route tests with `npm test`. They use mocked provider responses and do not consume API credits.

`.env.local` is ignored by Git. Never commit real keys. Local Blob callbacks and behavior can differ from deployed Vercel; use the deployed environment for final persistence checks.

## 5. How the task engine works

1. When images are attached, a vision-capable model inspects them first and produces a visual specification. The raw images are not copied into the task checkpoint.
2. A planner model reads the current request, visual specification (if any), and compact prior-project memory.
3. It divides the request into ordered steps and selects a model category for each step.
4. Each step receives the compact project summary and the visual specification rather than the entire previous tool transcript.
5. The agent uses its tools, saves workspace changes, and checkpoints completed tool calls.
6. A summarizer updates the project memory after each step.
7. The browser reconnects to the saved task when another serverless invocation is needed.
8. A final model writes the user-facing response from the completed plan and compact summary.

Provider failures trigger key/model fallback and retries. If every configured key is missing, invalid, revoked, rate-limited, or out of quota, Kedabra cannot make new model progress, but it keeps the task checkpoint and retries in later requests while the page remains open. A working provider is still required for new output.

## 6. Included files and what they do

| File | Purpose |
|---|---|
| `index.html` | Complete browser interface, chat history, task progress, workspace drawer, terminal UI and Model Lab |
| `api/chat.js` | Planner, model router, agent loop, tool execution, retries, checkpoints, compact summaries and final synthesis |
| `api/_lib.js` | Blob-backed workspace files, shell helpers and task checkpoint storage |
| `api/terminal.js` | Workspace file listing and terminal API |
| `api/vision.js` | Shared Qwen/Gemini image-analysis functions and the Model Lab test endpoint |
| `tests/vision.test.js` | Mocked multimodal provider tests; run them with `npm test` |
| `tests/chat-vision-wiring.test.js` | Checks that normal chat sends images through visual analysis before planning |
| `runner/py.mjs` | Isolated Pyodide Python runner |
| `package.json` | Runtime dependencies and Node version |
| `vercel.json` | Vercel function duration and packaged-file configuration |
| `.env.example` | Example environment variables (contains no real keys) |
| `.gitignore` | Keeps local secrets and generated folders out of Git |
| `README.md` | Setup and usage guide |
| `.github/workflows/tests.yml` | Runs the automated tests on every push and pull request |

## 7. Important security and operating notes

- API keys stay on the server; the browser calls Kedabra's API routes, not providers directly. Normal-chat image uploads are held temporarily in browser IndexedDB and are not copied into the server-side task checkpoint. The server checkpoint stores only the vision model's text report and image names.
- This version does not include user authentication or per-user API quotas. Anyone who can access a publicly deployed URL can attempt to use its API routes and consume your configured model quota. Keep the deployment private/unshared or add authentication and rate limiting before sharing it publicly.
- Workspace files and task checkpoints are currently stored using public Vercel Blob objects. Anyone who obtains a Blob URL may be able to read that object. Do not store secrets, passwords, private source code, or sensitive files in this version.
- Vercel Functions have a maximum execution duration. The chat engine checkpoints work and the browser reconnects; it does not keep one serverless function alive forever. The included `vercel.json` sets a 300-second maximum. On Hobby, that limit is available with Fluid Compute; without Fluid Compute, the configured limit may be lower. See Vercel's current plan/runtime limits before relying on long unattended tasks.
- Model API usage may incur charges or consume free-tier quotas. Check each provider's current pricing, rate limits, and model availability.
