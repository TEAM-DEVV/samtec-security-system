# Contributing to SAMTEC

## The short version

1. Read [How the system works](docs/guides/01-how-the-system-works.md), then set up your computer with the [setup guide](docs/guides/02-setup-on-windows.md).
2. Create a branch from `main` named `feat/…`, `fix/…`, `contract/…`, `docs/…` or `chore/…`.
3. Any API change starts in `packages/contracts/openapi.yaml`. See [Changing the API contract](docs/guides/05-api-contract-workflow.md).
4. Write commit messages as Conventional Commits, for example `feat(web): add employee detail page`.
5. Run `pnpm check` before you push.
6. Open a pull request and complete the four-lens checklist in the template. If you use Claude Code, run `/lens-review` first.
7. Wait for green CI and your teammate's approval, then use **Squash and merge**.

Full details: [Git and pull requests](docs/guides/06-git-and-pull-requests.md). Security rules: [SECURITY.md](SECURITY.md).

## Definition of done

A change is done when all of these are true:

- [ ] It matches the API contract and belongs to the current roadmap phase.
- [ ] Tests cover it. Money logic is tested to the pesewa.
- [ ] New screens have loading, empty and error states.
- [ ] The documents in `docs/` still describe what the code does.
- [ ] `pnpm check` passes and CI is green.
- [ ] The four-lens checklist is complete, and every blocker is fixed.
