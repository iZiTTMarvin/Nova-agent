# Prototype for a decision

A prototype is a disposable tool for deciding a design or behavior question. It stays outside production code and does not replace formal verification of the eventual implementation.

## 1. Define the question

- Choose a concrete question about layout, interaction, density, behavior, timing, or feasibility.
- Proceed with feature development when there is no unresolved decision to explore.
- Define which observation would favor each option before building the prototype.

## 2. Gather references when needed

- When the design space is open, compare similar products, existing implementations, or visual references and offer a few directions for the user to choose from.
- Skip research when the direction is already decided.

## 3. Build the lightest isolated artifact

- Use a separate draft directory, outside production source and framework integration.
- Use lightweight HTML/CSS/JS or an existing template for visual questions, and a minimal script for behavior or timing questions.
- Avoid tests, abstractions, and production-quality scaffolding. Rigor here means reaching the right decision at low cost.

## 4. Compare a few viable alternatives

- Present two or three structurally distinct variants behind a shared switcher, with clear labels.
- Every variant must answer the same question.

## 5. Decide from observation

- For visual variants, capture each one and operate the key interactions.
- For behavior or timing, inspect actual output, measurements, or rendered results.
- These observations verify the prototype's decision; additional assertions are unnecessary.

## 6. Deliver the decision

Report the variants, screenshots or actual output, tradeoffs, recommendation, and draft path. State that the prototype is disposable. Continue the chosen direction through feature development, defining the structure first if needed.
