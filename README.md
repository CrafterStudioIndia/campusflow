# CampusFlow

**Automated school finance & academic intelligence.** One dashboard for fees,
grades, attendance, AI risk scoring and student progress — a full-stack school
ERP that runs from a single process with no build step.

- **Accountant** — fees, invoices, arrears, receipts, defaulter patterns, cash
  collection analytics, in-app control room for runtime settings.
- **Teacher** — class roster, lesson planning, per-student diagnosis, and a
  click-to-mark **attendance register** (keyboard shortcuts, bulk actions,
  one-click save).
- **Student** — fee status with instalment plans, subjects, progress, attendance
  and examination results.
- **AI layer** — collection risk and student progress scoring with explanations,
  backed by Gemini (primary) or OpenCode Zen (failover), plus an offline
  deterministic fallback so the app still works with no API key.

## Tech

| Layer | Choice |
| --- | --- |
| Frontend | Single-file vanilla JS SPA (`public/index.html`) — no framework, no bundler |
| Backend | Express 5 (ESM, `server.js`) |
| Database | SQLite via `better-sqlite3` (`lib/`) |
| Auth | JWT access + rotating refresh tokens, HttpOnly cookies, CSRF, MFA, audit log |
| Tests | Zero-dependency harnesses (`scripts/`) — syntax check, API, auth, providers |

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

The database is created and **deterministically seeded** on first boot
(~30 school days of students, results and attendance), so a fresh clone works
immediately. Nothing but `node_modules/` is required.

### Demo sign-in

Use the role switcher on the login screen (one-click demo login), or sign in as:

| Role | Email | Password |
| --- | --- | --- |
| Accountant | `accounts@campusflow.edu` | `campus123` |
| Teacher | `teacher@campusflow.edu` | `campus123` |
| Student | `first.last@campusflow.edu` (seeded roster) | `campus123` |

## Scripts

```bash
npm run check      # syntax check every JS/HTML file
npm test           # check + providers + API + auth suites
npm run test:api   # API/endpoint suite only
npm run test:auth  # auth suite only
npm run seed       # wipe and re-seed the demo database
npm run dev        # server with file watching
```

## Configuration

Copy `.env.example` to `.env` and edit — every key is documented there, and the
core ones are also editable from the in-app control room. Environment variables
beat the file, which beats the built-in defaults.

Secrets and runtime state are **git-ignored** (`.env`, `.token-secret`,
`campus.db*`) so nothing sensitive can be pushed. Token secrets auto-generate on
first boot when unset.

## Project layout

```
server.js          Express app, routes, middleware, boot/seed
public/index.html  The whole SPA (styles + app in one file)
public/settings.js In-app control room
lib/db.js          Schema, queries, deterministic seed, attendance/finance domain
lib/auth.js        Sessions, CSRF, MFA, API keys, audit
lib/token.js       JWT issue/verify, refresh rotation
lib/ai.js          Provider routing, model discovery, scoring, fallback
lib/analytics.js   Class diagnosis and finance analytics
lib/notify.js      Notification feed
lib/env.js, log.js Config loading and logging
scripts/           Test harnesses and reseed tool
```

## License

All rights reserved by the project owner. Add a `LICENSE` before publishing if
you intend to open-source it.