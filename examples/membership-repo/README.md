# Membership fixture

A tiny, deliberately broken repository for testing tool routing. Run `node --test test/access.test.mjs`.
The removed-member case fails. `src/access.mjs` owns the access decision; `src/format.mjs` is unrelated.
Use the runner to execute the test and inspect the implementation. The runner returns control for code changes.
