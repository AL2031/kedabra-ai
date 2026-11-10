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
