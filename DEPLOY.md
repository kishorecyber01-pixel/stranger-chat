# StrangerChat — Deployment Guide

## What's Inside

```
stranger-chat/
├── server.js          ← Node.js backend (Socket.io real-time matching)
├── package.json       ← Dependencies
├── public/
│   └── index.html     ← Full frontend (HTML/CSS/JS)
```

---

## Option 1: Deploy to Railway (Easiest — FREE tier available)

1. Go to https://railway.app and sign up (free)
2. Click **"New Project" → "Deploy from GitHub"**
3. Push this folder to a GitHub repo first:
   ```bash
   git init
   git add .
   git commit -m "initial"
   gh repo create stranger-chat --public --push
   ```
4. Railway auto-detects Node.js and runs `npm start`
5. Click **"Generate Domain"** → your site is live worldwide!

---

## Option 2: Deploy to Render (FREE tier)

1. Go to https://render.com and sign up
2. New → **Web Service** → connect your GitHub repo
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. Choose **Free** tier → Deploy
5. You get a `https://your-app.onrender.com` URL

---

## Option 3: Deploy to Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# In your project folder:
fly launch
fly deploy
```

---

## Option 4: VPS (DigitalOcean / AWS / etc.)

```bash
# On your server:
git clone <your-repo>
cd stranger-chat
npm install
npm install -g pm2

# Start with PM2 (keeps running after logout)
pm2 start server.js --name stranger-chat
pm2 save
pm2 startup
```

Then point your domain's DNS A record to your server IP.

---

## Running Locally (for testing)

```bash
cd stranger-chat
npm install
node server.js
# Open http://localhost:3000
# Open another tab to test chatting with yourself!
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Server port |

Set `PORT` automatically handled by Railway/Render.

---

## Custom Domain

1. Buy a domain (Namecheap, GoDaddy, Cloudflare)
2. In your host (Railway/Render), add the custom domain
3. Update your domain's DNS CNAME to point to your host

---

## Features Included

- ✅ Random stranger matching worldwide
- ✅ Real-time messaging (Socket.io WebSockets)
- ✅ Typing indicators
- ✅ Live online user count
- ✅ "Next" to skip to new stranger
- ✅ "Stop" to end session
- ✅ Mobile responsive
- ✅ Auto-reconnect on disconnect

---

## Want to Add More Features?

- **Video chat** → add WebRTC (peer-to-peer video)
- **Interest matching** → let users enter tags (like Omegle interests)
- **Geo matching** → match by country using IP geolocation
- **Report/ban system** → for moderation
- **Captcha** → reduce bots

Ask Claude for help with any of these!
