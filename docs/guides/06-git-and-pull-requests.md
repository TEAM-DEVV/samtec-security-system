# Git and pull requests

Git keeps the history of every change, and GitHub lets two people work on the same code without overwriting each other. This guide covers everything this project needs.

## The rules

1. **Never commit directly to `main`.** `main` must always work. All changes arrive through pull requests.
2. **One branch per task.** Small branches are easier to review and merge.
3. **Pull requests need a green CI and the other developer's approval.** Contract changes need both approvals.
4. **Never commit secrets or real personal data.** `.env` files are ignored by git for this reason. See [SECURITY.md](../../SECURITY.md).

## Branch names

| Prefix | Use it for | Example |
|---|---|---|
| `feat/` | A new feature | `feat/employee-detail-page` |
| `fix/` | A bug fix | `fix/cedis-rounding` |
| `contract/` | A change to `openapi.yaml` | `contract/next-of-kin-phone` |
| `docs/` | Documentation only | `docs/setup-troubleshooting` |
| `chore/` | Tooling, dependencies, configuration | `chore/upgrade-vite` |

## Commit messages: Conventional Commits

Write each commit message as `type(scope): what changed`, in the present tense.

| Type | When | Example |
|---|---|---|
| `feat` | New behaviour | `feat(web): add search to the employee list` |
| `fix` | A bug fix | `fix(api): return 404 for an unknown site` |
| `docs` | Documentation | `docs: explain the local database` |
| `test` | Tests only | `test(api): cover a night shift across midnight` |
| `refactor` | Code changes with no behaviour change | `refactor(web): extract the status badge` |
| `chore` | Tooling and dependencies | `chore: update Biome to 2.5` |
| `ci` | The CI pipeline | `ci: cache pnpm downloads` |

Common scopes: `web`, `api`, `contracts`, `db`, `docs`.

## Your daily workflow

Start from an up-to-date `main`:

```bash
git switch main
git pull
```

Create a branch for your task:

```bash
git switch -c feat/employee-detail-page
```

Work, then check everything before you commit:

```bash
pnpm check
```

Save your work in a commit:

```bash
git add .
git commit -m "feat(web): add employee detail page"
```

Send the branch to GitHub:

```bash
git push -u origin feat/employee-detail-page
```

Then open a pull request, either on GitHub (it shows a "Compare & pull request" button) or with the GitHub CLI:

```bash
gh pr create --fill
```

## Opening a good pull request

- Fill in the template: what changed, and how to test it.
- Add screenshots for any screen change.
- Go through the **four-lens checklist**. If you use Claude Code, run `/lens-review` first ([Using Claude Code](07-using-claude-code.md)).
- Wait for CI to turn green. If it fails, click the failed check to read the log, fix the problem, commit and push again.

## Reviewing the other person's pull request

1. Read the description, then the **Files changed** tab.
2. Pull the branch and try it if it changes behaviour:

   ```bash
   git fetch
   git switch feat/employee-detail-page
   pnpm install
   pnpm dev:web
   ```

3. Leave comments on specific lines. Be specific and kind: say what and why.
4. Choose **Approve** or **Request changes**.

## Keeping your branch up to date

When `main` has moved on while you worked, bring its changes into your branch:

```bash
git switch main
git pull
git switch feat/employee-detail-page
git merge main
```

If git reports a **conflict**, both of you changed the same lines. Open the files it lists, keep the right version between the `<<<<<<<` and `>>>>>>>` markers, delete the markers, then:

```bash
git add .
git commit
```

Ask for help early if a conflict is confusing. Never delete the other person's work to make a conflict go away.

## Merging

Use **Squash and merge** on GitHub. It turns the pull request into one clean commit on `main`. Then delete the branch (GitHub offers a button).

## Protecting the main branch (repository owner, once)

The repository organization (TEAM-DEVV — both developers are owners) should switch on protection so the rules above are enforced by GitHub:

1. Open the repository on GitHub, then **Settings → Rules → Rulesets → New ruleset → New branch ruleset**.
2. Name it `protect main`, set **Enforcement status** to **Active**, and target the default branch.
3. Tick **Restrict deletions** and **Block force pushes**.
4. Tick **Require a pull request before merging**, with **1** required approval, and tick **Require review from Code Owners**. `.github/CODEOWNERS` lists both developers, so every change needs the other person's approval.
5. Tick **Require status checks to pass**, and add the CI checks after the first CI run.
6. Save.
7. Open **Settings → Advanced Security** (called **Code security** on some accounts) and turn on **Private vulnerability reporting** and **Dependabot alerts**. `SECURITY.md` sends people to the private report form.

## When something goes wrong

| Problem | What to do |
|---|---|
| I committed to `main` by mistake (not pushed yet) | `git switch -c feat/my-work` keeps your commit on a new branch. Then ask your teammate before resetting `main`. |
| I committed a secret or real personal data | Tell your teammate immediately. Change the leaked password or key first; removing it from git history comes second. |
| CI fails only on GitHub | Run `pnpm check` locally. Read the failed step's log on GitHub. |
| `git push` is rejected | Someone pushed to your branch. Run `git pull`, fix any conflict, and push again. |

Related: [Using Claude Code](07-using-claude-code.md) · [Security and review gates](../plan/06-security-and-review-gates.md)
