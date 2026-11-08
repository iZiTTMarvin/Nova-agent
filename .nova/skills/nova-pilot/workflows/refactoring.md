# Behavior-preserving refactoring

Change structure while preserving behavior. Feature development adds behavior; bug fixing corrects it.

## 1. Establish the behavior contract

- Read the affected subsystem and identify its actual behavior.
- Before restructuring, capture that behavior with characterization tests, snapshots, equivalence scripts, or baseline output from a real entry point.
- Typechecking and lint are not behavior contracts.
- Establish a minimal behavioral check before changing uncovered paths.

## 2. Name the target structure

- Explain the desired module boundaries, types, and call graph as if designing them today.
- The new structure must remove branches or make illegal states unrepresentable, rather than merely add indirection.
- Preserve established local patterns when the target shape is already clear; avoid rearrangement for style alone.

## 3. Subtract before adding

- Remove dead code, single-caller wrappers, duplicate validation, and orphaned references.
- Keep only changes necessary to reach the target structure; revert speculative cleanup.
- Separate missing features and independent defects from the refactor, and deliver the structural change against its established contract.

## 4. Move in small, verified steps

- Make one kind of structural change at a time and run the behavioral check after each step.
- Migrate every caller when changing an API and remove the old API in the same cutover, without compatibility shims or parallel main paths.
- Check real files, strings, and reverse references when renaming.
- Keep each step independently reversible.

## 5. Prove equivalence in real output

- Run equivalence checks, replay the baseline, or smoke the real entry point; compilation alone is insufficient.
- Compare actual before and after output.
- When verification fails, inspect the observation method before assuming the system is wrong.

## 6. Decide whether the refactor earns its place

Judge success by reduced reader burden: fewer layers, hidden states, mutable scopes, or modules that must be understood together. Revert changes that make nothing easier to understand.

## 7. Report

Describe the structural change, behavioral check, equivalence evidence, effect on reader burden, and any reverted changes. Keep new behavior out of the refactor.
