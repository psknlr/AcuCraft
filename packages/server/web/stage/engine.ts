import {
  Clock,
  Color,
  DirectionalLight,
  HalfFloatType,
  HemisphereLight,
  NeutralToneMapping,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  RectAreaLight,
  Scene,
  SpotLight,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type Texture,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { Quality } from "./types.js";

/**
 * The renderer: physically based materials lit by an image of a room (reflections on the steel), a low sun
 * through the window with soft shadows, the ceiling panel as an area light, ground-truth ambient occlusion where
 * things meet, a touch of bloom on what glows, a vignette. Quality follows how fast frames are drawn: it steps
 * down by itself when they are slow (or is set), so a laptop without a graphics card still moves smoothly.
 */

/** The last look: a gentle grade (cool shadows, warm highlights, a little contrast) and a vignette. */
const GRADE = {
  uniforms: { tDiffuse: { value: null as Texture | null }, strength: { value: 0.24 }, contrast: { value: 1.06 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float strength; uniform float contrast; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      // a little less saturated than the raw render, as film is (skin stays skin, not orange)
      c.rgb = mix(vec3(l), c.rgb, 0.9);
      c.rgb = mix(c.rgb, c.rgb * vec3(0.965, 1.0, 1.045), smoothstep(0.55, 0.05, l) * 0.6);
      c.rgb = mix(c.rgb, c.rgb * vec3(1.03, 1.0, 0.965), smoothstep(0.45, 0.95, l) * 0.5);
      c.rgb = clamp((c.rgb - 0.5) * contrast + 0.5, 0.0, 1.0);
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - strength * smoothstep(0.16, 0.62, dot(d, d) * 1.6);
      gl_FragColor = c;
    }`,
};

export interface Lights {
  sun: DirectionalLight;
  panel: RectAreaLight;
  rim: SpotLight;
  sky: HemisphereLight;
  detail: DirectionalLight;
}

export interface DetailFocus { point: Vector3; normal: Vector3 }

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(38, 16 / 9, 0.02, 60);
  readonly lights: Lights;
  private composer!: EffectComposer;
  private gtao: GTAOPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private bokeh: BokehPass | null = null;
  private readonly clock = new Clock();
  private readonly environment: WebGLRenderTarget;
  private frame = 0;
  private running = false;
  private visible = true;
  private slow = 0;
  private fast = 0;
  private quality: Quality;
  private auto: boolean;
  private readonly observer: ResizeObserver;
  private readonly seen: IntersectionObserver;
  private width = 1;
  private height = 1;
  private detailBlend = 0;
  private skipPerformanceSample = true;
  private readonly detailNormal = new Vector3(0, 1, 0);
  onQuality: (q: Quality) => void = () => {};

  constructor(private readonly host: HTMLElement, quality: Quality | "auto" = "auto") {
    this.renderer = new WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    // the room stands still: its shadows are drawn again when something moves (`invalidate`), and now and then
    // for the breathing — not every frame
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.domElement.className = "stage-canvas";
    host.appendChild(this.renderer.domElement);
    this.auto = quality === "auto";
    this.quality = quality === "auto" ? "high" : quality;

    // light from the room itself (reflections, the soft fill of a white room)
    const pmrem = new PMREMGenerator(this.renderer);
    const roomEnvironment = new RoomEnvironment();
    this.environment = pmrem.fromScene(roomEnvironment, 0.04);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.background = new Color(0xe9e6df);
    pmrem.dispose();
    roomEnvironment.dispose();

    RectAreaLightUniformsLib.init();
    const sun = new DirectionalLight(0xfff5ea, 2.25);
    sun.castShadow = true;
    sun.shadow.bias = -0.00025;
    sun.shadow.normalBias = 0.018;
    const cam = sun.shadow.camera;
    cam.left = -2.6;
    cam.right = 2.6;
    cam.top = 2.6;
    cam.bottom = -2.6;
    cam.near = 0.5;
    cam.far = 14;
    const panel = new RectAreaLight(0xfffaf2, 5.5, 1.2, 0.6);
    panel.rotation.x = -Math.PI / 2;
    const rim = new SpotLight(0xe4eeff, 18, 9, 0.62, 0.85, 1.6);
    rim.castShadow = false;
    const sky = new HemisphereLight(0xfbfaf6, 0xcfc8ba, 0.32);
    // The room-sized shadow map cannot resolve millimetre-scale finger/handle contact.
    // This bounded inspection light keeps that precision local to the working hand.
    const detail = new DirectionalLight(0xfff2e6, 0);
    detail.visible = false;
    detail.castShadow = true;
    detail.shadow.bias = -0.000015;
    detail.shadow.normalBias = 0.0002;
    detail.shadow.camera.left = detail.shadow.camera.bottom = -0.2;
    detail.shadow.camera.right = detail.shadow.camera.top = 0.2;
    detail.shadow.camera.near = 0.03;
    detail.shadow.camera.far = 1.1;
    detail.shadow.camera.updateProjectionMatrix();
    this.scene.add(sun, sun.target, panel, rim, rim.target, sky, detail, detail.target);
    this.lights = { sun, panel, rim, sky, detail };

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.seen = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (visible !== this.visible) this.skipPerformanceSample = true;
      this.visible = visible;
      if (this.visible && this.running && !this.frame) this.loop();
    });
    this.seen.observe(host);
    document.addEventListener("visibilitychange", this.visibilityChanged);
    this.build();
    this.resize();
  }

  private shadowsAt = 0;
  private moving = 0;

  /** Something moved (a person, a needle): the shadows are drawn again for the next `frames` frames. */
  invalidate(frames = 2): void {
    this.moving = Math.max(this.moving, frames);
  }

  /** Light the set the camera is in (the sun comes in at the window on its left). */
  lightSet(x: number, z: number): void {
    const { sun, panel, rim } = this.lights;
    sun.position.set(x - 5.2, 4.6, z + 2.2);
    sun.target.position.set(x, 0.6, z);
    sun.target.updateMatrixWorld();
    this.invalidate(3);
    panel.position.set(x, 2.7, z - 0.2);
    rim.position.set(x + 2.3, 2.6, z - 2.0);
    rim.target.position.set(x, 0.75, z);
    rim.target.updateMatrixWorld();
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  get automaticQuality(): boolean {
    return this.auto;
  }

  /** Set the quality (or "auto": it follows the frame rate). */
  setQuality(q: Quality | "auto"): void {
    this.auto = q === "auto";
    const next = q === "auto" ? this.quality : q;
    if (next !== this.quality || q !== "auto") {
      this.quality = next;
      this.build();
      this.resize();
      this.onQuality(this.quality);
    }
  }

  private build(): void {
    const q = this.quality;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q === "high" ? 2 : q === "medium" ? 1.25 : 1));
    const size = q === "high" ? 4096 : q === "medium" ? 2048 : 1024;
    const sun = this.lights.sun;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null as unknown as typeof sun.shadow.map;
    }
    const detail = this.lights.detail;
    const detailSize = q === "high" ? 2048 : 1024;
    detail.castShadow = q !== "low";
    if (detail.shadow.mapSize.x !== detailSize) {
      detail.shadow.mapSize.set(detailSize, detailSize);
      detail.shadow.dispose();
      detail.shadow.map = null;
      detail.shadow.mapPass = null;
    }
    this.disposeComposer();
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: q === "low" ? 0 : 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = null;
    this.bloom = null;
    if (q !== "low") {
      const gtao = new GTAOPass(this.scene, this.camera, 1, 1);
      gtao.blendIntensity = 0.85;
      gtao.updateGtaoMaterial({ radius: 0.3, distanceExponent: 1.6, thickness: 1.0, scale: 1, samples: q === "high" ? 16 : 12 });
      // a wide, edge-aware blur of the occlusion: contact shadows without grain
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 10, rings: 3, samples: 16 });
      this.composer.addPass(gtao);
      this.gtao = gtao;
    }
    this.bokeh = null;
    if (q === "high") {
      // a shallow depth of field on close shots (`focus`), as a camera lens has
      const bokeh = new BokehPass(this.scene, this.camera, { focus: 1, aperture: 0.0005, maxblur: 0.002 });
      bokeh.enabled = false;
      this.composer.addPass(bokeh);
      this.bokeh = bokeh;
      // only what gives light of its own blooms (the window, the ceiling panel), not a white surface in the sun
      const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.12, 0.5, 1.25);
      this.composer.addPass(bloom);
      this.bloom = bloom;
    }
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new ShaderPass(GRADE));
    // without multisampling (low), edges are smoothed after the fact
    if (q === "low") this.composer.addPass(new SMAAPass());
    this.renderer.shadowMap.needsUpdate = true;
    this.invalidate(2);
  }

  resize(): void {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w === this.width && h === this.height && this.composer.renderTarget1.width > 1) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, true);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Draw a frame every display refresh while the view is on screen, calling `step` first. */
  start(step: (dt: number, now: number) => void): void {
    this.running = true;
    this.step = step;
    this.clock.start();
    this.skipPerformanceSample = true;
    this.loop();
  }

  private step: (dt: number, now: number) => void = () => {};

  private visibilityChanged = (): void => {
    this.skipPerformanceSample = true;
    if (!document.hidden && this.running && this.visible && !this.frame) this.loop();
  };

  private loop = (): void => {
    this.frame = 0;
    if (!this.running || !this.visible || document.hidden) {
      this.skipPerformanceSample = true;
      return;
    }
    const frameInterval = this.clock.getDelta() * 1000;
    const dt = Math.min(100, frameInterval);
    const now = performance.now();
    const t0 = performance.now();
    this.step(dt, now);
    if (this.moving > 0 || now - this.shadowsAt > 700) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowsAt = now;
      if (this.moving > 0) this.moving--;
    }
    this.composer.render(dt / 1000);
    // Include motion, skin deformation and contact checks, not only command submission to WebGL.
    // The first frame after an offscreen/background interval is not a performance sample.
    if (this.skipPerformanceSample) this.skipPerformanceSample = false;
    else this.measure(performance.now() - t0, frameInterval);
    this.frame = requestAnimationFrame(this.loop);
  };

  /** Step the quality down when frames are slow for a while (and back up, carefully, when they are fast). */
  private measure(workMs: number, intervalMs: number): void {
    if (!this.auto) return;
    const ms = Math.max(workMs, intervalMs);
    if (ms > 26) this.slow++;
    else this.slow = Math.max(0, this.slow - 1);
    if (workMs < 9 && intervalMs < 20) this.fast++;
    else this.fast = 0;
    if (this.slow > 40 && this.quality !== "low") {
      this.slow = 0;
      this.quality = this.quality === "high" ? "medium" : "low";
      this.build();
      this.resize();
      this.onQuality(this.quality);
    }
    if (this.fast > 900 && this.quality !== "high") {
      this.fast = 0;
      this.quality = this.quality === "low" ? "medium" : "high";
      this.build();
      this.resize();
      this.onQuality(this.quality);
    }
  }

  /** Keep the working fingers readable while lighting their actual millimetre-scale contacts. */
  focus(distance: number, point?: Vector3, detail?: DetailFocus): void {
    const active = !!detail && distance < 0.95;
    this.detailBlend += ((active ? 1 : 0) - this.detailBlend) * 0.16;
    const light = this.lights.detail;
    light.intensity = this.detailBlend * 0.48;
    light.visible = this.detailBlend > 0.01;
    if (this.gtao) {
      // Room-scale occlusion makes a centimetre-wide finger gap look like a deep cavity.
      this.gtao.updateGtaoMaterial({ radius: 0.3 - this.detailBlend * 0.27, thickness: 1 - this.detailBlend * 0.96 });
      this.gtao.blendIntensity = 0.85 - this.detailBlend * 0.2;
    }
    if (active) {
      this.detailNormal.copy(detail.normal);
      if (this.detailNormal.lengthSq() < 1e-10) this.detailNormal.set(0, 1, 0);
      this.detailNormal.normalize();
      const towardCamera = this.camera.position.clone().sub(detail.point).normalize();
      const side = new Vector3().crossVectors(this.detailNormal, towardCamera);
      if (side.lengthSq() > 1e-10) side.normalize();
      const next = detail.point.clone().addScaledVector(this.detailNormal, 0.43).addScaledVector(side, 0.22).addScaledVector(towardCamera, 0.12);
      if (light.position.distanceToSquared(next) > 0.0001 ** 2 || light.target.position.distanceToSquared(detail.point) > 0.0001 ** 2) this.invalidate(1);
      light.position.copy(next);
      light.target.position.copy(detail.point);
      light.target.updateMatrixWorld();
    }
    const b = this.bokeh;
    if (!b) return;
    const close = distance < 1.25;
    b.enabled = close;
    if (!close) return;
    const u = b.uniforms as unknown as Record<string, { value: number }>;
    u.focus!.value = point ? this.camera.position.distanceTo(point) : distance;
    // The whole hand, needle handle and entry stay readable in an inspection view.
    u.aperture!.value = detail ? 0.00012 : 0.0005 * Math.min(1, (1.25 - distance) / 0.5);
  }

  private disposeComposer(): void {
    if (!this.composer) return;
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
  }

  /** The frame as a picture (PNG). */
  async picture(): Promise<Blob | null> {
    this.composer.render(0);
    return new Promise((resolve) => this.renderer.domElement.toBlob((b) => resolve(b), "image/png"));
  }

  dispose(): void {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.seen.disconnect();
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    this.disposeComposer();
    for (const light of [this.lights.sun, this.lights.detail]) light.shadow.dispose();
    this.environment.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
