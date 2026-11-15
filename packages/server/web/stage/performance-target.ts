import { manipulationTechnique, type AgentView, type PerformTechniqueAction } from "@acucraft/core";
import type { ChartSite } from "./types.js";

/** Public-view target validation for local preview. Execute still passes the complete encounter engine. */
export function previewSite(view: AgentView, request: PerformTechniqueAction): ChartSite {
  if (request.at && ![request.at.u, request.at.v].every(Number.isFinite)) throw new Error("坐标必须为有限数值 · Coordinates must be finite.");
  const definition = manipulationTechnique(request.technique);
  if (!definition) throw new Error("未知手法 · Unknown technique.");
  let site: ChartSite;
  if (definition.context !== "skin" || request.needleId) {
    const needle = view.needling.find((n) => n.needle === request.needleId);
    if (!needle?.placement) throw new Error("请选择本次就诊中位置明确的针具 · Choose a needle with a recorded site in this visit.");
    if (definition.context === "retained" && !needle.inPlace) throw new Error("该手法需要留置针 · This technique needs a retained needle.");
    if (definition.context === "removed" && (needle.inPlace || !needle.withdrawn)) throw new Error("请先完成出针 · Withdraw the needle before this aftercare preview.");
    site = needle.placement;
    if (request.mark) {
      const mark = view.localisation.marks.find((m) => m.id === request.mark && !m.stale);
      if (!mark || mark.region !== site.region || mark.side !== site.side || Math.hypot(mark.u - site.u, mark.v - site.v) > 1e-6) throw new Error("标记与针具位置不一致 · Mark and needle sites differ.");
    }
  } else if (request.mark) {
    const mark = view.localisation.marks.find((m) => m.id === request.mark);
    if (!mark || mark.stale) throw new Error("请选择当前位置下的有效标记 · Choose a current, non-stale mark.");
    site = mark;
  } else {
    if (!request.region || !request.side || !request.at) throw new Error("请填写区域、侧别和坐标 · Choose a complete chart site.");
    site = { region: request.region, side: request.side, ...request.at };
  }
  if ((request.region && request.region !== site.region) || (request.side && request.side !== site.side) || (request.at && Math.hypot(request.at.u - site.u, request.at.v - site.v) > 1e-6)) throw new Error("输入位置相互冲突 · The supplied targets conflict.");
  if (![site.u, site.v].every(Number.isFinite)) throw new Error("坐标必须为有限数值 · Coordinates must be finite.");
  if (!view.patient.reachable.some((r) => r.region === site.region && r.sides.includes(site.side))) throw new Error("当前体位未开放该部位 · This region is not accessible in the current position.");
  if (view.space.you.room !== view.space.patient.room || !view.space.patient.sites.inReach.includes(`${site.region}:${site.side}`)) throw new Error("请先移动至该部位附近 · Move within reach of this body site first.");
  return { region: site.region, side: site.side, u: site.u, v: site.v };
}
