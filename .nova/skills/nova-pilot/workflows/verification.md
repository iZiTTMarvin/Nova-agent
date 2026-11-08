# Real verification

Use to establish whether a claim holds. Exercise the real user path, collect genuine artifacts, and report the limits of the evidence.

## 1. Investigate the repository before asking the user

Answer these questions from code and documentation; ask only about what cannot be observed:

- What surface does the user actually use: web UI, desktop application, CLI, HTTP API, or library?
- How does the project start? Check package scripts, Makefiles, and documented quick starts for ports, environment variables, and seed data.
- What programmable controls already exist: E2E tests, Playwright configuration, curl endpoints, debug ports, or CLI arguments?
- Which evidence can be captured: screenshots, terminal output, response bodies, logs, exit codes, or database state?
- Can two instances run in isolation with separate ports, data directories, and profiles?

Reuse the project's existing startup and test paths.

## 2. Establish the smallest real verification path

- Startup from an empty data directory must reach a usable state, including migrations and seed data.
- Readiness means usable behavior, not merely a responding process; initialization may continue after a health check succeeds.
- Drive real user paths instead of internal setters, test-only endpoints, or direct database edits.
- Prefer stable accessible labels, data attributes, routes, and command names over coordinates or tab order.

## 3. Preserve evidence

- Record actions and resulting state, rather than only a final screenshot.
- Check both the visible result and side effects, such as files, inserted records, or sent messages.
- Save artifacts at a known location and preserve them when cleaning up processes.
- Clean up only instances you started; avoid killing processes by name.

## 4. Use formal verification only when warranted

- Ordinary tasks need real execution and proportionate tests.
- Consider model checking, invariant proofs, or generated inputs for high-risk concurrency, retry, protocol, state-machine, parser, or memory-safety boundaries.
- Explain why the chosen tool fits. When no suitable tool exists, exercise the actual code with generated inputs rather than substituting a handwritten model.
- Formal verification covers its model or declared boundary, not the whole system.

## 5. Report honestly

State what was verified, how, coverage, and untested boundaries. Artifacts are not pass verdicts; screenshots and logs alone do not prove success. Mark unverifiable behavior as unverified rather than filling the gap with reassurance.
