# Change log: original upload → final handoff

Compared against the original `kedabra-ai-main.zip` supplied at the start of this conversation.

## Modified application files

| File | What changed |
|---|---|
| `index.html` | Redesigned the interface around the supplied reference: restrained dark workspace, narrower navigation sidebar, centered welcome area, large composer, quick-action shortcuts, upper-right model selector, compact activity/progress presentation, and responsive layout. Added functional model selection and one-request web-search toggle behavior. Improved handling of streamed/final answers and image attachments. |
| `api/chat.js` | Reduced unnecessary model calls for simple/one-step tasks; bounded and trimmed chat context; capped and cached web research; shortened tool context; increased provider timeout; detected output-token truncation and retried with a larger allowance; rejected progress-only narration as a final result; grouped tool progress; added explicit model selection and Gemini 3.6 Flash configuration with legacy Gemini 2.5 Flash/Pro remapping. |
| `api/agent-guards.js` | Added/expanded progress-only answer detection, read-operation cache helpers, workspace mutation detection, and bounded execution/read safeguards. |
| `api/vision.js` | Standardized Gemini vision on Gemini 3.6 Flash with legacy 2.5 setting remapping; retained Qwen/Gemini image testing, provider availability reporting, and image validation/fallback behavior. |
| `README.md` | Replaced stale archive references with setup instructions for the final project; documented environment variables, deployment, local development, models, vision, safeguards, and security limitations. |

## Modified test files

| File | What changed |
|---|---|
| `tests/agent-guards.test.js` | Regression coverage for progress-only answers, read caching, cache invalidation, tool budgets, and workspace snapshot reuse. |
| `tests/chat-final-answer.test.js` | Regression coverage for streamed/final answer rendering, avoiding duplicates, and compact activity display. |
| `tests/vision.test.js` | Expanded mocked tests for Qwen/Gemini provider behavior, image input validation, model comparison, and vision fallback. |

## Added files

| File | Purpose |
|---|---|
| `tests/model-selection.test.js` | Verifies Gemini 3.6 Flash defaults/remapping and that model selection/web-search state are sent correctly. |
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

- `npm test`: 27 tests passed, 0 failed (run against this final handoff).
- The test run uses Node's built-in test runner and mocked/source-level regression checks. It does not validate live API credentials or prove a successful Vercel deployment.
