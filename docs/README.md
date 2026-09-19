# SAMTEC documentation

Everything about the project lives in this folder: the plan, the architecture and step-by-step guides.

**The one-page picture:** open [build-map.html](build-map.html) in a browser — the whole system's layers, the nine phases and the review lenses on a single interactive page. The plan documents below are the authoritative text behind it.

## Start here

If you are new to the project, read these in order.

0. **Samuel's very first session:** [Frontend kickoff](guides/00-frontend-kickoff.md) — three commands and one prompt, and Claude Code sets everything up with you.
1. [How the system works](guides/01-how-the-system-works.md): the whole system in plain English. Read this first.
2. [Set up your computer](guides/02-setup-on-windows.md): install the tools and run the project.
3. Your role guide:
   - Dashboard (Samuel): [Frontend guide](guides/03-frontend-guide.md)
   - API (Francis): [Backend guide](guides/04-backend-guide.md)
4. [Changing the API contract](guides/05-api-contract-workflow.md): how the frontend and backend stay in agreement.
5. [Git and pull requests](guides/06-git-and-pull-requests.md): how we save and share work.
6. [Using Claude Code](guides/07-using-claude-code.md): the four review lenses.
7. [The TEST environment](guides/09-test-environment.md): the shared online copy every merge deploys to.
7. [Glossary](guides/08-glossary.md): every technical word used in this project.

## The plan

| Document | Question it answers |
|---|---|
| [00 Start here](plan/00-start-here.md) | What is SAMTEC, what are the ground rules, who does what? |
| [01 Vision and scope](plan/01-vision-and-scope.md) | What do we build, and what do we refuse to build? |
| [02 Stack decisions](plan/02-stack-decisions.md) | Which tools do we use, and why? |
| [03 System architecture](plan/03-system-architecture.md) | How do the parts fit together? |
| [04 Data model](plan/04-data-model.md) | What is stored, and which rules protect it? |
| [05 API contract](plan/05-api-contract.md) | Which endpoints exist, and what are the conventions? |
| [06 Security and review gates](plan/06-security-and-review-gates.md) | How do we review work and keep the system secure? |
| [07 Roadmap](plan/07-roadmap.md) | What gets built in which phase? |
| [08 Ghost detection engine](plan/08-ghost-detection-engine.md) | How does the system catch ghost workers? |
| [09 Payroll engine (Ghana)](plan/09-payroll-engine-ghana.md) | How is pay calculated correctly? |
| [10 Biometric integration](plan/10-biometric-integration.md) | Which fingerprint and face options do we support? |
| [11 Client presentation plan](plan/11-client-presentation-plan.md) | How do we demo and sell it? |

## Reading these files in Obsidian

The files are plain Markdown with normal links, so they read well on GitHub, in VS Code and in Obsidian.

To use Obsidian, choose **Open folder as vault** and select this `docs` folder. Do not open the whole repository as a vault: it contains thousands of files inside `node_modules`, which makes Obsidian very slow.
