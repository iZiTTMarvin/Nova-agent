# General development method

Use when no more specific method fits: changes across several modules, tasks whose shape is unclear, or work that still needs a practical approach.

## 1. Define observable completion

- State completion as an observable, falsifiable outcome, such as a pilot option appearing in settings and subsequent messages receiving the pilot instruction after switching modes.
- Define scope and non-goals. Replace vague requests to improve or polish something with a checkable result.
- If completion is unclear, investigate read-only before writing code.

## 2. Understand the actual structure

- Read real callers, callees, public types, state owners, dependency directions, and adjacent implementations.
- Identify who writes each mutable state, where cross-module contracts are defined, and which dependency boundaries the change crosses.
- Read relevant tests for existing behavior and boundaries before editing.

## 3. Break work into verifiable steps

- Track steps with `todo_write`; end each step with an observable check.
- Resolve the highest-risk unknown first. Establish a minimal verification path before implementing the feature.
- Give each step one main objective and verify it before moving on.

## 4. Make the smallest complete change

- Remove dead code, disposable wrappers, and duplicate validation before adding structure.
- Keep each decision in one place.
- Avoid parallel main paths, duplicate state, and compatibility branches without a removal condition.
- Express the domain through types, state machines, tables, or registries rather than scattered booleans and conditionals.

## 5. Reassess systemic resistance

Reconsider the design when the same workaround appears in several unrelated places, multiple boundaries need special cases, types require `any` or assertions to compile, callers must know internal rules, or the same design deviation has been repeated twice.

Re-read the affected code, treat the newly discovered constraint as part of the original problem, and choose a smaller design rather than adding another patch.

## 6. Verify through the real entry point and report

- Use real startup, interaction, or commands to prove the behavior. Compilation and typechecking are insufficient on their own.
- Report the result, changes, reasoning, impact, verification, and unverified boundaries.
- List unverified work separately from completed work.
