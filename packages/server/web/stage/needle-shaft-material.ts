import { MeshStandardMaterial, Vector4 } from "three";

/** Integrate the projected steel width across a pixel when the physical tube falls below raster resolution. */
export function exteriorShaftMaterial(steel: MeshStandardMaterial): MeshStandardMaterial {
  const material = steel.clone();
  material.transparent = true;
  material.depthWrite = false;
  const viewport = { value: new Vector4() };
  material.onBeforeRender = renderer => { renderer.getCurrentViewport(viewport.value); };
  material.onBeforeCompile = shader => {
    shader.uniforms.shaftViewport = viewport;
    const varyings = `varying float shaftOffsetPx;
      varying float shaftRadiusPx;
      varying float shaftFilterPx;`;
    shader.vertexShader = `attribute vec3 shaftAxisRadius;
      uniform vec4 shaftViewport;
      ${varyings}\n${shader.vertexShader}`.replace("#include <project_vertex>", `
      #include <project_vertex>
      float radiusM = length(shaftAxisRadius);
      vec4 centre = projectionMatrix * modelViewMatrix * vec4(position - normal * radiusM, 1.0);
      vec4 along = centre + projectionMatrix * modelViewMatrix * vec4(shaftAxisRadius, 0.0);
      vec2 pixelScale = 0.5 * shaftViewport.zw;
      vec2 segment = (along.xy / along.w - centre.xy / centre.w) * pixelScale;
      vec2 across = vec2(-segment.y, segment.x) / max(length(segment), 1e-8);
      shaftRadiusPx = radiusM * projectionMatrix[1][1] * pixelScale.y / max(centre.w, 1e-6);
      // Pixel footprint perpendicular to a line, including a diagonal line through the pixel.
      shaftFilterPx = 0.5 * (abs(across.x) + abs(across.y)) * (1.0 - smoothstep(0.75, 1.5, shaftRadiusPx));
      float offsetPx = dot((gl_Position.xy / gl_Position.w - centre.xy / centre.w) * pixelScale, across);
      // A circumscribed octagon covers the full filter support even between two radial vertices.
      float extra = shaftFilterPx * 1.09 / max(shaftRadiusPx, 1e-6);
      shaftOffsetPx = offsetPx * (1.0 + extra);
      gl_Position.xy += gl_Position.w * across * (offsetPx * extra) / pixelScale;
    `);
    shader.fragmentShader = `${varyings}\n${shader.fragmentShader}`.replace("#include <roughnessmap_fragment>", `
      #include <roughnessmap_fragment>
      float unresolved = 1.0 - smoothstep(0.5, 1.5, shaftRadiusPx);
      roughnessFactor = mix(roughnessFactor, 0.58, unresolved);
    `).replace("#include <opaque_fragment>", `
      if (shaftFilterPx > 1e-5) {
        float covered = min(shaftOffsetPx + shaftFilterPx, shaftRadiusPx) - max(shaftOffsetPx - shaftFilterPx, -shaftRadiusPx);
        diffuseColor.a *= clamp(covered / (2.0 * shaftFilterPx), 0.0, 1.0);
      }
      #include <opaque_fragment>
    `);
  };
  return material;
}
