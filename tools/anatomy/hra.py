"""Geometry helpers over a HuBMAP Human Reference Atlas "united" reference body (Visible Human Male or Female).

The body's frame, in metres: x towards the patient's LEFT, y cranial, z anterior. A trunk chart unrolls the skin
round a horizontal cross-section: `u` is the arc length (cm) from the anterior or the posterior midline, positive
towards the patient's left; `v` is the height (cm) above the chart's origin level; `d` is the depth (cm) along the
inward normal of the skin in that cross-section. Depths to organs come from rays cast inward from the skin.

Requires numpy, trimesh, shapely, networkx, rtree (tools/anatomy/requirements.txt). Used only to generate content.
"""
import re
import warnings

import numpy as np
import trimesh
from shapely.geometry import LineString, Point

warnings.filterwarnings("ignore")


class Body:
    """A reference body: every named mesh of the united GLB, placed in the body frame."""

    def __init__(self, path, prefix):
        scene = trimesh.load(path, force="scene")
        self.prefix = prefix
        self.parts = {}
        for node in scene.graph.nodes_geometry:
            transform, geom = scene.graph[node]
            mesh = scene.geometry[geom].copy()
            mesh.apply_transform(transform)
            self.parts[node[len(prefix):] if node.startswith(prefix) else node] = mesh
        self._unions = {}

    def names(self, pattern):
        return sorted(n for n in self.parts if re.search(pattern, n))

    def union(self, pattern):
        if pattern not in self._unions:
            meshes = [self.parts[n] for n in self.names(pattern)]
            self._unions[pattern] = trimesh.util.concatenate(meshes) if meshes else None
        return self._unions[pattern]


def vertebra(body, name):
    """Levels of a vertebra (metres): its body centre, its spinous tip and the inferior border of its spinous process."""
    v = body.parts[name].vertices
    xc = float(np.median(v[:, 0]))
    zmid = float(np.median(v[:, 2]))
    corpus = v[v[:, 2] > zmid]
    near = v[np.abs(v[:, 0] - xc) < 0.008]
    zmin = float(near[:, 2].min())
    spine = near[near[:, 2] < zmin + 0.012]
    tip = spine[np.argmin(spine[:, 2])]
    return {
        "x": xc,
        "body_y": float(corpus[:, 1].mean()),
        "body_z": float(corpus[:, 2].mean()),
        "tip": tip.tolist(),
        "spinous_inferior_y": float(spine[:, 1].min()),
        "spinous_superior_y": float(spine[:, 1].max()),
    }


class Section:
    """The skin's cross-section at height y round the polygon that contains `inside` (x, z)."""

    def __init__(self, skin, y, inside, clip=None):
        self.y = y
        sec = skin.section(plane_origin=[0, y, 0], plane_normal=[0, 1, 0])
        if sec is None:
            raise ValueError(f"no skin at y={y}")
        to2d = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, y], [0, 0, 0, 1]], dtype=float)
        planar, _ = sec.to_2D(to_2D=to2d)
        polys = [p for p in planar.polygons_full if p.contains(Point(inside))]
        if not polys:
            polys = sorted(planar.polygons_full, key=lambda p: p.distance(Point(inside)))
        self.poly = polys[0]
        if clip is not None:
            # where the arms touch the trunk, cut them off at the trunk's lateral limits
            from shapely.geometry import box
            cut = self.poly.intersection(box(inside[0] - clip, -1, inside[0] + clip, 1))
            pieces = list(getattr(cut, "geoms", [cut]))
            self.poly = max((g for g in pieces if g.geom_type == "Polygon"), key=lambda g: g.area)
        self.ring = LineString(self.poly.exterior.coords)
        self.length = self.ring.length

    def _midline(self, x, anterior):
        """Distance along the ring of the anterior (or posterior) midline point at x."""
        line = LineString([(x, -1), (x, 1)])
        hits = self.ring.intersection(line)
        pts = [hits] if hits.geom_type == "Point" else list(getattr(hits, "geoms", []))
        pts = [p for p in pts if p.geom_type == "Point"]
        best = max(pts, key=lambda p: p.y) if anterior else min(pts, key=lambda p: p.y)
        return self.ring.project(best), (best.x, best.y)

    def chart(self, x_mid, anterior):
        """Arc-length chart from a midline: returns (to_u, from_u)."""
        s0, _ = self._midline(x_mid, anterior)
        L = self.length
        # direction along the ring that heads towards +x (the patient's left)
        step = self.ring.interpolate((s0 + 0.002) % L)
        sign = 1 if step.x > x_mid else -1

        def to_u(s):
            ds = ((s - s0) * sign) % L
            return ds if ds <= L / 2 else ds - L

        def from_u(u):
            return (s0 + sign * u) % L

        return to_u, from_u

    def point_normal(self, s):
        """Skin point (x, z) at ring distance s and the inward normal there."""
        p = self.ring.interpolate(s)
        a = self.ring.interpolate((s - 0.004) % self.length)
        b = self.ring.interpolate((s + 0.004) % self.length)
        t = np.array([b.x - a.x, b.y - a.y])
        t /= np.linalg.norm(t) or 1
        n = np.array([-t[1], t[0]])
        probe = Point(p.x + n[0] * 0.003, p.y + n[1] * 0.003)
        if not self.poly.contains(probe):
            n = -n
        return np.array([p.x, p.y]), n

    def project(self, x, z):
        """Nearest ring distance to an (x, z) point and the distance to it."""
        s = self.ring.project(Point(x, z))
        p = self.ring.interpolate(s)
        return s, float(np.hypot(p.x - x, p.y - z))


def ray_hits(mesh, origin, direction, max_cm=15):
    """Entry and exit distances (cm) of a ray through a mesh, nearest first: [(entry, exit), ...]."""
    if mesh is None:
        return []
    locs, _, _ = mesh.ray.intersects_location([origin], [direction], multiple_hits=True)
    if len(locs) == 0:
        return []
    d = np.sort(np.linalg.norm(locs - origin, axis=1) * 100)
    d = d[d <= max_cm + 20]
    spans = []
    for i in range(0, len(d) - 1, 2):
        if d[i] <= max_cm:
            spans.append([float(d[i]), float(d[i + 1])])
    if len(d) % 2 == 1 and d[-1] <= max_cm:
        spans.append([float(d[-1]), float(d[-1]) + 3])
    # an organ made of touching parts (lung segments, heart chambers) is one span
    merged = []
    for a, b in spans:
        if merged and a - merged[-1][1] < 1.5:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


def r2(x, q=0.05):
    """Round to a step (default 0.5 mm) for compact, deterministic content."""
    return round(round(x / q) * q, 2)
