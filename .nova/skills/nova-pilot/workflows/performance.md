# Performance work

Tie every optimization to a measurement. Source inspection does not replace measurement, and perceived speed is not a measured improvement.

## 1. Establish a baseline

- Measure through the matching real command, page, or workload.
- Save raw profiles, logs, timings, or request records so later measurements can be compared.
- Confirm that the baseline measures the intended work, the environment is stable, and cache effects are understood.
- Establish the baseline before changing code.

## 2. Investigate in cost order

Understand the affected subsystem, then consider these approaches from cheapest to most involved:

1. Stop work whose result is unused.
2. Avoid repeated work through caching, deduplication, or fewer requests.
3. Reduce data volume, scope, or frequency.
4. Defer work until it is needed.
5. Run independent work concurrently.
6. Use cheaper algorithms, data structures, or fewer allocations.

Stop when an earlier approach meets the target.

## 3. Change one hypothesis at a time

- Associate each change with a specific hypothesis, measure immediately, then retain or revert it.
- Use the same metric definition, environment, and artifact format before and after.
- Mark uncertain results as uncertain rather than reporting an improvement.

## 4. Explain the measurements

- Identify the bottleneck: CPU, I/O, network, rendering, lock contention, or data volume.
- State sample size, warm or cold cache, concurrency, and machine environment.
- Distinguish measurements, inference, and guesses. Keep unmeasured behavior out of the conclusions.

## 5. Report

Give baseline and final measurements, their difference, artifact paths, covered scenarios, and untested boundaries. If the target was not met, say so and identify viable next steps.
