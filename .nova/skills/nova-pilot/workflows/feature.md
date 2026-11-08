# Feature development

Use when adding or changing user-visible behavior. Understand the system, choose the right data shape, implement the smallest complete change, and verify through its real entry point.

## 1. Understand the affected subsystem

- Read the call chain, public types, state owners, and adjacent implementations the change will cross.
- Locate the actual user entry point: page, command, IPC request, or tool.
- Read relevant tests for existing boundaries and likely regressions.

## 2. Define the data shape first

- Identify the core data, its single owner, and its state transitions before writing logic.
- Prefer types, state machines, tables, or registries to scattered booleans and conditionals.
- Use one typed contract across modules. Accept external input as `unknown` and validate it at the boundary.
- Return to read-only investigation if the data shape is unclear.

## 3. Define scope and boundaries

- State what changes, what does not, and which invariants must hold.
- Consider empty values, cancellation, concurrency, duplicate events, recovery, and cleanup.
- Before changing permissions, session ownership, persistence formats, or public APIs, establish authorization, migration, and rollback.

## 4. Implement the smallest complete change

- Put changes at the earliest correct boundary and with the responsible owner, rather than patching several downstream callers.
- Remove obsolete paths as part of the cutover; keep a single main path.
- Keep unrelated responsibilities out of existing facades and stores. Avoid vague `utils` or `helpers` directories.
- Add tests only when they protect a real risk.

## 5. Verify through real usage

- Launch the actual application, drive the real interaction, or run a real command through the target behavior.
- An incorrect entry point, internal setter, or test-only interface does not prove the user path.
- Unit tests establish branch behavior, not the complete user-visible result.
- Observe the actual rendered UI when relevant. If images cannot be inspected, mark visual verification as unperformed.

## 6. Report

Explain what changed, why, the effect on existing behavior, verification, and unverified boundaries. Include a brief tradeoff when the design required a choice.
