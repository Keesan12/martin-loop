# MartinLoop plugin

MartinLoop governs coding-agent work with scope limits, budget caps, verifier gates, retry limits, stop conditions, and evidence records.

## Start

```sh
npx -y martin-loop@latest start
```

Check readiness before a run.

```sh
npx -y martin-loop@latest doctor
npx -y martin-loop@latest preflight "fix the failing test" --verify "npm test"
```

Run one bounded task and verify its record.

```sh
npx -y martin-loop@latest run "fix the failing test" --verify "npm test" --allow-path src --allow-path tests --budget-usd 3 --max-iterations 6
npx -y martin-loop@latest runs verify --latest
npx -y martin-loop@latest dossier --latest
```

MartinLoop is Apache-2.0 open source. See the repository [README](https://github.com/Keesan12/martin-loop#readme) for installation, supported runtimes, and operating constraints.
