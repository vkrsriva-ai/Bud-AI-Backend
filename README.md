# BuD AI — Backend

One endpoint: `POST /analyze`. Send a receipt photo, get categorized JSON back.

## What's here
- `server.js` — the whole backend
- `package.json` — dependencies
- `.env.example` — template for your API key

## Run locally (optional, to test before deploying)
1. Copy `.env.example` to `.env` and paste your real key from console.anthropic.com.
2. In this folder:
   ```bash
   npm install
   npm start
   ```
3. Server runs at http://localhost:3000

## Deploy to Railway
1. Push this folder to a GitHub repo.
2. railway.app -> New Project -> Deploy from GitHub repo -> pick this repo.
3. In Railway -> your service -> Variables, add:
   - `ANTHROPIC_API_KEY` = your real key
4. Railway gives you a public URL like `https://budai-backend-production.up.railway.app`.
   (Settings -> Networking -> Generate Domain if it didn't auto-create one.)

## The test that proves everything works (Postman)
- Method: `POST`
- URL: `https://YOUR-RAILWAY-URL/analyze`
- Body tab -> select `form-data`
  - Key: `receipt` (change the key type dropdown from "Text" to "File")
  - Value: choose your Costco or Walmart receipt photo
- Hit Send.

You should get back JSON with `merchant`, `total`, an `items` array (each with name/price/category),
and `category_totals`. When you see that, the core product works — everything else is UI.

## Notes
- Model is `claude-sonnet-4-6`. Cost is roughly a fraction of a cent per scan.
- Key is read from the environment only. Never commit `.env`.
- If you get `Model did not return valid JSON`, the response includes the raw text so you can see what came back.
