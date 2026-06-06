# TFT Time Dashboard

A Vercel-ready Next.js + TypeScript starter for a TFT stats dashboard focused on time tracking.

## Getting started

1. Install Node.js and npm.
2. Run `npm install`
3. Copy `.env.example` to `.env.local` and fill in the server-only keys.
4. Run `npm run dev`
5. Open http://localhost:3010

## Free persistent cache for Vercel

This app is wired for a persistent Redis-style cache so repeated TFT lookups do not keep rebuilding from scratch.

Recommended free setup:
1. Open Vercel → Project → Settings → Environment Variables
2. Add `RIOT_API_KEY` (server-only)
3. Add the Redis values from your Vercel/Upstash integration:
   - `KV_URL`
   - `KV_REST_API_TOKEN`
   - or the direct Upstash fallback values:
     - `UPSTASH_REDIS_REST_URL`
     - `UPSTASH_REDIS_REST_TOKEN`
4. Deploy the project.

If those variables are missing, the app will fall back to an in-memory cache for local development only.

## Planned next steps
- Verify repeated match lookups use the persistent cache in production.
- Add a small UI indicator for cache source and freshness.
