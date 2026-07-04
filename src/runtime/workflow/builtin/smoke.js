export const meta = {
  name: "smoke",
  description: "Minimal workflow smoke test — 2-3 agent calls",
  whenToUse: "Internal test only",
  phases: [
    { title: "one" },
    { title: "two" },
  ],
};

phase("one");
log("smoke start", args);

const a1 = await agent("smoke step 1: say hello", { label: "step1" });
const a2 = await agent("smoke step 2: say world", { label: "step2" });

phase("two");
log("agents done", { a1: a1, a2: a2 });

const a3 = await agent("smoke step 3: summarize", { label: "step3" });

await write(".nova/compose/smoke-marker.txt", "ok");
const marker = await read(".nova/compose/smoke-marker.txt");

return { ok: true, a1: a1, a2: a2, a3: a3, marker: marker };
