# Arisu Office

An AI office that prepares Facebook content for small businesses. AI "employees" write post ideas, drafts, quality reviews, and draft comment replies. **A person approves every post before anything can be published.**

No dependencies. It uses only what ships with Node 22.5+ (built-in SQLite, scrypt, `fetch`), so there is no `npm install`.

## Run it

```bash
cp .env.example .env      # then fill in OPENAI_API_KEY and OPENAI_MODEL
npm start                 # http://127.0.0.1:3000
npm test                  # 46 tests, uses fake OpenAI/Facebook servers
npm run doctor            # checks your REAL OpenAI key, model and Facebook tokens
```

1. Open the app. The first screen creates the **owner** account (do this immediately after deploying).
2. Read and accept the AI Use and Approval Agreement (`AGREEMENT.md`).
3. **Clients** tab: add a business (voice, language, "never say" list), optionally connect its Facebook Page.
4. **Team & AI** tab: create manager and client accounts (they must change the temporary password at first login). Use "Check which AI models my key can use" to confirm `OPENAI_MODEL`.
5. **Posts** tab: write drafts, review, approve, publish (or copy and post by hand, then "Mark as posted").

## What is real and what is not

All 18 agents are connected. Every output is text for a person to read, approve, or send. Nothing acts alone.

| Agent | Job | Where |
|---|---|---|
| Arisu | Daily briefing, coordinates | Office |
| Pilar | Post ideas | Posts |
| Lia | Post drafts | Posts |
| Nela | Reviews each draft | Posts |
| Rey | Drafts comment replies (never sent by the system) | Posts |
| Ysa | Publishes approved text to Facebook | Posts |
| Ina | Monthly content plan | Studio |
| Ren | Visual brief for a post (cannot make images) | Studio |
| Bong | Reel plan (cannot edit video) | Studio |
| Dario | Analyses text you paste in (no web browsing) | Studio |
| Maya | Follow-up message draft | Studio |
| Kiko | Reads recent Page post counts, says what to try | Studio |
| Mina | Proposes a brand profile; a person applies it | Studio |
| Gio | Tidies notes; pinned notes become AI background | Studio |
| Sol | Keyword search over notes, drafts, agent output | Studio |
| Teo | Invoicing; drafts reminder wording only | Invoices |
| Paco | Watches stale drafts, failed posts, overdue invoices (no AI) | Office |
| Ben | Tests your real OpenAI key, model, Facebook tokens | Team & AI |

Not built: online payment collection. Invoices are tracked manually (see below).

**Tested against fake OpenAI and Facebook servers only.** Run **Team & AI > Run system check** (or `npm run doctor`) with your real keys before relying on it. Kiko's Facebook read (`/posts` with counts) and the Graph version you use are the parts most likely to need adjusting against the live API.

## Invoices

- Prices are typed by a person. The server adds them up in exact centavos. The AI never touches an amount.
- Flow: draft > sent (locked; fix mistakes by voiding) > client may report a payment with a reference > a team member confirms > paid. Only a person on the team can mark paid.
- Clients see only invoices that were sent to them. Overdue is shown automatically (Asia/Manila date; set `TIMEZONE` to change).
- Teo drafts reminder wording from database facts (number, amount, due date). A person sends it.
- GCash: set your GCash name and number once in Team & AI > Invoice details (the format is checked). Every invoice then shows a "Pay via GCash" block. The client pays in GCash, presses "I have paid this" with the GCash reference number, and you confirm it in your GCash app before pressing "Confirm payment received".
- Print / Save as PDF from the invoice page.
- These are billing statements, not BIR official receipts. Ask your accountant what you need.
- To collect money online later you would add a provider (for example PayMongo, Xendit, Stripe) with your own merchant account. That is not included.

## The approval rules (enforced by the server, covered by tests)

- The AI only creates **drafts**. Nothing is visible on Facebook until a person publishes.
- A post can be published only if a person **approved the exact text**. The approval stores a hash of the text. Editing the text cancels the approval, and a changed text is refused even if the database is edited directly.
- Automatic checks **block approval** until a person edits: empty or over-long text, a phrase on the client's "never say" list, an unfilled `[PLACEHOLDER]`.
- If the AI reviewer says *revise* or *block*, approving needs an explicit confirmation.
- Clients can be set so **only their own account can approve** their posts.
- **Replies are never sent by the system.** A person copies the approved reply and posts it.
- Scheduled posts use Facebook's own scheduler (10 minutes to 30 days ahead).
- Every AI action and every human approval is written to the activity log.
- Comments pasted for reply drafts go to the model as quoted data with an instruction not to follow them (prompt-injection defence). Even if a model were fooled, the worst outcome is a bad draft, because nothing is sent automatically.

## Roles

| | Owner | Manager | Client |
|---|---|---|---|
| Create accounts, disable accounts, check AI models | yes | | |
| Add/edit clients, connect Facebook Pages | yes | yes | |
| Read the activity log | yes | yes | |
| Generate, edit, approve, publish drafts | all clients | all clients | **own business only** |

A client user cannot see that other clients exist (their ids return "not found").

## Security notes

- Passwords: scrypt, 10+ characters, forced change on first login, other sessions are logged out on change.
- Sessions: random 256-bit token, only its hash is stored, `HttpOnly` + `SameSite=Strict` cookie (`Secure` in production), 7 day expiry, disabling a user ends their sessions immediately.
- Login: generic error message, constant-time-ish checks, 5 failed attempts per email+IP per 15 minutes.
- CSRF: same-origin check plus a required `X-Requested-With` header plus SameSite cookies.
- Browser: strict Content-Security-Policy (no inline scripts/styles), all text rendered with `textContent`, so AI output cannot run as code.
- Secrets: `OPENAI_API_KEY` is read from the environment and never sent to the browser or logged. Facebook tokens are encrypted at rest (AES-256-GCM) and never returned by any endpoint or written to the log.
- OpenAI requests set `store: false`.
- Cost guard: `AI_DAILY_LIMIT` per person per day.
- Run it behind HTTPS (Caddy, nginx, Cloudflare Tunnel, etc.) with `NODE_ENV=production` and `HOST=0.0.0.0`. Set `SETUP_TOKEN` before exposing it.
- SQLite is a single file in `DATA_DIR`. Back it up. For many clients, move to a hosted database.

## Facebook setup (check Meta's current rules)

1. Create an app at developers.facebook.com.
2. Get a **Page access token** for the Page with permission to publish posts (`pages_manage_posts`, plus `pages_read_engagement`).
3. In Clients, paste the Page ID, name, and token.
4. Set `FB_PUBLISH_ENABLED=true` and restart.

While your Meta app is in development mode it works only for Pages where you hold a role. Managing **other businesses' Pages** generally requires Meta's App Review / advanced access (and possibly business verification). Check Meta's current documentation. Until then, use the manual mode: approve, copy the text, post it yourself, press "Mark as posted".

## Before you charge real clients

- Have a lawyer review `AGREEMENT.md` and your client contract. In the Philippines, also consider your obligations under the Data Privacy Act of 2012 (RA 10173) if you handle customers' personal data. This repo is software, not legal advice.
- Tell clients plainly that AI drafts the content and that they (or you) approve it.
- Do not paste private personal data into topics or comments.
- Start with one or two friendly clients and read every draft yourself.

## Layout

```
server/   config, db (SQLite), auth, permissions, ai (OpenAI), facebook (Graph API), app + extras (routes), doctor (system check)
public/   index.html, style.css, app.js (no build step)
test/     app.test.js, extras.test.js, harness.js
docs/     DEPLOY.md (how to get a live link)
Dockerfile, render.yaml
AGREEMENT.md   the text users must accept
```
