# LaunchBoard swarm demo

This small, dependency-free fixture is used by `martin-loop demo --swarm`.
MartinLoop's deterministic local workers prepare bounded proposals, the parent
admits them, and the parent verifier runs `node --test` against the integrated
copy.
