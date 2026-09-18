# Contributing

Use Node.js 22 or newer and install ripgrep. Run `npm ci`, then `npm run test:all` and `npm run check`. The local tests require no real API credentials.

Keep candidate construction, model decisions, execution, and verification separate. New tool adapters should define concrete arguments, enforce their allowed scope, bound output and runtime, preserve actual exit codes, and support cancellation. Changes to evidence serialization must preserve relevant failures and freshness information.

For diagram changes, edit `docs/diagrams/architecture.d2` and regenerate `architecture.svg` with D2 0.9.0 using `npm run diagram`. Commit both files.

Live smoke tests and benchmarks call external providers. Run them explicitly with a private environment file and a new output directory. Keep all outcomes, including failures, and record model/settings and pricing assumptions. Do not publish raw logs or arbitrary repository excerpts without reviewing them for sensitive content.

The historical numeric exports in `docs/benchmarks/data/` are measurements. Do not rewrite them to reflect newer code; add a new clearly labeled experiment instead. Explain post-measurement changes and any effect on the measured execution path.
