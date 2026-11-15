import type { AgentView, floorPlan } from "@acucraft/core";
import { api, type ActAnswer } from "./api.js";
import { h, replace, s } from "./dom.js";

export type FloorPlan = ReturnType<typeof floorPlan>;
export interface FloorPoint { x: number; z: number }

/** One deliberate keyboard step; the engine plans it around furniture and walls. */
export function keyboardDestination(at: FloorPoint, key: string, step = 0.5): FloorPoint | null {
  const delta: Record<string, [number, number]> = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] };
  const move = delta[key.length === 1 ? key.toLowerCase() : key];
  return move ? { x: at.x + move[0] * step, z: at.z + move[1] * step } : null;
}

export interface NavigationControls {
  el: HTMLElement;
  update(view: AgentView, closed: boolean): void;
  move(to: FloorPoint): Promise<void>;
  dispose(): void;
}

/** Actual avatar controls. No optimistic teleport: the event stream supplies the engine's accepted position. */
export function navigationControls(id: string): NavigationControls {
  const el = h("details", { class: "navigation" }, h("summary", null, "Move in the clinic"));
  const help = h("p", { class: "navigation-help" }, "Click the floor plan to walk. Focus the map and use arrow keys or WASD for 0.5 m steps. Shift-click the 3D floor to walk there.");
  const map = s("svg", { class: "navigation-map", tabindex: "0", role: "application", "aria-label": "Clinic floor plan. Click to walk; arrow keys or WASD move the practitioner." });
  const status = h("p", { class: "navigation-status", role: "status", "aria-live": "polite" }, "Loading the clinic floor plan…");
  const room = h("select", { "aria-label": "Destination room" });
  const escort = h("input", { type: "checkbox" });
  const pose = h("select", { "aria-label": "Patient position" });
  for (const value of ["standing", "seated", "seated-forward", "supine", "supine-knee-flexed", "prone", "side-lying-left", "side-lying-right"]) pose.appendChild(h("option", { value }, value.replace(/-/g, " ")));
  const walk = h("button", { type: "button" }, "Walk to room");
  const position = h("button", { type: "button" }, "Position patient");
  const atSide = h("button", { type: "button" }, "Go to patient");
  const controls = h("div", { class: "navigation-controls" }, room, h("label", null, escort, " Escort patient"), walk, atSide, pose, position);
  el.append(help, map, controls, status);
  let plan: FloorPlan | null = null;
  let view: AgentView | null = null;
  let closed = false, busy = false, disposed = false;

  const enable = () => {
    for (const control of [room, escort, pose, walk, position, atSide]) control.disabled = busy || closed;
    map.setAttribute("aria-disabled", String(busy || closed));
  };
  const message = (answer: ActAnswer): string => {
    if (answer.entry?.message) return answer.entry.message;
    const output = answer.output as { message?: unknown; error?: unknown } | null;
    return typeof output?.message === "string" ? output.message : typeof output?.error === "string" ? output.error : answer.ok ? "Done." : "The action was refused.";
  };
  async function act(tool: string, input: Record<string, unknown>): Promise<void> {
    if (disposed || !view || closed || busy) return;
    busy = true;
    enable();
    status.textContent = tool === "move" ? "Planning a walk…" : "Positioning the patient…";
    try {
      const answer = await api.act(id, tool, input);
      if (!disposed) {
        status.textContent = message(answer);
        status.classList.toggle("refused", !answer.ok);
      }
    } catch (error) {
      if (!disposed) {
        status.textContent = error instanceof Error ? error.message : String(error);
        status.classList.add("refused");
      }
    } finally {
      busy = false;
      if (!disposed) enable();
    }
  }
  const move = async (to: FloorPoint) => act("move", { to });

  function draw(): void {
    if (!plan || !view) return;
    const b = plan.bounds;
    map.setAttribute("viewBox", `${b.minX - 0.4} ${b.minZ - 0.4} ${b.maxX - b.minX + 0.8} ${b.maxZ - b.minZ + 0.8}`);
    const labels = plan.rooms.flatMap((r) => [
      s("rect", { class: "navigation-room", x: r.rect.minX, y: r.rect.minZ, width: r.rect.maxX - r.rect.minX, height: r.rect.maxZ - r.rect.minZ }),
      s("text", { class: "navigation-room-label", x: r.rect.minX + 0.2, y: r.rect.minZ + 0.5 }, r.label),
      ...r.doors.map((d) => s("circle", { class: "navigation-door", cx: d.x, cy: d.z, r: 0.22 })),
    ]);
    const fixtures = plan.fixtures.filter((f, i, all) => all.findIndex((g) => g.x === f.x && g.z === f.z) === i).map((f) => s("rect", { class: "navigation-fixture", x: f.x - f.w / 2, y: f.z - f.d / 2, width: f.w, height: f.d }, s("title", null, f.label)));
    const people = view.space.team.map((p) => s("circle", { class: "navigation-team", cx: p.x, cy: p.z, r: 0.2 }, s("title", null, p.id)));
    people.push(s("circle", { class: "navigation-patient", cx: view.space.patient.x, cy: view.space.patient.z, r: 0.24 }, s("title", null, view.patient.name)));
    people.push(s("circle", { class: "navigation-practitioner", cx: view.space.you.x, cy: view.space.you.z, r: 0.26 }, s("title", null, "You")));
    replace(map, ...labels, ...fixtures, ...people);
  }

  map.addEventListener("click", (event) => {
    if (!plan || !view) return;
    const matrix = map.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    map.focus();
    void move({ x: Math.round(point.x * 100) / 100, z: Math.round(point.y * 100) / 100 });
  });
  map.addEventListener("keydown", (event) => {
    if (!view || event.altKey || event.ctrlKey || event.metaKey) return;
    const to = keyboardDestination(view.space.you, event.key);
    if (!to) return;
    event.preventDefault();
    event.stopPropagation();
    // Repeated keydown events cannot flood the authoritative action queue.
    if (!event.repeat) void move(to);
  });
  walk.addEventListener("click", () => void act("move", { to: { room: room.value }, withPatient: escort.checked }));
  atSide.addEventListener("click", () => void act("move", { to: { person: "patient" } }));
  position.addEventListener("click", () => void act("position_patient", { position: pose.value }));
  enable();

  void api.act(id, "lookup", { topic: "floorplan" }).then((answer) => {
    if (disposed) return;
    if (!answer.ok) throw new Error(message(answer));
    plan = answer.output as FloorPlan;
    if (!plan?.rooms || !plan.bounds) throw new Error("The floor plan could not be read.");
    for (const r of plan.rooms) room.appendChild(h("option", { value: r.id }, r.label));
    if (view) room.value = view.space.you.room;
    status.textContent = "Green: practitioner · amber: patient · grey: team. Walks follow the clinic's doors and clear floor.";
    draw();
  }).catch((error) => {
    if (!disposed) status.textContent = error instanceof Error ? error.message : String(error);
  });
  return {
    el,
    update(next, isClosed) {
      view = next;
      closed = isClosed;
      pose.value = next.patient.position;
      if (!room.value) room.value = next.space.you.room;
      enable();
      draw();
    },
    move,
    dispose() { disposed = true; },
  };
}
