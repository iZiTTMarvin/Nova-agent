# Read-only investigation

Deliver an evidence-backed answer or recommendation. Investigation does not authorize code changes.

## 1. Define the deliverable

- Determine whether the user needs an explanation of behavior or design, or a recommendation among options.
- For explanations, cover the overview, key concepts, execution mechanism, code locations, and likely pitfalls.
- For decisions, compare viable options, explain tradeoffs, and make a reasoned recommendation. Listing options alone is insufficient.

## 2. Trace facts without modifying the system

- Follow real entry points through routes, handlers, services, stores, and persistence until the target behavior is explained.
- Locate evidence with `read`, `grep`, `find`, `ls`, or `code_context`. Read public contracts before crossing into another module's implementation.
- Distinguish source facts, design intent, and inference; label inference explicitly.
- Cite file and line locations when possible, rather than filenames alone.

## 3. Keep the authorized scope

- Preserve application code and state; avoid incidental refactors or a second state path.
- Report discovered defects and their impact so the user can decide whether to authorize a fix.
- Hand the decision back to the user before continuing into implementation, then use the feature-development or bug-fixing method.

## 4. Give a judgment

- Answer feasibility questions directly, including objections and their reasons.
- State when the premise is incorrect instead of forcing a compliant but unsound proposal.
- Explain what the evidence covers and which conclusions remain unverified inferences.
