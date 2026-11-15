import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Network, VehicleClassId } from '@weave/engine';
import { FRAME_STRIDE, F_CLASS, F_HEADING, F_LENGTH, F_SPEED_RATIO, F_WIDTH, F_X, F_Y, F_Z } from '@weave/engine/protocol';
import { classCss, readMapTheme, speedRgb, type ColourMode } from './palette.ts';
import type { FrameView } from './renderer.ts';

/**
 * Optional 3D view (MODEL.md §6.3 item 4). Loaded with a dynamic import only when first opened,
 * so three.js never enters the initial bundle. World x/y stay horizontal and z is up; roads follow
 * each segment's z-profile, elevated links get side walls and pillars, vehicles are one instanced
 * box mesh sized from the frame. Rendering only: nothing here feeds back into the simulation.
 */

/** Vehicle heights by class (rendering assumption, §6.3 item 4). */
const CLASS_HEIGHT: Record<string, number> = { motorcycle: 1.4, car: 1.5, auto: 1.7, lcv: 2.2, bus: 3.0, truck: 3.2 };
const LINK_LIFT = 0.03; // above the ground plane
const MOVE_LIFT = 0.06; // junction paths over the links they join
const DECK_DEPTH = 0.9; // visual thickness of elevated decks
const PILLAR_EVERY_M = 22;

/** 3D surface colours: more contrast than the flat map needs, decks lighter than ground roads. */
const SURFACES = {
  dark: { ground: '#0f1720', road: '#334152', deck: '#55667a', wall: '#2a3542', pillar: '#7b8a9c' },
  light: { ground: '#e4e9e2', road: '#8d97a3', deck: '#c3cbd4', wall: '#5d6977', pillar: '#6f7b89' },
};

type Poly = readonly (readonly [number, number])[];

function polyLength(p: Poly): number[] {
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1]! + Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1]));
  return cum;
}

/** Left/right edge points of a polyline ribbon with mitre-free averaged normals. */
function edges(p: Poly, halfW: number): { l: [number, number][]; r: [number, number][] } {
  const l: [number, number][] = [];
  const r: [number, number][] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[Math.max(0, i - 1)]!;
    const b = p[Math.min(p.length - 1, i + 1)]!;
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const n = Math.hypot(tx, ty) || 1;
    tx /= n;
    ty /= n;
    l.push([p[i]![0] - ty * halfW, p[i]![1] + tx * halfW]);
    r.push([p[i]![0] + ty * halfW, p[i]![1] - tx * halfW]);
  }
  return { l, r };
}

export class Scene3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.5, 20000);
  private controls: OrbitControls;
  private world = new THREE.Group();
  private vehicles: THREE.InstancedMesh | null = null;
  private capacity = 0;
  private classIds: VehicleClassId[] = [];
  private colourMode: ColourMode = 'class';
  private frame: FrameView | null = null;
  private dirty = true;
  private raf = 0;
  private ro: ResizeObserver;
  private dark = true;
  private tmp = new THREE.Object3D();
  private colour = new THREE.Color();

  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // Throws when WebGL is unavailable; the caller falls back to 2D.
    // Dense screens get no MSAA (little visible gain) and a 1.5× pixel-ratio cap: fill rate is
    // what limits phones.
    const dpr = window.devicePixelRatio || 1;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: dpr < 1.5, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(dpr, 1.5));
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = false; // pan along the ground
    this.controls.maxPolarAngle = Math.PI * 0.48; // stay above the ground
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('change', () => (this.dirty = true));
    this.scene.add(this.world);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-0.4, -0.6, 1);
    this.scene.add(sun);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      // Damping keeps moving after input stops, so update() every frame and render on change.
      this.controls.update();
      if (this.dirty) this.render();
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.clearWorld();
    this.renderer.dispose();
  }

  setColourMode(mode: ColourMode): void {
    this.colourMode = mode;
    this.updateVehicles();
  }

  setFrame(frame: FrameView): void {
    this.frame = frame;
    this.updateVehicles();
  }

  private clearWorld(): void {
    this.world.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.world.clear();
    this.vehicles = null;
    this.capacity = 0;
  }

  setNetwork(net: Network, classIds: VehicleClassId[]): void {
    this.clearWorld();
    this.classIds = classIds;
    const theme = readMapTheme();
    this.dark = theme.dark;
    const c = theme.dark ? SURFACES.dark : SURFACES.light;
    this.scene.background = new THREE.Color(c.ground);
    const roadMat = new THREE.MeshLambertMaterial({ color: c.road, side: THREE.DoubleSide });
    const deckMat = new THREE.MeshLambertMaterial({ color: c.deck, side: THREE.DoubleSide });
    const wallMat = new THREE.MeshLambertMaterial({ color: c.wall, side: THREE.DoubleSide });
    const pillarMat = new THREE.MeshLambertMaterial({ color: c.pillar });

    const pos: number[] = [];
    const deckPos: number[] = [];
    const wallPos: number[] = [];
    const pillars: [number, number, number][] = [];
    const ribbon = (poly: Poly, width: number, z0: number, z1: number, lift: number, elevated: boolean) => {
      if (poly.length < 2) return;
      const cum = polyLength(poly);
      const L = cum[cum.length - 1]! || 1;
      const { l, r } = edges(poly, width / 2);
      const z = (i: number) => z0 + (z1 - z0) * (cum[i]! / L) + lift;
      const out = elevated ? deckPos : pos;
      for (let i = 0; i + 1 < poly.length; i++) {
        const [a, b, c, d] = [l[i]!, r[i]!, l[i + 1]!, r[i + 1]!];
        out.push(a[0], a[1], z(i), b[0], b[1], z(i), c[0], c[1], z(i + 1));
        out.push(b[0], b[1], z(i), d[0], d[1], z(i + 1), c[0], c[1], z(i + 1));
        if (elevated) {
          for (const [p, q] of [[a, c], [b, d]] as const) {
            const zp = z(i);
            const zq = z(i + 1);
            wallPos.push(p[0], p[1], zp, q[0], q[1], zq, p[0], p[1], zp - DECK_DEPTH);
            wallPos.push(q[0], q[1], zq, q[0], q[1], zq - DECK_DEPTH, p[0], p[1], zp - DECK_DEPTH);
          }
        }
      }
      if (elevated) {
        for (let s = PILLAR_EVERY_M / 2; s < L; s += PILLAR_EVERY_M) {
          const zs = z0 + (z1 - z0) * (s / L);
          if (zs < 2) continue; // ramps near the ground need no pillar
          let i = 0;
          while (i + 1 < cum.length - 1 && cum[i + 1]! < s) i++;
          const u = (s - cum[i]!) / (cum[i + 1]! - cum[i]! || 1);
          pillars.push([poly[i]![0] + (poly[i + 1]![0] - poly[i]![0]) * u, poly[i]![1] + (poly[i + 1]![1] - poly[i]![1]) * u, zs - DECK_DEPTH]);
        }
      }
    };
    const linkById = new Map(net.links.map((l) => [l.id, l]));
    for (const l of net.links) {
      const elevated = l.zFromM > 0.5 || l.zToM > 0.5;
      ribbon(l.polyline, l.widthM, l.zFromM, l.zToM, LINK_LIFT, elevated);
    }
    for (const m of net.movements) {
      const z0 = linkById.get(m.fromLink)?.zToM ?? 0;
      const z1 = linkById.get(m.toLink)?.zFromM ?? 0;
      ribbon(m.path, m.widthM, z0, z1, MOVE_LIFT, z0 > 0.5 || z1 > 0.5);
    }
    const mesh = (arr: number[], mat: THREE.Material) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      g.computeVertexNormals();
      return new THREE.Mesh(g, mat);
    };
    if (pos.length) this.world.add(mesh(pos, roadMat));
    if (deckPos.length) this.world.add(mesh(deckPos, deckMat));
    if (wallPos.length) this.world.add(mesh(wallPos, wallMat));
    if (pillars.length) {
      const geo = new THREE.CylinderGeometry(0.45, 0.55, 1, 10);
      geo.rotateX(Math.PI / 2); // cylinder along z
      geo.translate(0, 0, 0.5); // base at z = 0
      const inst = new THREE.InstancedMesh(geo, pillarMat, pillars.length);
      pillars.forEach(([x, y, h], i) => {
        this.tmp.position.set(x, y, 0);
        this.tmp.rotation.set(0, 0, 0);
        this.tmp.scale.set(1, 1, h);
        this.tmp.updateMatrix();
        inst.setMatrixAt(i, this.tmp.matrix);
      });
      this.world.add(inst);
    }
    // Ground plane under everything.
    const bb = new THREE.Box3().setFromObject(this.world);
    const size = bb.getSize(new THREE.Vector3());
    const centre = bb.getCenter(new THREE.Vector3());
    const groundGeo = new THREE.PlaneGeometry(Math.max(size.x, 50) * 3, Math.max(size.y, 50) * 3);
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ color: c.ground }));
    ground.position.set(centre.x, centre.y, -0.02);
    this.world.add(ground);
    // Frame the elevated structure when there is one (that is what 3D is for), else everything.
    if (deckPos.length) {
      const eb = new THREE.Box3().setFromArray(deckPos);
      const es = eb.getSize(new THREE.Vector3());
      this.fit(eb.getCenter(new THREE.Vector3()), Math.min(Math.max(es.x, es.y) * 0.9, Math.max(size.x, size.y)), true);
    } else this.fit(centre, Math.max(size.x, size.y, 60));
    this.ensureCapacity(256);
    this.updateVehicles();
  }

  /** Oblique view of the whole network from the south-west. */
  fit(centre?: THREE.Vector3, extent?: number, oblique = false): void {
    const c = centre ?? this.controls.target.clone();
    const e = Math.max(extent ?? 300, 120);
    const d = e * (oblique ? 0.7 : 0.95);
    this.controls.target.set(c.x, c.y, 0);
    this.camera.position.set(c.x - d * 0.35, c.y - d * 0.8, d * (oblique ? 0.38 : 0.6));
    this.camera.far = Math.max(20000, d * 10);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.dirty = true;
  }

  private ensureCapacity(n: number): void {
    if (this.vehicles && n <= this.capacity) return;
    const cap = Math.max(256, 1 << Math.ceil(Math.log2(Math.max(n, 1))));
    if (this.vehicles) {
      this.world.remove(this.vehicles);
      this.vehicles.geometry.dispose();
      (this.vehicles.material as THREE.Material).dispose();
    }
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, 0.5); // box sits on the road
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.vehicles = new THREE.InstancedMesh(geo, mat, cap);
    this.vehicles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.vehicles.frustumCulled = false;
    this.vehicles.count = 0;
    this.capacity = cap;
    this.world.add(this.vehicles);
  }

  private updateVehicles(): void {
    const f = this.frame;
    if (!f) return;
    this.ensureCapacity(f.count);
    const v = this.vehicles!;
    const d = f.data;
    const bySpeed = this.colourMode === 'speed';
    for (let i = 0; i < f.count; i++) {
      const o = i * FRAME_STRIDE;
      const cls = this.classIds[d[o + F_CLASS]! | 0];
      this.tmp.position.set(d[o + F_X]!, d[o + F_Y]!, d[o + F_Z]! + MOVE_LIFT + 0.01);
      this.tmp.rotation.set(0, 0, d[o + F_HEADING]!);
      this.tmp.scale.set(d[o + F_LENGTH]!, d[o + F_WIDTH]!, CLASS_HEIGHT[cls ?? ''] ?? 1.6);
      this.tmp.updateMatrix();
      v.setMatrixAt(i, this.tmp.matrix);
      if (bySpeed) {
        const [r, g, b] = speedRgb(d[o + F_SPEED_RATIO]!);
        this.colour.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
      } else this.colour.set(classCss(cls, this.dark));
      v.setColorAt(i, this.colour);
    }
    v.count = f.count;
    v.instanceMatrix.needsUpdate = true;
    if (v.instanceColor) v.instanceColor.needsUpdate = true;
    this.dirty = true;
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private render(): void {
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  }
}
