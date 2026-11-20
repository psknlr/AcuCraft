import type { MeshStandardMaterial } from "three";
import { figureMaterial } from "@clinicalcraft/web/world/figure/material.js";

/**
 * Skin seen close, for the 3D view: the figure kit's one material (`figure/material.ts`: vertex colour, and a
 * per-vertex finish whose glow marks skin) given, on skin only, a fine grain — pores and the faint unevenness of
 * living skin, as a bump from noise in the body's own space (the figures have no texture coordinates) — and the
 * soft warm edge light that comes back out of skin where it turns away from the eye. Cloth, hair and shoes are as
 * the kit draws them. This is the stage's own copy of the kit: the 3D world is not changed.
 */
let done = false;

/**
 * The share of the kit's skin glow the stage keeps. The kit gives skin a little of its own colour back everywhere,
 * which keeps a small figure in a wide room rosy — and, seen close, flattens every form it has. Here most of that
 * light is given back only where the surface itself is in shade (`subsurfaceShade`), as light that entered the skin
 * elsewhere does: lit skin keeps its modelling, and skin in shade stays warm instead of going grey.
 */
export const SKIN_GLOW_KEPT = 0.3;

/**
 * GLSL for after `<lights_fragment_end>`: the warm light that comes back out of skin where it is not lit directly.
 * `mask` is a float expression that is 1 on skin.
 */
export function subsurfaceShade(mask: string, strength = 0.24): string {
  return `
{
  float skinLuma = max(1e-4, dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)));
  float skinLit = dot(reflectedLight.directDiffuse, vec3(0.2126, 0.7152, 0.0722)) / skinLuma;
  reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(1.0, 0.44, 0.32) * (${mask}) * ${strength.toFixed(3)} * (1.0 - smoothstep(0.03, 0.8, skinLit));
}`;
}

export function refineSkin(): void {
  if (done) return;
  done = true;
  const m: MeshStandardMaterial = figureMaterial();
  const before = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSkinPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSkinPos = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vSkinPos;
float skinHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float skinNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(skinHash(i), skinHash(i + vec3(1,0,0)), f.x), mix(skinHash(i + vec3(0,1,0)), skinHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(skinHash(i + vec3(0,0,1)), skinHash(i + vec3(1,0,1)), f.x), mix(skinHash(i + vec3(0,1,1)), skinHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
vec3 skinBump(vec3 surfPos, vec3 n, float h, float faceDirection) {
  vec3 dx = dFdx(surfPos), dy = dFdy(surfPos);
  vec3 r1 = cross(dy, n), r2 = cross(n, dx);
  float det = dot(dx, r1) * faceDirection;
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - grad);
}`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
// (no branch: derivatives are only defined outside per-pixel control flow)
float skinMask = smoothstep(0.02, 0.12, vFinish.y);
// pores (a millimetre or two) over a gentle unevenness of a few centimetres — each only where a pixel is small
// enough to show it (far off it fades out instead of sparkling)
float skinPx = length(fwidth(vSkinPos));
float pores = 1.0 - smoothstep(0.25, 0.7, skinPx * 620.0);
float fine = 1.0 - smoothstep(0.25, 0.7, skinPx * 1500.0);
float broad = 1.0 - smoothstep(0.3, 0.9, skinPx * 42.0);
float skinH = skinNoise(vSkinPos * 620.0) * 0.5 * pores + skinNoise(vSkinPos * 1500.0) * 0.22 * fine + skinNoise(vSkinPos * 42.0) * 0.45 * broad;
vec3 skinBumped = skinBump(-vViewPosition, normal, skinH * 0.00045, faceDirection);
normal = normalize(mix(normal, skinBumped, skinMask * max(pores, broad)));`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
{
  float skinGlowMask = smoothstep(0.02, 0.12, vFinish.y);
  // most of the kit's even glow is taken back here, and returned below only to skin that is in shade
  totalEmissiveRadiance -= diffuseColor.rgb * vec3(1.0, 0.66, 0.5) * vFinish.y * ${(1 - SKIN_GLOW_KEPT).toFixed(3)} * skinGlowMask;
  float edge = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.55, 0.42) * edge * 0.16 * skinGlowMask;
}`,
      )
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>${subsurfaceShade("smoothstep(0.02, 0.12, vFinish.y)")}`);
  };
  m.customProgramCacheKey = () => "cc-figure-skin-2";
  m.needsUpdate = true;
}
