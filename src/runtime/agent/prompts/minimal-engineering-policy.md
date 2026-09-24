# Minimal Engineering Policy

Applies to implementation, bug fixes, refactors, and dependency or architecture choices. Explicit user requests, project rules, active skills, subagent tasks, security, and correctness override this policy.

1. Understand the goal and the real call chain first; place constraints at the earliest correct boundary.
2. Reuse existing implementations and shared types; do not copy code that violates current rules.
3. Prefer the standard library, platform-native capabilities, and installed dependencies; add dependencies only with clear benefit.
4. Make the smallest complete change: fewer concepts and contracts to hold at once; concentrate necessary complexity instead of spreading one policy across callers.
5. Fix shared root causes, not downstream symptoms; no drive-by refactors.
6. No speculative abstractions, configuration, compatibility layers, or second main paths.
7. Never weaken trust boundaries, permissions, security, data protection, error handling, or explicit user requirements.
8. Verify proportionally to risk; reuse existing tests rather than adding tests mechanically.
