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
}

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
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.background = new Color(0xe9e6df);
    pmrem.dispose();

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
    this.scene.add(sun, sun.target, panel, rim, rim.target, sky);
    this.lights = { sun, panel, rim, sky };

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.seen = new IntersectionObserver((entries) => {
      this.visible = entries.some((e) => e.isIntersecting);
      if (this.visible && this.running && !this.frame) this.loop();
    });
    this.seen.observe(host);
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
    this.composer?.dispose();
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
      const bokeh = new BokehPass(this.scene, this.camera, { focus: 1, aperture: 0.0016, maxblur: 0.0065 });
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
    this.loop();
  }

  private step: (dt: number, now: number) => void = () => {};

  private loop = (): void => {
    this.frame = 0;
    if (!this.running || !this.visible || document.hidden) {
      if (this.running && document.hidden) document.addEventListener("visibilitychange", this.loop, { once: true });
      return;
    }
    const dt = Math.min(100, this.clock.getDelta() * 1000);
    const now = performance.now();
    this.step(dt, now);
    if (this.moving > 0 || now - this.shadowsAt > 700) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowsAt = now;
      if (this.moving > 0) this.moving--;
    }
    const t0 = performance.now();
    this.composer.render(dt / 1000);
    this.measure(performance.now() - t0 + dt * 0);
    this.frame = requestAnimationFrame(this.loop);
  };

  /** Step the quality down when frames are slow for a while (and back up, carefully, when they are fast). */
  private measure(ms: number): void {
    if (!this.auto) return;
    if (ms > 26) this.slow++;
    else this.slow = Math.max(0, this.slow - 1);
    if (ms < 7) this.fast++;
    else this.fast = 0;
    if (this.slow > 40 && this.quality !== "low") {
      this.slow = 0;
      this.quality = this.quality === "high" ? "medium" : "low";
      this.build();
      this.resize();
      this.onQuality(this.quality);
    }
    if (this.fast > 900 && this.quality === "medium") {
      this.fast = 0;
      this.quality = "high";
      this.build();
      this.resize();
      this.onQuality(this.quality);
    }
  }

  /** Focus the lens at `distance` (m): close shots get a shallow depth of field (high quality only). */
  focus(distance: number): void {
    const b = this.bokeh;
    if (!b) return;
    const close = distance < 1.25;
    b.enabled = close;
    if (!close) return;
    const u = b.uniforms as unknown as Record<string, { value: number }>;
    u.focus!.value = distance;
    u.aperture!.value = 0.0022 * Math.min(1, (1.25 - distance) / 0.5);
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
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
