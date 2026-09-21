# Set up your computer (Windows)

This guide takes a fresh Windows laptop to a running SAMTEC project. Follow the steps in order. Every command goes in a terminal; this guide assumes **Git Bash**, which comes with Git for Windows.

## What you will install

| Tool | Why you need it |
|---|---|
| Git for Windows | Downloads the code and tracks changes. Also gives you the Git Bash terminal. |
| Node.js 24 (LTS) | Runs the API and all the project tools |
| pnpm 12 | Installs the project's dependencies and runs its scripts |
| Visual Studio Code | The code editor, with the project's recommended extensions |
| GitHub CLI (optional) | Opens pull requests from the terminal |

You do **not** need Docker or a separate PostgreSQL installation. The project starts its own local database.

## 1. Install Git

1. Download Git for Windows from https://git-scm.com/download/win and run the installer. The default options are fine.
2. Open **Git Bash** from the Start menu and check it works:

   ```bash
   git --version
   ```

3. Tell Git who you are. Use the email address of your GitHub account:

   ```bash
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```

## 2. Install Node.js 24

1. Download the **LTS** installer for version 24 from https://nodejs.org and run it with the default options.
2. Close and reopen Git Bash, then check:

   ```bash
   node --version
   ```

   It should print `v24` followed by more numbers.

## 3. Install pnpm

```bash
npm install --global pnpm@12.4.1
pnpm --version
```

It should print `12.4.1`.

## 4. Install Visual Studio Code

1. Download it from https://code.visualstudio.com and install it.
2. Recommended: in VS Code, open the Command Palette (Ctrl+Shift+P), type **Terminal: Select Default Profile** and choose **Git Bash**. The built-in terminal then behaves exactly like this guide.

## 5. Get the code

Choose a folder for your projects, then:

```bash
git clone https://github.com/TEAM-DEVV/samtec-security-system.git
cd samtec-security-system
code .
```

When VS Code asks **"Do you want to install the recommended extensions?"**, choose **Install**.

## 6. Install the project's dependencies

In the VS Code terminal, at the repository root:

```bash
pnpm install
```

The first install downloads a few hundred megabytes and takes a few minutes. It ends with a line like `Generated Prisma Client`.

**If pnpm refuses to install something** and mentions a trust downgrade, a minimum release age or ignored build scripts, that is the project's supply-chain protection working. Do not switch it off. Tell your teammate and read [SECURITY.md](../../SECURITY.md).

## 7. Run the dashboard with mock data (enough to start frontend work)

```bash
pnpm dev:web
```

Open http://localhost:5173. You should see the SAMTEC dashboard with a **Mock data** badge in the top bar. The mock API lives inside the browser, so no backend or database is needed.

Stop it with **Ctrl+C** in the terminal.

## 8. Run the full system (API, database and dashboard)

You need **two terminals**. In VS Code, the **+** button in the terminal panel opens another one.

**Terminal 1: start the database.** Leave this terminal open while you work:

```bash
pnpm db:start
```

The first start takes a minute while it prepares the database files. Wait for `PostgreSQL is running on port 54329`.

**Terminal 2, first time only: configure and fill the database.**

```bash
cp apps/api/.env.example apps/api/.env
pnpm db:migrate
pnpm db:seed
```

- The first command creates the API's settings file. The example values already match the local database.
- `db:migrate` creates the tables.
- `db:seed` loads a fictional company with 5 sites and 50 employees.

**Terminal 2: start the API and the dashboard together.**

```bash
pnpm dev
```

Open http://localhost:5173. The top bar says **Live API**; open **System status** in the sidebar (or http://localhost:5173/status) and it shows **API: Reachable** and **Database: Connected**. That is the Phase 0 exit demo.

You can also open the API directly: http://localhost:3000/api/v1/health.

## 9. Run every check before a pull request

```bash
pnpm check
```

This runs the same checks as CI: lint, contract, types, tests and build.

## Everyday commands

Run these from the repository root.

| I want to… | Command |
|---|---|
| Work on the dashboard with mock data | `pnpm dev:web` |
| Run the API and dashboard together | `pnpm dev` (with `pnpm db:start` in another terminal) |
| Run only the API | `pnpm dev:api` |
| Run all tests | `pnpm test` |
| Fix formatting automatically | `pnpm lint:fix` |
| Check everything like CI | `pnpm check` |
| Apply new database migrations after pulling | `pnpm db:migrate` |
| Wipe and refill my local database | `pnpm db:reset` (it asks you to confirm) |
| Browse the database in a web page | `pnpm db:studio` |

## Optional: use Supabase instead of the local database

Useful when both developers want to share one database, and later for the hosted demo.

1. Create a free project at https://supabase.com.
2. In the project settings, open **Data API** and switch it **off**. SAMTEC reaches the database only through its own API, and the Data API would be a second way in.
3. Open **Connect**, copy the PostgreSQL connection string, and replace the password placeholder with your database password.
4. Paste it into `apps/api/.env` as `DATABASE_URL`.
5. Create the tables with `pnpm db:deploy`. Never run `pnpm db:migrate` or `pnpm db:reset` against a shared database: they are for your own computer and can delete data.
6. To load the demo data, run `ALLOW_REMOTE_SEED=yes pnpm db:seed`. The seed refuses any database that is not on your computer unless you say so like this.

Never commit `.env`, and never paste the connection string into chats, issues or pull requests.

## Troubleshooting

| Problem | Fix |
|---|---|
| `pnpm: command not found` | Close and reopen the terminal. If it persists, run `npm install --global pnpm@12.4.1` again. |
| PowerShell says "running scripts is disabled on this system" | Use Git Bash as described in step 4. |
| `Port 5173 is already in use` | Another dashboard is running. Close that terminal or press Ctrl+C in it. |
| `pnpm db:start` fails on port 54329 | The database is already running in another terminal. |
| `Can't reach database server` | Start the database with `pnpm db:start` in another terminal. |
| `Invalid environment configuration` | `apps/api/.env` is missing or wrong. Copy it again from `apps/api/.env.example`. |
| The dashboard says it cannot reach the API | Start the API with `pnpm dev` or `pnpm dev:api`. If it is running, check that `CORS_ORIGINS` in `apps/api/.env` is `http://localhost:5173`. Or use mock data with `pnpm dev:web`. |
| The page says **The mock API could not start** | Open http://localhost:5173 in Chrome, Edge or Firefox, not in a private window or a preview browser built into another app. |
| `pnpm db:migrate` says a migration was modified or is missing | Your local database was built from an older version of the migrations. Run `pnpm db:reset` and confirm. |
| Installs are very slow | Antivirus scanning slows down `node_modules`. It is only slow the first time. |

Next: [Frontend guide](03-frontend-guide.md) or [Backend guide](04-backend-guide.md).
