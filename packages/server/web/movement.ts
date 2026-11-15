import { api, type EncounterSnapshot } from "./api.js";
import { h, replace } from "./dom.js";

/** Floor coordinates are authoritative; every click is a checked move request, never a visual teleport. */
export function movementPanel(id: string) {
  let snapshot: EncounterSnapshot | null = null;
  let busy = false;
  const actor = h("select", { "aria-label": "Character to move" });
  const room = h("select", { "aria-label": "Destination room" });
  const status = h("p", { role: "status" }, "Choose a character, then click the floor plan or use the step buttons.");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "clinic-map");
  svg.setAttribute("aria-label", "Clinic floor plan; use the room and step buttons for keyboard movement");
  const draw = (tag: string, attrs: Record<string, string | number>, label?: string) => {
    const node = document.createElementNS(svg.namespaceURI, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (label) node.textContent = label;
    svg.appendChild(node);
  };
  async function move(to: Record<string, unknown>) {
    if (!snapshot || busy || snapshot.summary.status !== "open") return;
    busy = true;
    try {
      const result = await api.act(id, "move", { to }, actor.value);
      status.textContent = result.entry?.message || (result.ok ? "Moved." : JSON.stringify(result.output));
    } catch (e) { status.textContent = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  function step(dx: number, dz: number) {
    const s = snapshot?.view.space;
    if (!s) return;
    const p = actor.value === s.patient.id ? s.patient : actor.value === snapshot!.view.you.id ? s.you : s.team.find(t => t.id === actor.value);
    if (p) void move({ x: p.x + dx, z: p.z + dz });
  }
  svg.addEventListener("click", e => {
    const point = svg.createSVGPoint();
    point.x = e.clientX; point.y = e.clientY;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const p = point.matrixTransform(matrix.inverse());
    void move({ x: Math.round(p.x * 100) / 100, z: Math.round(p.y * 100) / 100 });
  });
  const button = (label: string, dx: number, dz: number) => h("button", { type: "button", on: { click: () => step(dx, dz) } }, label);
  const go = h("button", { type: "button", on: { click: () => void move({ room: room.value }) } }, "Walk to room");
  const controls = h("div", { class: "row wrap" }, actor, room, go, button("North 0.5 m", 0, -0.5), button("West 0.5 m", -0.5, 0), button("South 0.5 m", 0, 0.5), button("East 0.5 m", 0.5, 0));
  const el = h("section", { class: "movement", "aria-label": "Character movement" }, h("h3", null, "Clinic movement"), controls, svg, status);
  return { el, update(next: EncounterSnapshot) {
    snapshot = next;
    const { view } = next;
    const selected = actor.value || view.you.id;
    replace(actor, [{ id: view.you.id, name: view.you.name }, ...view.team.filter(c => c.id !== view.you.id), { id: view.space.patient.id, name: view.patient.name }].map(c => h("option", { value: c.id }, c.name)));
    actor.value = selected;
    const dest = room.value;
    replace(room, view.space.rooms.map(r => h("option", { value: r.id }, r.label)));
    if (dest) room.value = dest;
    for (const control of Array.from(controls.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select"))) control.disabled = next.summary.status !== "open";
    const rooms = view.space.rooms;
    const minX = Math.min(...rooms.map(r => r.minX)) - 0.5, minZ = Math.min(...rooms.map(r => r.minZ)) - 0.5;
    svg.setAttribute("viewBox", `${minX} ${minZ} ${Math.max(...rooms.map(r => r.maxX)) - minX + 0.5} ${Math.max(...rooms.map(r => r.maxZ)) - minZ + 0.5}`);
    svg.replaceChildren();
    for (const r of rooms) {
      draw("rect", { x: r.minX, y: r.minZ, width: r.maxX-r.minX, height: r.maxZ-r.minZ, class: "map-room" });
      draw("text", { x: r.minX + 0.2, y: r.minZ + 0.45, class: "map-label" }, r.label);
    }
    for (const f of view.space.fixtures) draw("circle", { cx: f.x, cy: f.z, r: 0.16, class: "map-fixture" });
    const latest = view.space.walks.at(-1);
    if (latest) draw("polyline", { points: [latest.from, ...latest.path, latest.to].map(p => `${p.x},${p.z}`).join(" "), class: "map-path" });
    for (const p of [{ ...view.space.you, id: view.you.id }, ...view.space.team, view.space.patient]) {
      draw("circle", { cx: p.x, cy: p.z, r: 0.22, class: p.id === view.space.patient.id ? "map-patient" : "map-person" });
      draw("text", { x: p.x + 0.28, y: p.z, class: "map-label" }, p.id);
    }
  } };
}
