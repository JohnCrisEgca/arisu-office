# Getting a live link

Arisu Office is a normal Node 22 web server with a SQLite file. It needs: HTTPS, a disk that survives restarts, and your secrets as environment variables. Nothing here has been deployed for you; these files are ready, but untested on a real host.

## Option A: Render (simplest)

**One click:** https://render.com/deploy?repo=https://github.com/JohnCrisEgca/arisu-office

1. Sign in at render.com (create an account if you do not have one). The link above reads `render.yaml` and shows you what it will create.
2. Approve it. (Manual route: New > Blueprint > pick `JohnCrisEgca/arisu-office`.)
3. When asked, paste **your own** `OPENAI_API_KEY` and set `OPENAI_MODEL` (see step 6).
4. Deploy. Render gives you an `https://...onrender.com` link. That is your app's link.
5. In the service's Environment tab, copy the generated `SETUP_TOKEN`. Open the link, create the owner account and paste the token.
6. Team & AI > **Run system check**. It must show PASS for OpenAI key, model, and test request. If the model fails, the check lists what your key can use; set `OPENAI_MODEL` to one of those and redeploy.
7. Clients > add a client > connect the Facebook Page. Run the system check again; the Page must show PASS.
8. Only then set `FB_PUBLISH_ENABLED=true` and redeploy.

Notes: Render's persistent disk needs a paid plan. Without a disk, the database is wiped on every deploy, so do not use a free instance for real clients.

## Option B: any server with Docker

```bash
docker build -t arisu-office .
docker run -d --name arisu --restart unless-stopped -p 127.0.0.1:3000:3000 \
  -v arisu-data:/data \
  -e OPENAI_API_KEY=... -e OPENAI_MODEL=... -e SETUP_TOKEN=$(openssl rand -hex 16) -e APP_SECRET=$(openssl rand -hex 32) \
  arisu-office
```

Put HTTPS in front (Caddy example): `arisu.yourdomain.com { reverse_proxy 127.0.0.1:3000 }`.

## Check your real keys without deploying

On your own computer, with Node 22.5+:

```bash
cp .env.example .env     # fill in OPENAI_API_KEY and OPENAI_MODEL
npm run doctor
```

It prints PASS or FAIL for your OpenAI key, the model, a tiny test request, and every connected Facebook Page token. It never prints a key.

## Back up

Back up the `/data` folder (it holds `arisu.db`). Keep `APP_SECRET` somewhere safe: without it, saved Facebook tokens cannot be decrypted and must be entered again.
