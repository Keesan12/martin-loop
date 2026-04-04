# Martin Loop Deployment Guide

## The short version

You have two deployable things in this repo:

1. `apps/local-dashboard`
   This is the fastest, easiest deployment. It is a static HTML dashboard and can be deployed with almost no setup.

2. `apps/control-plane`
   This is the bigger SaaS dashboard. It is a Next.js app and should be deployed after you run the repo once in a normal Node shell.

## Best first deployment

If your goal is to see something live quickly, deploy `apps/local-dashboard` first.

Why:

- no install is needed to view it locally
- it is a static site
- it is the easiest thing to deploy on both Vercel and Netlify

## Vercel notes

Official docs that informed this prep:

- Vercel build configuration and root directory:
  [https://vercel.com/docs/builds/configure-a-build](https://vercel.com/docs/builds/configure-a-build)

Important takeaway:

- Vercel lets you set a Root Directory for a project
- if you pick a subdirectory as the root, the app cannot access files outside that directory

That matters because `apps/control-plane` imports shared workspace packages from `packages/*`.

### Recommended Vercel order

1. Deploy `apps/local-dashboard` first as a static site.
2. For `apps/control-plane`, run the repo locally first with:

```powershell
pnpm install
pnpm test
pnpm --filter @martin/control-plane build
```

3. Then create a Vercel project with the repo and configure it carefully around the monorepo layout.

## Netlify notes

Official docs that informed this prep:

- Netlify monorepo setup:
  [https://docs.netlify.com/build/configure-builds/monorepos/](https://docs.netlify.com/build/configure-builds/monorepos/)
- Next.js on Netlify:
  [https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/)

Important takeaway:

- Netlify can keep the Base directory at repo root
- Netlify can use a Package directory when the site files live in a subdirectory

That is useful for this repo because the dashboards live under `apps/`.

## Deploying the local dashboard

### Vercel

1. Create a new project.
2. Keep the project as a static HTML/CSS/JS site.
3. Set the root or publish directory to `apps/local-dashboard`.
4. No build step is needed.

### Netlify

1. Create a new site.
2. Set the publish directory to `apps/local-dashboard`.
3. Leave the build command empty.
4. No build step is needed for the static operator console.

## Deploying the hosted control plane

### Before deploying

Run these locally first:

```powershell
pnpm install
pnpm test
pnpm --filter @martin/control-plane build
```

### Practical first hosted deployment

- Use Vercel first for the hosted Next.js app
- keep the repo layout intact
- verify the shared workspace imports resolve correctly

### Recommended Vercel settings for the hosted app

- Framework preset: Next.js
- Root directory: repository root
- Install command: `pnpm install`
- Build command: `pnpm --filter @martin/control-plane build`
- Output directory: leave default for Next.js
- Environment variables:
  - `MARTIN_CONTROL_PLANE_ADMIN_API_KEY`
  - `MARTIN_CONTROL_PLANE_WORKSPACE_API_KEY`
- Production rule: these env vars are required; the hosted API now fails closed with `503 auth_not_configured` if they are missing.
- Do not rely on demo keys outside local review flows.

### Recommended Netlify settings for the hosted app

- Base directory: repository root
- Build command: `pnpm --filter @martin/control-plane build`
- Publish directory: `.next`
- Confirm monorepo handling before production use
- Environment variables:
  - `MARTIN_CONTROL_PLANE_ADMIN_API_KEY`
  - `MARTIN_CONTROL_PLANE_WORKSPACE_API_KEY`
- Production rule: these env vars are required; the hosted API now fails closed with `503 auth_not_configured` if they are missing.
- Do not rely on demo keys outside local review flows.

## Honest status

I prepared the repo, docs, and local dashboard for deployment planning, but I could not run a real hosted deployment from this Codex shell because this environment cannot launch `node.exe`, `git.exe`, or other native executables.
