# Frontend kickoff — Samuel's first session

This is the script for Samuel's very first working session, written so that Claude Code can follow it step by step. Everything it refers to is in this repository, so both developers build from the same rules.

**Samuel: do these three things yourself, then paste the prompt at the bottom.**

```bash
git clone https://github.com/TEAM-DEVV/samtec-security-system.git
cd samtec-security-system
claude
```

(If Git, Node.js 24 or pnpm 12 are missing, [Set up your computer](02-setup-on-windows.md) has the exact steps — or let Claude walk you through them in step 1 below.)

## What the first session does, in order

1. **Check the tools.** `git --version`, `node --version` (24.x), `pnpm --version` (12.x). Install anything missing per [the setup guide](02-setup-on-windows.md).
2. **Install and verify.** `pnpm install`, then `pnpm check` — everything must be green before writing any code.
3. **See it run.** `pnpm dev:web`, open http://localhost:5173 in Chrome, Edge or Firefox. Look at the System Status page and the Employees page: search, filter, page through. This is all **mock data** — the badge in the top bar says so.
4. **Understand the map.** Open [the build map](../build-map.html) in a browser for the picture, then read [How the system works](01-how-the-system-works.md). Claude explains anything unclear, in plain words.
5. **Learn the reference page.** Walk through `apps/web/src/pages/employees-page.tsx` top to bottom: the query hook, the four states (loading / error / empty / data), pagination, and its test file. Every future page copies this shape.
6. **Start Task 1.** The task list lives in `apps/web/CLAUDE.md` (Claude loads it automatically when working in that folder). Task 1 is the sign-in page. Build it on a branch, test it, run `pnpm check`, run `/lens-review`, open a pull request. Francis reviews it.

**The rule that makes teamwork possible:** never push to `main`, and never change `packages/contracts/openapi.yaml` alone — the contract is the agreement between the two halves, and changing it is a two-person decision.

## The prompt to paste into Claude Code

> I'm Samuel, the frontend developer and repository owner of SAMTEC — it is also my final year project, so explain everything in plain beginner terms and make sure I can defend every part myself. Read README.md and docs/guides/00-frontend-kickoff.md, then follow the kickoff steps in order, one at a time: check my tools, install, show me the dashboard running on mock data, walk me through the docs and the reference page, and then start Task 1 from apps/web/CLAUDE.md with me. Ask me to confirm before moving to each next step.

## When something goes wrong

| Problem | Fix |
|---|---|
| Claude seems lost or ignores these rules | Make sure Claude Code was started **inside the cloned repository folder** — the rules load from there. Close it, `cd samtec-security-system`, run `claude` again. |
| The browser page is blank or says the mock API could not start | Use Chrome, Edge or Firefox — not a private window or an in-app preview. |
| `pnpm` refuses to install something for security reasons | That is the supply-chain protection working. Stop and tell Francis; never switch it off. |
| Anything else | The troubleshooting tables at the end of [the setup guide](02-setup-on-windows.md) and [the frontend guide](03-frontend-guide.md). |
