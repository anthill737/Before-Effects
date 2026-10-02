/**
 * Assistant journey: open the assistant, see which subscriptions are ready, then make, refine and
 * undo changes in plain words. The scripted steps drive the real MCP bridge, named pipe and editor
 * tool execution with a stand-in CLI (no AI usage). With BE_UITEST_LIVE_AI=claude,codex the same
 * requests also run against the person's real Claude Code / Codex subscriptions.
 */
import { getRecipe, resolveTargets } from "@be/core";
import { applyRecipeToSelection } from "./studio/actions.ts";
import { sendRequest } from "./studio/assistant/AssistantPanel.tsx";
import { type AssistantTurn, checkProviders, useAssistant } from "./studio/assistant/state.ts";
import { activeVenue, useStudio } from "./studio/store.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, timeout = 5000) => {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
};
const byText = (sel: string, text: string): HTMLElement | null => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text)) ?? null;
const click = (el: Element | null) => {
  if (!el) throw new Error("element not found");
  (el as HTMLElement).click();
};
const st = () => useStudio.getState();
const windows = () => {
  const v = activeVenue({ project: st().project! })!;
  return v.regionOrder.filter((id) => v.regions[id]?.kind === "window");
};
const turn = (id: string | null) => useAssistant.getState().turns.find((t) => t.id === id);
const finished = async (id: string | null, timeout = 30_000): Promise<AssistantTurn | undefined> => {
  await until(() => turn(id)?.status !== "working", timeout);
  return turn(id);
};
const targetIds = (instanceId: string) => resolveTargets(st().project!, st().project!.recipes[instanceId]?.targets ?? []).map((t) => t.region.id);
const undoDepth = () => st().history!.transactions().length;
const live = () => (window as unknown as { beLiveAi?: string }).beLiveAi ?? "";

let effectId = "";

const ask = async (prompt: string, script: Parameters<typeof sendRequest>[1], timeout = 30_000) => {
  const id = await sendRequest(prompt, script);
  return finished(id, timeout);
};

/** A live request against a real subscription: make, refine, retarget. */
const liveJourney = async (provider: "claude" | "codex") => {
  useAssistant.setState({ provider, sessions: {}, turns: [], model: null, usage: null });
  const w = windows();
  st().selectRegions(w.slice(0, 4));
  const before = new Set(Object.keys(st().project!.recipes));
  const t1 = await ask("Make these windows pulse blue with the music", undefined, 300_000);
  const made = Object.keys(st().project!.recipes).find((id) => !before.has(id));
  const inst = made ? st().project!.recipes[made] : undefined;
  const colour = inst?.params.color as number[] | undefined;
  const blue = !!colour && colour[2]! > colour[0]! && colour[2]! > 0.5;
  const onSelected = !!made && targetIds(made).every((id) => w.slice(0, 4).includes(id)) && targetIds(made).length === 4;
  const p1 = { ok: t1?.status === "done" && !!inst && blue && onSelected, made: inst ? `${inst.recipeId} colour ${JSON.stringify(colour?.map((c) => Math.round(c * 100) / 100))} on ${made ? targetIds(made).length : 0} windows` : "nothing", reply: t1?.reply ?? t1?.error ?? "" };
  if (!made) return { ok: false, note: `${provider}: ${p1.reply} ${t1?.detail ?? ""}` };
  const paramsBefore = JSON.stringify(st().project!.recipes[made]!.params);
  const t2 = await ask("Slower", undefined, 300_000);
  const after = st().project!.recipes[made];
  const p2 = { ok: t2?.status === "done" && !!after && JSON.stringify(after.params) !== paramsBefore && Object.keys(st().project!.recipes).length === before.size + 1, changes: t2?.changes.join(" ") ?? t2?.error ?? "" };
  st().selectRegions(w.slice(4, 6));
  const t3 = await ask("Only these windows", undefined, 300_000);
  const p3 = { ok: t3?.status === "done" && JSON.stringify(targetIds(made).sort()) === JSON.stringify(w.slice(4, 6).sort()), changes: t3?.changes.join(" ") ?? t3?.error ?? "" };
  const model = useAssistant.getState().model;
  const usage = useAssistant.getState().usage;
  return {
    ok: p1.ok && p2.ok && p3.ok,
    note: `${provider}${model ? ` (${model})` : ""}: 1) ${p1.ok ? "✓" : "✗"} ${p1.made} — “${p1.reply.slice(0, 120)}” 2) ${p2.ok ? "✓" : "✗"} slower: ${p2.changes.slice(0, 160)} 3) ${p3.ok ? "✓" : "✗"} retarget: ${p3.changes.slice(0, 120)}${usage?.fiveHour !== undefined ? ` · plan usage ${Math.round(usage.fiveHour * 100)}% of 5 h` : ""}`,
  };
};

export const ASSISTANT_STEPS: Record<string, () => Promise<{ ok: boolean; note?: string; settle?: number }>> = {
  "assistant-open": async () => {
    click(byText(".top-actions button", "Assistant"));
    const shown = await until(() => !!document.querySelector(".panel.assistant"));
    await until(() => !!useAssistant.getState().providers, 60_000);
    const providers = useAssistant.getState().providers ?? [];
    const summary = providers.map((p) => `${p.name} via ${p.via}: ${p.ready ? "ready" : "not ready"} (${p.billing}${p.plan ? `, ${p.plan}` : ""}) — ${p.message}`).join(" | ");
    const noKeys = providers.every((p) => p.billing !== "api");
    return { ok: shown && providers.length === 2 && noKeys, note: summary, settle: 300 };
  },
  "assistant-not-set-up": async () => {
    // Without Claude Code or Codex, the panel explains how to set one up; nothing paid is offered.
    await window.be.assistant.testSimulateMissing(true);
    await checkProviders(true);
    await sleep(200);
    const text = document.querySelector(".a-setup")?.textContent ?? "";
    const guidance = /claude\.com\/claude-code/.test(text) && /Sign in with ChatGPT/.test(text) && /No API keys/.test(text);
    const noComposer = !document.querySelector('textarea[aria-label="Ask the assistant"]');
    await window.be.assistant.testSimulateMissing(false);
    await checkProviders(true);
    const back = !!useAssistant.getState().provider;
    return { ok: guidance && noComposer && back, note: `shown: “${text.slice(0, 260)}…”; after installing, “Check again” finds them: ${back}` };
  },
  "assistant-pulse-blue-music": async () => {
    useAssistant.setState({ provider: "test", sessions: {}, turns: [] });
    const w = windows();
    st().selectRegions(w.slice(0, 3));
    const depth = undoDepth();
    const t = await ask("Make these windows pulse blue with the music", [
      { call: "get_show" },
      { call: "list_effects" },
      { call: "apply_effect", args: { effect: "move-with-beat", parts: ["selected"], settings: { color: "#2f6bff" } } },
      { say: "The three selected windows now flash blue on every beat of your music." },
    ]);
    effectId = t?.effectIds[0] ?? "";
    const inst = st().project!.recipes[effectId];
    const blue = (inst?.params.color as number[] | undefined)?.[2] === 1;
    const targets = effectId ? targetIds(effectId) : [];
    const shownInPanel = !!byText(".a-changes li", "Move with the beat");
    return {
      ok: t?.status === "done" && inst?.recipeId === "move-with-beat" && blue && targets.join() === w.slice(0, 3).join() && undoDepth() === depth + 1 && shownInPanel,
      note: `${t?.changes.join(" ")} Reply: “${t?.reply}”. One undo step (${depth}→${undoDepth()}); the new effect is selected for hand editing: ${st().selection.recipeId === effectId}`,
      settle: 500,
    };
  },
  "assistant-slower": async () => {
    const depth = undoDepth();
    const t = await ask("Slower", [{ call: "change_effect", args: { effect_id: effectId, settings: { which: "half" } } }, { say: "Now it flashes on every other beat." }]);
    const inst = st().project!.recipes[effectId];
    return { ok: t?.status === "done" && inst?.params.which === "half" && undoDepth() === depth + 1 && (inst.params.color as number[])[2] === 1, note: `${t?.changes.join(" ")} (colour kept)` };
  },
  "assistant-only-these": async () => {
    const w = windows();
    st().selectRegions(w.slice(3, 5));
    const t = await ask("Only these windows", [{ call: "change_effect", args: { effect_id: effectId, parts: ["selected"] } }, { say: "Only those two windows flash now." }]);
    const targets = targetIds(effectId);
    return { ok: t?.status === "done" && targets.join() === w.slice(3, 5).join() && st().project!.recipes[effectId]?.params.which === "half", note: `${t?.changes.join(" ")}` };
  },
  "assistant-undo-keeps-later-work": async () => {
    // The person keeps working by hand, then undoes only the assistant's last request.
    const w = windows();
    const mine = applyRecipeToSelection("edge-trace", [w[5]!]);
    const handEdit = mine ? st().apply({ type: "recipe.update", args: { instanceId: mine, label: "My own effect" } }) : null;
    const last = useAssistant.getState().turns.at(-1)!;
    click(document.querySelectorAll(".a-turn")[useAssistant.getState().turns.length - 1]!.querySelector(".a-changes-head button[title^='Undo']"));
    await sleep(200);
    const targets = targetIds(effectId);
    const keptHandEdit = Object.values(st().project!.recipes).some((r) => r.label === "My own effect");
    const struck = !!document.querySelector(".a-changes.undone");
    // An earlier request that later requests build on can't be undone on its own; nothing changes.
    const first = useAssistant.getState().turns[0]!;
    const before = st().project;
    const btn = document.querySelectorAll(".a-turn")[0]!.querySelector(".a-changes-head button[title^='Undo']");
    click(btn);
    await sleep(200);
    const refused = st().project === before && !!byText(".toast", "builds on it");
    const checks = { handEdit: !!handEdit, targetsBack: targets.join() === w.slice(0, 3).join(), keptHandEdit, struck, refused };
    return {
      ok: Object.values(checks).every(Boolean) && last.id !== first.id,
      note: Object.values(checks).every(Boolean) ? `undoing “${last.prompt}” put the effect back on the first 3 windows, kept the hand edit made afterwards, and the list shows it undone; undoing “${first.prompt}” alone was refused with an explanation because later requests build on it` : JSON.stringify(checks),
      settle: 400,
    };
  },
  "assistant-plain-errors": async () => {
    const t = await ask("Make the chimney glow", [{ call: "apply_effect", args: { effect: "pulse", parts: ["chimney"] } }]);
    const msg = `${t?.error ?? ""} ${t?.detail ?? ""}`;
    return { ok: t?.status === "failed" && /don't exist: chimney/.test(msg), note: `tool error returned to the assistant in plain words: ${(t?.detail ?? "").slice(0, 140)}` };
  },
  "assistant-stop": async () => {
    const id = await sendRequest("Do something slow", [{ call: "get_show" }, { wait: 20_000 }, { say: "done" }]);
    await until(() => (turn(id)?.steps.length ?? 0) > 0, 10_000);
    click(byText(".a-composer button", "Stop"));
    const t = await finished(id, 10_000);
    const procs = await window.be.app.health();
    return { ok: t?.status === "failed" && t.error === "Stopped." && !procs.children.some((c) => c.startsWith("assistant")), note: `stopped mid-request; background processes now: ${procs.children.join(", ") || "none"}` };
  },
  "assistant-live": async () => {
    if (!live()) return { ok: true, note: "live subscription test not requested (set BE_UITEST_LIVE_AI=claude,codex)" };
    const notes: string[] = [];
    let ok = true;
    for (const p of live().split(",").map((x) => x.trim()) as Array<"claude" | "codex">) {
      if (!useAssistant.getState().providers?.find((x) => x.id === p)?.ready) {
        notes.push(`${p}: not ready on this PC`);
        ok = false;
        continue;
      }
      const r = await liveJourney(p);
      ok &&= r.ok;
      notes.push(r.note ?? "");
    }
    useAssistant.setState({ provider: "test" });
    return { ok, note: notes.join(" || "), settle: 600 };
  },
};

// Keep the recipe registry import alive for the type checker (titles used in notes).
void getRecipe;
