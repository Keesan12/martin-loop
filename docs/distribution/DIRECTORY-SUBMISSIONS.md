# Directory Submission Pack

Use this file as the single source of truth for public directory submissions.

## Short tagline

Open-source control plane for AI coding agents.

## Long description

MartinLoop is an open-source governed runtime for AI coding agents. It wraps autonomous coding loops with budget caps, verifier gates, rollback evidence, JSONL run records, failure classification, and MCP/Claude/Codex integration so agent work can be inspected, halted, and trusted.

## Primary links

- GitHub repo: [github.com/Keesan12/martin-loop](https://github.com/Keesan12/martin-loop)
- Website: [martinloop.com](https://martinloop.com)
- npm package: [npmjs.com/package/martin-loop](https://www.npmjs.com/package/martin-loop)
- Benchmark challenge: [UNDER-3-CHALLENGE.md](./UNDER-3-CHALLENGE.md)

## Submission checklist

### OpenAlternative

- status: blocked
- surface: OSS alternative listing
- copy to use: short tagline + long description
- include: GitHub, website, npm
- submit URL checked: `https://openalternative.co/submit`
- blocker: redirects to sign-in flow, so the agent cannot complete a trusted submission without an authenticated external session

### DevHunt

- status: blocked
- surface: product hunt style dev tools directory
- copy to use: short tagline + long description
- include: benchmark challenge and demo command
- launch URL checked: `https://devhunt.org/launch`
- blocker: unauthenticated direct launch route does not expose a usable public submit flow from this environment

### Uneed

- status: blocked
- surface: startup/tool discovery
- copy to use: short tagline + long description
- include: GitHub, website, npm
- submit URL checked: `https://www.uneed.best/submit`
- blocker: submit path resolves behind site protection and does not expose a clean agent-submittable form in this environment

### BetaList

- status: pending
- surface: early product discovery
- copy to use: short tagline + long description
- include: why governed agent runs matter

### Microlaunch

- status: blocked
- surface: lightweight launch directory
- copy to use: short tagline + long description
- include: demo command and benchmark challenge
- submit URL checked: `https://microlaunch.net/submit`
- blocker: direct submit URL returns a not-found page from this environment, so the actual submission flow still needs discovery or login

### AlternativeTo

- status: pending
- surface: alternative comparison listing
- copy to use: short tagline + long description
- include: comparable tools and differentiators

### Futurepedia

- status: needs review
- surface: AI tools directory
- copy to use: short tagline + long description
- include: Claude, Codex, and MCP integration
- submit URL checked: `https://www.futurepedia.io/submit-tool`
- note: page is reachable, but I have not completed a trusted end-to-end submission yet

### Toolify

- status: pending
- surface: AI tool directory
- copy to use: short tagline + long description
- include: benchmark challenge link

### There’s An AI For That

- status: blocked
- surface: AI tool catalog
- copy to use: short tagline + long description
- include: GitHub, website, npm
- submit URL checked: `https://theresanaiforthat.com/submit/`
- blocker: Cloudflare challenge blocks trusted automated submission from this environment

## Notes

- Prefer submissions that link directly to the repo, website, and npm package together.
- Reuse the benchmark challenge and `martin-loop demo` as the fastest trust-building assets.
- If a directory wants screenshots, use the current public repo README visuals instead of inventing a separate pitch deck.
- Current repo-side prep is complete: launch copy, links, challenge page, and outreach templates are ready; the remaining blockers are external auth, protected forms, or site-specific submission flows.
