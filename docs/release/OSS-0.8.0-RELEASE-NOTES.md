# MartinLoop 0.8.0 — Swarm Mode Demo

MartinLoop 0.8.0 introduces a deterministic 15-agent Swarm Mode demo that runs without provider calls or spend.

The launch-board scenario demonstrates bounded concurrency, parent-controlled integration, reassignment and recovery, denied-change isolation, inspectable evidence, and one parent/global verification result. Run it with:

```sh
npx -y martin-loop@0.8.0 demo --swarm
```

Provider-backed live Swarm execution is intentionally not part of the default 0.8.0 CLI. This release does not claim live 15-agent provider qualification or provider hard-token enforcement.
