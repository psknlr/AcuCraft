import { api, type EncounterSnapshot, type Info, type StageInfo } from "./api.js";
import { h, replace } from "./dom.js";

/**
 * The 3D view's place on the record page: a card that loads the view (`/app/stage.js`, bundled by the server
 * with the 3D world's figure kit) when a record opens, feeds it every change, and says plainly when there is no
 * view to show (no WebGL in this browser, or the server lacks the engine checkout). The card stays when the
 * record redraws: the view keeps its camera and its animations.
 */

interface StageHandle {
  update(state: { view: EncounterSnapshot["view"]; timeline: EncounterSnapshot["timeline"]; agent: string | null; closed: boolean }): void;
  highlight(needle: string | null): void;
  dispose(): void;
}
interface StageModule {
  mountStage(host: HTMLElement, info: StageInfo, options?: { onPick?: (needle: string | null) => void; quality?: string }): Promise<StageHandle>;
}

let loading: Promise<StageModule> | null = null;
/** The view's bundle, fetched once (a module the type checker does not see: it is built by the server). */
function stageModule(): Promise<StageModule> {
  const url = "/app/stage.js";
  loading ??= import(/* the server's bundle */ url) as Promise<StageModule>;
  return loading;
}

function webgl(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

export interface StageCard {
  el: HTMLElement;
  update(snapshot: EncounterSnapshot): void;
  highlight(needle: string | null): void;
  dispose(): void;
}

export function stageCard(id: string, info: Info, onPick: (needle: string | null) => void): StageCard {
  const host = h("div", { class: "stage", tabindex: "-1" });
  const el = h("section", { class: "card stage-card", "aria-label": "3D view of the encounter" }, host);
  let handle: StageHandle | null = null;
  let pending: EncounterSnapshot | null = null;
  let gone = false;
  const say = (text: string) => replace(host, h("div", { class: "stage-off" }, h("p", null, text)));
  const feed = (snap: EncounterSnapshot) => handle?.update({ view: snap.view, timeline: snap.timeline, agent: snap.agent?.state ?? null, closed: snap.summary.status !== "open" });
  if (!info.stage.available) say(`No 3D view on this server: ${info.stage.missing ?? "it is not installed"}. The record below is complete without it.`);
  else if (!webgl()) say("This browser cannot draw the 3D view (WebGL is off or unavailable). The record below is complete without it.");
  else
    void (async () => {
      try {
        const [mod, stage] = await Promise.all([stageModule(), api.stage(id)]);
        if (gone) return;
        // `?quality=high|medium|low` fixes the rendering quality (by default it follows the frame rate)
        const quality = new URLSearchParams(location.search).get("quality");
        handle = await mod.mountStage(host, stage, { onPick, ...(quality && ["high", "medium", "low"].includes(quality) ? { quality } : {}) });
        if (gone) return handle.dispose();
        if (pending) feed(pending);
      } catch (e) {
        say(`The 3D view could not start: ${e instanceof Error ? e.message : String(e)}. The record below is complete without it.`);
      }
    })();
  return {
    el,
    update(snapshot) {
      pending = snapshot;
      feed(snapshot);
    },
    highlight(needle) {
      handle?.highlight(needle);
    },
    dispose() {
      gone = true;
      handle?.dispose();
      handle = null;
    },
  };
}
