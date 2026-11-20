import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

/**
 * One rendered view: a physically based renderer (filmic tone mapping, soft shadows, image-based light from a
 * procedural studio environment) and its post-processing — ground-truth ambient occlusion, a restrained bloom on
 * what actually glows, depth of field where a lens would have it — at one of four quality levels. A view that
 * cannot hold its frame rate steps its own quality down and says so.
 */

export type Quality = "low" | "medium" | "high" | "ultra";
export const QUALITIES: Quality[] = ["low", "medium", "high", "ultra"];

export interface GfxOptions {
  quality: Quality;
  /** World size of the ambient-occlusion radius (the scene's units). */
  aoRadius: number;
  bloom: number;
  /** Distance to what the lens is focused on (depth of field at `ultra`, and at `high` when `dofAtHigh`). */
  focus?: () => number;
  dofAtHigh?: boolean;
  aperture?: number;
  exposure?: number;
  environment?: number;
  onQuality?: (q: Quality, why: string) => void;
}

export class Gfx {
  readonly renderer: THREE.WebGLRenderer;
  quality: Quality;
  private composer: EffectComposer | null = null;
  private bokeh: BokehPass | null = null;
  private width = 2;
  private height = 2;
  private slow = 0;
  private frames = 0;
  /** Skip the frame-rate watch (a screenshot in a software renderer is not a slow machine). */
  adaptive = true;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly scene: THREE.Scene,
    readonly camera: THREE.PerspectiveCamera,
    private opts: GfxOptions,
  ) {
    this.quality = opts.quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = opts.exposure ?? 1;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.035).texture;
    scene.environmentIntensity = opts.environment ?? 0.6;
    pmrem.dispose();
    this.build();
  }

  private build(): void {
    const q = this.quality;
    this.composer?.dispose();
    this.composer = null;
    this.bokeh = null;
    this.renderer.shadowMap.enabled = q !== "low";
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q === "low" ? 1 : q === "medium" ? 1.5 : 2));
    this.scene.traverse((o) => {
      const light = o as THREE.DirectionalLight;
      if (light.isDirectionalLight && light.castShadow) {
        const size = q === "ultra" ? 4096 : q === "high" ? 4096 : 2048;
        if (light.shadow.mapSize.x !== size) {
          light.shadow.mapSize.set(size, size);
          light.shadow.map?.dispose();
          light.shadow.map = null;
        }
      }
    });
    // at `low`, glass is plainly transparent: true transmission draws the whole scene a second time
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
      if (!m || Array.isArray(m) || !m.isMeshPhysicalMaterial) return;
      const kept = m.userData.transmission as number | undefined;
      if (q === "low" && m.transmission > 0) {
        m.userData.transmission = m.transmission;
        m.transmission = 0;
        m.transparent = true;
        m.opacity = 0.28;
        m.needsUpdate = true;
      } else if (q !== "low" && kept !== undefined && m.transmission === 0) {
        m.transmission = kept;
        m.opacity = 1;
        m.needsUpdate = true;
      }
    });
    if (q === "low") {
      this.renderer.setSize(this.width, this.height, false);
      return;
    }
    const target = new THREE.WebGLRenderTarget(this.width, this.height, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, target);
    composer.addPass(new RenderPass(this.scene, this.camera));
    if (q === "high" || q === "ultra") {
      const ao = new GTAOPass(this.scene, this.camera, this.width, this.height);
      ao.updateGtaoMaterial({ radius: this.opts.aoRadius, distanceExponent: 1.4, thickness: 1.2, scale: 1.15, samples: q === "ultra" ? 24 : 12, screenSpaceRadius: false });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: q === "ultra" ? 16 : 8 });
      ao.blendIntensity = 0.9;
      composer.addPass(ao);
      if (this.opts.bloom > 0) composer.addPass(new UnrealBloomPass(new THREE.Vector2(this.width, this.height), this.opts.bloom, 0.55, 0.92));
      if (this.opts.focus && (q === "ultra" || this.opts.dofAtHigh)) {
        this.bokeh = new BokehPass(this.scene, this.camera, { focus: this.opts.focus(), aperture: this.opts.aperture ?? 0.0006, maxblur: 0.006 });
        composer.addPass(this.bokeh);
      }
    }
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.resize(this.width, this.height);
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.slow = 0;
    this.frames = 0;
    this.build();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(2, Math.floor(width));
    this.height = Math.max(2, Math.floor(height));
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(this.width, this.height);
    }
  }

  /** Draw a frame. `dt` is the time since the last one (s). */
  render(dt: number): void {
    if (this.bokeh && this.opts.focus) (this.bokeh.uniforms as Record<string, { value: number }>).focus!.value = this.opts.focus();
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    if (!this.adaptive || this.quality === "low") return;
    this.frames++;
    if (this.frames > 30 && dt > 1 / 22) this.slow++;
    else if (this.slow > 0 && dt < 1 / 40) this.slow--;
    if (this.slow > 70) {
      const down = QUALITIES[QUALITIES.indexOf(this.quality) - 1]!;
      this.setQuality(down);
      this.opts.onQuality?.(down, "the frame rate fell below 22 a second");
    }
  }

  /** The frame as a PNG (a still for the record, or a test's screenshot). */
  still(): string {
    return this.canvas.toDataURL("image/png");
  }
}
