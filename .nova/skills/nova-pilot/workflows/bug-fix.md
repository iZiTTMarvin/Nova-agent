# Bug fixing

Trace every fix to runtime evidence. A defensive change that might help is a hypothesis, not a verified fix.

## 1. Reproduce first

- Reproduce through the matching real application, command, or request.
- Record the trigger, actual output, and expected output.
- If direct reproduction fails, narrow the conditions, construct a triggering path, or add targeted instrumentation until the failure is repeatable.
- Ask the user for reproduction information only when the available real controls cannot reach the target, and explain the missing access.

## 2. Eliminate causes with evidence

- Read the affected subsystem and regression history, form candidate hypotheses, and test them individually.
- Choose observations that eliminate the most uncertainty. Use execution evidence rather than source-code speculation.
- Inspect unclear state with temporary logs or breakpoints, then remove the instrumentation.
- Find the earliest violated invariant in the causal chain.

## 3. Fix the root cause

- Fix the earliest violation instead of adding protection to several downstream locations.
- Determine whether the state is valid. Handle valid state with its responsible owner; trace invalid state back to its producer.
- Change only what the evidence supports. Revert changes based on disproved hypotheses.
- Address other instances of the same cause within scope; report independent issues without silently expanding the task.

## 4. Verify at the same entry point

- The original reproduction path must pass after the fix.
- A different entry point, changed environment, or uncertain result is not a pass.
- Unit tests establish branch behavior, not disappearance of the defect. Add a failing regression first when a cheap local seam can reproduce the failure.
- Check that cancellation, failure, retries, and cleanup still work.

## 5. Report

State the original failure, root cause, fix, and verification. Include failing-before and passing-after output when available. List unfixed behavior and untested environments separately.
