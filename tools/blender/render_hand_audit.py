"""Render a reproducible deformation audit of the shipped hand GLB.

    blender -b -P tools/blender/render_hand_audit.py -- --no-render
    blender -b -P tools/blender/render_hand_audit.py -- \
      --report /tmp/acucraft-hand-audit.json

This reads the actual GLB positions, normals, UVs, joints, weights and inverse
bind matrices. It evaluates ordinary glTF linear skinning without rebuilding,
subdividing or sculpting the asset. Blender's importer supplies the unchanged
embedded materials. The four fingers use fixed-length MCP/PIP/DIP hinges in
the asset's palm_frame, following hand-physiology.ts's complete-frame method.
No animation clip, quaternion interpolation, or clinical needle path is used.

These are deformation inspection poses, not clinical ROM measurements or
running acupuncture contact poses. The default independent thumb pose has a
relaxed, abducted metacarpal and mildly flexed MCP/IP. Its actual geometric
bearings, joint angles and source-relative rotations are recorded in JSON.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import struct
import subprocess
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector, geometry
from mathutils.bvhtree import BVHTree


REPO = Path(__file__).resolve().parents[2]
DIGITS = ("index", "middle", "ring", "little")
LEGACY = ("proximal", "middle", "distal")
JOINTS = ("MCP", "PIP", "DIP")
THUMB_DIAGNOSTIC = {"name": "Relaxed abducted thumb", "metacarpalRadialBearingDeg": 40,
                    "metacarpalPalmarBearingDeg": 35, "mcpFlexionDeg": 5, "ipFlexionDeg": 5}
# Diagnostic settings use the runtime physiology helper's same axis method.
# All rows and the free index are deliberately inspection-only poses; actual
# working-finger contact solutions are verified separately in the product UI.
POSES = [
    {"name": "Extended", "jointsDeg": {digit: [0, 10, 7] for digit in DIGITS}},
    {"name": "Half flexion", "jointsDeg": {
        "index": [30, 36, 21], "middle": [30, 36, 21],
        "ring": [34, 40, 23], "little": [38, 44, 26]}},
    # The runtime helper's shared curled table fills M/R/L at load time.
    {"name": "Curled inspection", "jointsDeg": {"index": [52, 72, 42]}},
]
COMPONENTS = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
              5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4,
          "MAT2": 4, "MAT3": 9, "MAT4": 16}


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset", type=Path, default=REPO / "content/world/assets/models/acu-practitioner-hand.glb")
    parser.add_argument("--expected-asset-sha256", help="Refuse to inspect or render a different asset")
    parser.add_argument("--output", type=Path, default=REPO / "docs/img/hand-anatomy-flexion-audit.png")
    parser.add_argument("--report", type=Path, default=Path("/tmp/acucraft-hand-audit.json"))
    parser.add_argument("--pose-spec", type=Path, help="Optional JSON array with name and jointsDeg for each of three rows")
    parser.add_argument("--physiology-table", type=Path,
                        help="Use an exported runtime table with a matching physiologySha256; by default export the helper directly through the repo's tsx")
    parser.add_argument("--thumb-pose", choices=("relaxed-abducted", "authored"), default="relaxed-abducted")
    parser.add_argument("--thumb-cmc-abduction-deg", type=float, default=0,
                        help="Requires --thumb-pose authored: inspection-only source-relative CMC delta, not clinical ROM")
    parser.add_argument("--size", type=int, default=2100, help="Square image resolution")
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--no-render", action="store_true", help="Measure the actual GLB without creating a render or using the GPU")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])


def glb(path):
    raw = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", raw)
    if magic != 0x46546C67 or version != 2 or length != len(raw):
        raise ValueError("Expected a complete glTF 2 GLB")
    offset, document, binary = 12, None, None
    while offset < len(raw):
        size, kind = struct.unpack_from("<II", raw, offset)
        block = raw[offset + 8:offset + 8 + size]
        if kind == 0x4E4F534A:
            document = json.loads(block)
        elif kind == 0x004E4942:
            binary = block
        offset += size + 8
    if document is None or binary is None:
        raise ValueError("The GLB must embed both its JSON and binary data")
    return raw, document, binary


def accessor(document, binary, index):
    value = document["accessors"][index]
    if "sparse" in value:
        raise ValueError("Sparse accessors are not supported by this finite asset audit")
    view = document["bufferViews"][value["bufferView"]]
    code, size = COMPONENTS[value["componentType"]]
    width = WIDTHS[value["type"]]
    start = view.get("byteOffset", 0) + value.get("byteOffset", 0)
    stride = view.get("byteStride", width * size)
    result = [struct.unpack_from("<" + code * width, binary, start + row * stride) for row in range(value["count"])]
    if value.get("normalized"):
        if code in ("B", "H"):
            maximum = 255 if code == "B" else 65535
            result = [tuple(component / maximum for component in row) for row in result]
        elif code in ("b", "h"):
            maximum = 127 if code == "b" else 32767
            result = [tuple(max(-1, component / maximum) for component in row) for row in result]
    return result


def quat(node):
    x, y, z, w = node.get("rotation", (0, 0, 0, 1))
    return Quaternion((w, x, y, z))


def local_matrix(node):
    if "matrix" in node:
        return Matrix([node["matrix"][row::4] for row in range(4)])
    return Matrix.LocRotScale(Vector(node.get("translation", (0, 0, 0))), quat(node), Vector(node.get("scale", (1, 1, 1))))


def world_matrices(nodes):
    parents = {child: index for index, node in enumerate(nodes) for child in node.get("children", [])}
    result = {}
    def world(index):
        if index not in result:
            local = local_matrix(nodes[index])
            result[index] = world(parents[index]) @ local if index in parents else local
        return result[index]
    for index in range(len(nodes)):
        world(index)
    return result


def signed_angle(before, after, axis):
    return math.atan2(before.cross(after).dot(axis), before.dot(after))


def ulnar_spread_deg(mcp_deg, nominal):
    flexion = math.radians(max(0, min(90, mcp_deg)))
    return nominal * (0.2 + 0.8 * math.cos(flexion) ** 2)


def runtime_physiology(path=None):
    """Read the same exported constants as the real hand, never a second table."""
    helper = REPO / "packages/server/web/stage/hand-physiology.ts"
    if path:
        table = json.loads(path.read_text())
    else:
        script = """
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RESTING_POSTURES, RESTING_FINGER_SPREAD_AT_EXTENSION_DEG, restingFingerPosture } from './packages/server/web/stage/hand-physiology.ts';
process.stdout.write(JSON.stringify({
  physiologySha256:createHash('sha256').update(readFileSync('packages/server/web/stage/hand-physiology.ts')).digest('hex'),
  angles:RESTING_POSTURES, nominalSpreadDeg:RESTING_FINGER_SPREAD_AT_EXTENSION_DEG,
  actual:Object.fromEntries(['curled','relaxed'].map(style=>[style,Object.fromEntries(['middle','ring','little'].map(digit=>[digit,restingFingerPosture(digit,style)]))]))
}));
"""
        result = subprocess.run([str(REPO / "node_modules/.bin/tsx"), "--eval", script], cwd=REPO,
                                check=True, capture_output=True, text=True)
        table = json.loads(result.stdout)
    actual_hash = hashlib.sha256(helper.read_bytes()).hexdigest()
    if table["physiologySha256"] != actual_hash:
        raise ValueError("The exported physiology table is stale relative to the actual runtime helper")
    for digit in ("middle", "ring", "little"):
        if len(table["angles"]["curled"][digit]) != 3 or digit not in table["nominalSpreadDeg"]:
            raise ValueError(f"Incomplete shared runtime physiology table for {digit}")
    errors = [abs(ulnar_spread_deg(values[0], table["nominalSpreadDeg"][digit]) - table["actual"][style][digit]["ulnarSpreadDeg"])
              for style, digits in table["angles"].items() for digit, values in digits.items()]
    if max(errors) > 1e-8:
        raise ValueError("The diagnostic splay envelope differs from the actual runtime helper output")
    table["auditedSplayMaximumErrorDeg"] = max(errors)
    return table


def frame(direction, hinge):
    x, z = direction.normalized(), hinge.normalized()
    return Matrix((x, z.cross(x).normalized(), z)).transposed()


def rotations_for_finger(nodes, names, palm, digit, angles, nominal_spread):
    a = Vector(nodes[names[f"{digit}_PIP"]]["translation"])
    b = Vector(nodes[names[f"{digit}_DIP"]]["translation"])
    c = Vector(nodes[names[f"{digit}_tip"]]["translation"])
    hinge_a, hinge_b = a.cross(b).normalized(), b.cross(c).normalized()
    if hinge_a.length < 0.5 or hinge_b.length < 0.5:
        raise ValueError(f"{digit} source has an undefined hinge")
    if hinge_b.dot(hinge_a) < 0:
        hinge_b.negate()
    mcp, pip, dip = map(math.radians, angles)
    # Exact definition of restingFingerPosture / restingFingerBaseRotation.
    spread = math.radians(ulnar_spread_deg(angles[0], nominal_spread[digit]))
    # Abduct in the extended palm plane first; flex around that digit's
    # radial hinge second. Deep flexion must not retain full lateral splay.
    along = palm @ Vector((-math.cos(mcp) * math.cos(spread), -math.sin(mcp), -math.cos(mcp) * math.sin(spread)))
    target_hinge = palm @ Vector((-math.sin(spread), 0, math.cos(spread)))
    base = (frame(along, target_hinge) @ frame(a, hinge_a).transposed()).to_quaternion()
    return [base, Quaternion(hinge_a, pip - signed_angle(a, b, hinge_a)),
            Quaternion(hinge_b, dip - signed_angle(b, c, hinge_b))], math.degrees(spread)


def thumb_rotations(nodes, names, palm, thumb_pose, abduction_delta):
    a = Vector(nodes[names["thumb_MCP"]]["translation"])
    b = Vector(nodes[names["thumb_IP"]]["translation"])
    c = Vector(nodes[names["thumb_tip"]]["translation"])
    hinge_a, hinge_b = a.cross(b).normalized(), b.cross(c).normalized()
    if hinge_b.dot(hinge_a) < 0:
        hinge_b.negate()
    if thumb_pose == "authored":
        return [Quaternion(palm @ Vector((0, 1, 0)), math.radians(abduction_delta)), Quaternion(), Quaternion()], None
    if abduction_delta:
        raise ValueError("The CMC delta override is for --thumb-pose authored only")
    # An independent inspection pose, rather than the source needle grip.
    # The metacarpal points radially and palmarly; its MCP/IP retain mild
    # positive flexion in the transported source plane. These are rig settings, not a
    # clinical model of the saddle joint's coupled arthrokinematics.
    radial, palmar, mcp, ip = (math.radians(THUMB_DIAGNOSTIC[key]) for key in
        ("metacarpalRadialBearingDeg", "metacarpalPalmarBearingDeg", "mcpFlexionDeg", "ipFlexionDeg"))
    along = palm @ Vector((-math.cos(palmar) * math.cos(radial), -math.sin(palmar), math.cos(palmar) * math.sin(radial)))
    # Unlike the four finger MCPs, the thumb saddle joint does not supply the
    # same palm-radial hinge. Transport its authored opposition plane by the
    # minimal CMC swing, retaining nail/pulp orientation without inserting an
    # arbitrary axial roll. Its two flexion hinges remain fixed to that plane.
    cmc = a.normalized().rotation_difference(along.normalized())
    return [cmc, Quaternion(hinge_a, mcp - signed_angle(a, b, hinge_a)),
            Quaternion(hinge_b, ip - signed_angle(b, c, hinge_b))], {
                **THUMB_DIAGNOSTIC, "flexionPlane": "Authored thumb opposition plane, parallel-transported by the minimal CMC swing"}


def inspect_pose(document, pose, physiology, thumb_pose="relaxed-abducted", thumb_abduction_deg=0):
    nodes = copy.deepcopy(document["nodes"])
    names = {node.get("name"): index for index, node in enumerate(nodes)}
    pose_frame = nodes[names["hand_pose_frame"]]
    pose_frame.pop("matrix", None)
    pose_frame.update(translation=[0, 0, 0], rotation=[0, 0, 0, 1], scale=[1, 1, 1])
    bind = world_matrices(nodes)
    palm = bind[names["palm_frame"]].to_3x3().normalized()
    thumb_controls, thumb_requested = thumb_rotations(nodes, names, palm, thumb_pose, thumb_abduction_deg)
    for joint, old, rotation in zip(("CMC", "MCP", "IP"), LEGACY, thumb_controls):
        result = rotation @ quat(nodes[names[f"thumb_{old}"]]).inverted()
        nodes[names[f"thumb_{joint}"]]["rotation"] = [result.x, result.y, result.z, result.w]
    spreads = {}
    for digit in DIGITS:
        rotations, spreads[digit] = rotations_for_finger(nodes, names, palm, digit, pose["jointsDeg"][digit],
                                                       {"index": 0, **physiology["nominalSpreadDeg"]})
        for joint, old, rotation in zip(JOINTS, LEGACY, rotations):
            node = nodes[names[f"{digit}_{joint}"]]
            if quat(node).angle > 1e-5:
                raise ValueError(f"Unexpected non-identity source anatomical overlay {digit}_{joint}")
            result = rotation @ quat(nodes[names[f"{digit}_{old}"]]).inverted()
            node["rotation"] = [result.x, result.y, result.z, result.w]
    posed = world_matrices(nodes)
    forward, volar, ulna = (palm @ Vector(vector) for vector in ((-1, 0, 0), (0, -1, 0), (0, 0, -1)))
    measured = {}
    for digit in DIGITS:
        node_ids = [names[f"{digit}_{joint}"] for joint in JOINTS] + [names[f"{digit}_tip"]]
        before = [bind[index].translation for index in node_ids]
        after = [posed[index].translation for index in node_ids]
        vectors = [after[index + 1] - after[index] for index in range(3)]
        direction = vectors[0].normalized()
        abduction = math.atan2(direction.dot(ulna), direction.dot(forward))
        hinge = palm @ Vector((-math.sin(abduction), 0, math.cos(abduction)))
        actual = [math.degrees(math.atan2(direction.dot(volar), math.hypot(direction.dot(forward), direction.dot(ulna)))),
                  math.degrees(signed_angle(vectors[0], vectors[1], hinge)),
                  math.degrees(signed_angle(vectors[1], vectors[2], hinge))]
        requested = list(pose["jointsDeg"][digit])
        lengths = [(after[index + 1] - after[index]).length for index in range(3)]
        source_lengths = [(before[index + 1] - before[index]).length for index in range(3)]
        measured[digit] = {
            "requestedMcpPipDipDeg": requested, "measuredMcpPipDipDeg": actual,
            "maximumAngleErrorDeg": max(abs(a - b) for a, b in zip(actual, requested)),
            "requestedUlnarSpreadDeg": spreads[digit],
            "measuredUlnarSpreadDeg": math.degrees(abduction),
            "sourceSegmentLengthsMm": [value * 1000 for value in source_lengths],
            "posedSegmentLengthsMm": [value * 1000 for value in lengths],
            "maximumBoneLengthErrorMm": max(abs(a - b) * 1000 for a, b in zip(lengths, source_lengths)),
            "jointPositionsM": [list(value) for value in after],
        }
    thumb_names = ["thumb_CMC", "thumb_MCP", "thumb_IP", "thumb_tip"]
    thumb_points = [posed[names[name]].translation for name in thumb_names]
    thumb_segments = [thumb_points[index + 1] - thumb_points[index] for index in range(3)]
    thumb_source_points = [bind[names[name]].translation for name in thumb_names]
    thumb_source_lengths = [(thumb_source_points[index + 1] - thumb_source_points[index]).length for index in range(3)]
    thumb_mc = palm.transposed() @ thumb_segments[0].normalized()
    thumb_source_hinge = (thumb_source_points[1] - thumb_source_points[0]).cross(thumb_source_points[2] - thumb_source_points[1]).normalized()
    thumb_hinge = thumb_controls[0] @ thumb_source_hinge
    thumb_joint_angles = [math.degrees(signed_angle(thumb_segments[index], thumb_segments[index + 1], thumb_hinge)) for index in range(2)]
    thumb_bearings = [math.degrees(math.atan2(thumb_mc.z, -thumb_mc.x)),
                      math.degrees(math.atan2(-thumb_mc.y, math.hypot(thumb_mc.x, thumb_mc.z)))]
    return nodes, posed, palm, {
        "name": pose["name"], "fingers": measured,
        "thumb": {"mode": thumb_pose, "requested": thumb_requested,
                  "sourceRelativeCmcRotationDeg": math.degrees(thumb_controls[0].angle),
                  "sourceRelativeCmcRotationQuaternionXYZW": [thumb_controls[0].x, thumb_controls[0].y, thumb_controls[0].z, thumb_controls[0].w],
                  "metacarpalDirectionInPalmFrame": list(thumb_mc),
                  "metacarpalGeometricRadialBearingDeg": thumb_bearings[0],
                  "metacarpalGeometricPalmarBearingDeg": thumb_bearings[1],
                  "bearingScope": "Geometric segment direction in the authored palm frame, not a measured clinical CMC angle",
                  "segmentLengthsMm": [value.length * 1000 for value in thumb_segments],
                  "sourceSegmentLengthsMm": [value * 1000 for value in thumb_source_lengths],
                  "maximumBoneLengthErrorMm": max(abs(value.length - source) * 1000 for value, source in zip(thumb_segments, thumb_source_lengths)),
                  "measuredMcpIpDeg": thumb_joint_angles,
                  "maximumAngleErrorDeg": max(abs(value - thumb_requested[key]) for value, key in zip(thumb_bearings + thumb_joint_angles,
                      ("metacarpalRadialBearingDeg", "metacarpalPalmarBearingDeg", "mcpFlexionDeg", "ipFlexionDeg"))) if thumb_requested else None,
                  "unsignedMcpIpDeg": [math.degrees(thumb_segments[index].angle(thumb_segments[index + 1])) for index in range(2)],
                  "jointPositionsM": [list(value) for value in thumb_points]},
    }


def deformed_meshes(document, binary, worlds):
    output = []
    for node_id, node in enumerate(document["nodes"]):
        if "mesh" not in node:
            continue
        world = worlds[node_id]
        skin = document["skins"][node["skin"]] if "skin" in node else None
        transforms = None
        if skin:
            ibms = [Matrix([value[row::4] for row in range(4)]) for value in accessor(document, binary, skin["inverseBindMatrices"])]
            transforms = [worlds[joint] @ inverse for joint, inverse in zip(skin["joints"], ibms)]
        for primitive in document["meshes"][node["mesh"]]["primitives"]:
            if primitive.get("mode", 4) != 4:
                raise ValueError("Only actual triangle primitives are accepted")
            attributes = primitive["attributes"]
            positions = accessor(document, binary, attributes["POSITION"])
            normals = accessor(document, binary, attributes["NORMAL"])
            uvs = accessor(document, binary, attributes["TEXCOORD_0"])
            vertices, actual_normals = [], []
            if skin:
                joints = accessor(document, binary, attributes["JOINTS_0"])
                weights = accessor(document, binary, attributes["WEIGHTS_0"])
                for position, normal, indices, blend in zip(positions, normals, joints, weights):
                    transform = sum((transforms[int(index)] * weight for index, weight in zip(indices, blend)), Matrix(((0, 0, 0, 0),) * 4))
                    vertices.append(transform @ Vector(position))
                    # The asset has rigid joint transforms. Blend their normal
                    # rotations exactly as the live three.js skinning shader.
                    actual_normals.append((transform.to_3x3() @ Vector(normal)).normalized())
            else:
                normal_matrix = world.to_3x3().inverted().transposed()
                vertices = [world @ Vector(value) for value in positions]
                actual_normals = [(normal_matrix @ Vector(value)).normalized() for value in normals]
            indices = [value[0] for value in accessor(document, binary, primitive["indices"])] if "indices" in primitive else list(range(len(vertices)))
            output.append({"name": node.get("name", "mesh"), "vertices": vertices, "normals": actual_normals,
                           "uvs": uvs, "faces": [indices[index:index + 3] for index in range(0, len(indices), 3)],
                           "material": primitive.get("material", 0)})
    return output


def boundary_intersections(meshes):
    """Finite actual-triangle boundary check, separate from angle/length checks.

    This is not a clinical clearance certification: it does not estimate depth,
    detect complete enclosure without crossing, or turn intended skin contact
    into a force measurement. Nails and a digit's own adjacent faces are not
    classified as inter-digit collisions.
    """
    skins = {value["name"]: value for value in meshes if value["name"] in {f"{digit}_skin" for digit in ("thumb", *DIGITS)}}
    palm = next(value for value in meshes if value["name"] == "palm_surface")
    palm_tree = BVHTree.FromPolygons(palm["vertices"], palm["faces"], all_triangles=True, epsilon=0.0)
    palm_low = Vector(tuple(min(value[index] for value in palm["vertices"]) for index in range(3)))
    palm_high = Vector(tuple(max(value[index] for value in palm["vertices"]) for index in range(3)))
    rays = [Vector(value).normalized() for value in ((0.73, 0.39, 0.56), (-0.27, 0.91, 0.31), (0.44, -0.33, 0.83))]
    def inside_palm(point):
        if any(point[index] < palm_low[index] or point[index] > palm_high[index] for index in range(3)):
            return False
        votes = 0
        for direction in rays:
            origin, hits = point.copy(), 0
            for _ in range(64):
                hit, _, face, _ = palm_tree.ray_cast(origin, direction, 1.0)
                if face is None:
                    break
                hits += 1
                origin = hit + direction * 1e-7
            else:
                raise ValueError("Palm parity ray did not terminate")
            votes += hits % 2
        return votes >= 2
    def crossing_points(before, after):
        found = []
        for edges, triangle in ((before, after), (after, before)):
            for index in range(3):
                start, end = edges[index], edges[(index + 1) % 3]
                delta = end - start
                if delta.length_squared < 1e-18:
                    continue
                hit = geometry.intersect_ray_tri(*triangle, delta, start, True)
                if hit is not None and -1e-6 <= (hit - start).dot(delta) / delta.length_squared <= 1 + 1e-6:
                    if not any((hit - value).length < 1e-7 for value in found):
                        found.append(hit)
        return found
    trees = {name: BVHTree.FromPolygons(value["vertices"], value["faces"], all_triangles=True, epsilon=0.0)
             for name, value in skins.items()}
    pairs = []
    for index, before in enumerate(skins):
        for after in list(skins)[index + 1:]:
            overlaps = trees[before].overlap(trees[after])
            exposed, buried, coplanar, samples = 0, 0, 0, []
            for left, right in overlaps:
                first = [skins[before]["vertices"][index] for index in skins[before]["faces"][left]]
                second = [skins[after]["vertices"][index] for index in skins[after]["faces"][right]]
                points = crossing_points(first, second)
                if not points:
                    coplanar += 1
                    continue
                # An intersection is a point or line segment. Sampling its ends
                # and three interior points retains crossings at a web exit.
                start, end = max(((a, b) for a in points for b in points), key=lambda pair: (pair[0] - pair[1]).length_squared)
                probes = [start.lerp(end, fraction) for fraction in (0, 0.25, 0.5, 0.75, 1)]
                outside = [point for point in probes if not inside_palm(point)]
                if outside:
                    exposed += 1
                    if len(samples) < 4:
                        samples.append({"triangleIndices": [left, right], "exposedIntersectionPointM": list(outside[len(outside) // 2])})
                else:
                    buried += 1
            pairs.append({"surfaces": [before, after], "rawOverlappingTrianglePairs": len(overlaps),
                          "exposedCrossingTrianglePairs": exposed, "buriedInPalmTrianglePairs": buried,
                          "unclassifiedCoplanarTrianglePairs": coplanar, "sampleExposedCrossings": samples})
    return {"method": "Actual posed skin triangles: BVHTree candidates, exact edge/triangle intersection points, five probes along intersection segments; palm enclosure uses three-direction majority parity. Boundary crossing audit only, no penetration-depth estimate.",
            "clear": not any(value["exposedCrossingTrianglePairs"] or value["unclassifiedCoplanarTrianglePairs"] for value in pairs), "pairs": pairs}


def thumb_root_morphology(source_meshes, posed_meshes, source_cmc, source_mcp):
    """Measure the identified metacarpal skin bridge, excluding both end caps.

    UV rings preserve material identity across poses. Source and deformed ring
    perimeters, centre spacing and geometric normals therefore expose a thin
    stretched bridge even when no separate skin surfaces cross. These numbers
    are reported without inventing a universal anatomical pass threshold.
    """
    source = next(value for value in source_meshes if value["name"] == "thumb_skin")
    posed = next(value for value in posed_meshes if value["name"] == "thumb_skin")
    axis = source_mcp - source_cmc
    def uv_key(value):
        u = round(value[0] % 1, 7)
        return (0.0 if u > 1 - 1e-6 else u, round(value[1], 7))
    keys = [uv_key(value) for value in source["uvs"]]
    grouped = {}
    for index, (u, v) in enumerate(keys):
        grouped.setdefault(v, {}).setdefault(u, index)
    rings = []
    for v, angles in sorted(grouped.items(), reverse=True):
        indices = [angles[u] for u in sorted(angles)]
        # Pole fans have one UV centre in addition to the perimeter. Only the
        # metacarpal root interval is selected below, far from either pole.
        before = [source["vertices"][index] for index in indices]
        after = [posed["vertices"][index] for index in indices]
        source_centre = sum(before, Vector()) / len(before)
        posed_centre = sum(after, Vector()) / len(after)
        perimeter = lambda points: sum((points[(index + 1) % len(points)] - value).length for index, value in enumerate(points))
        rings.append({"v": v, "indices": indices, "sourceCentre": source_centre,
                      "posedCentre": posed_centre, "sourcePerimeter": perimeter(before),
                      "posedPerimeter": perimeter(after),
                      "fraction": (source_centre - source_cmc).dot(axis) / axis.length_squared})
    edges = {}
    for face in source["faces"]:
        normals = []
        for mesh in (source, posed):
            a, b, c = (mesh["vertices"][index] for index in face)
            normal = (b - a).cross(c - a)
            normals.append(normal.normalized() if normal.length_squared > 1e-24 else None)
        for index, start in enumerate(face):
            end = face[(index + 1) % 3]
            if keys[start][1] == keys[end][1] and keys[start] != keys[end]:
                key = tuple(sorted((keys[start], keys[end])))
                edges.setdefault(key, []).append(normals)
    normal_angles = {}
    angle = lambda a, b: math.degrees(math.acos(max(-1, min(1, a.dot(b)))))
    for edge, faces in edges.items():
        if len(faces) != 2 or any(normal is None for face in faces for normal in face):
            continue
        normal_angles.setdefault(edge[0][1], []).append([
            angle(faces[0][0], faces[1][0]), angle(faces[0][1], faces[1][1])])
    selected, bands = [], []
    for index, ring in enumerate(rings):
        if not 0.55 <= ring["fraction"] <= 0.95:
            continue
        normals = normal_angles.get(ring["v"], [])
        source_turn = posed_turn = None
        if 0 < index < len(rings) - 1:
            source_turn = angle((ring["sourceCentre"] - rings[index - 1]["sourceCentre"]).normalized(),
                                (rings[index + 1]["sourceCentre"] - ring["sourceCentre"]).normalized())
            posed_turn = angle((ring["posedCentre"] - rings[index - 1]["posedCentre"]).normalized(),
                               (rings[index + 1]["posedCentre"] - ring["posedCentre"]).normalized())
        selected.append({
            "uvV": ring["v"], "sourceMetacarpalProjectionFraction": ring["fraction"],
            "vertexIndices": ring["indices"], "sourceCentreM": list(ring["sourceCentre"]),
            "posedCentreM": list(ring["posedCentre"]),
            "sourcePerimeterMm": ring["sourcePerimeter"] * 1000,
            "posedPerimeterMm": ring["posedPerimeter"] * 1000,
            "perimeterRetention": ring["posedPerimeter"] / ring["sourcePerimeter"],
            "sourceCentrelineTurnDeg": source_turn, "posedCentrelineTurnDeg": posed_turn,
            "sourceAdjacentBandNormalMaxDeg": max((value[0] for value in normals), default=None),
            "posedAdjacentBandNormalMaxDeg": max((value[1] for value in normals), default=None),
            "adjacentBandNormalIncreaseMaxDeg": max((value[1] - value[0] for value in normals), default=None),
        })
        if index + 1 < len(rings) and 0.55 <= rings[index + 1]["fraction"] <= 0.95:
            other = rings[index + 1]
            before = (other["sourceCentre"] - ring["sourceCentre"]).length
            after = (other["posedCentre"] - ring["posedCentre"]).length
            bands.append({"uvV": [ring["v"], other["v"]],
                          "sourceCentreSpacingMm": before * 1000, "posedCentreSpacingMm": after * 1000,
                          "centreSpacingStretch": after / before})
    if not selected or not bands:
        raise ValueError("No metacarpal thumb-root material rings found")
    return {
        "surface": "thumb_skin", "region": "Material UV rings whose source centres project onto metacarpal fractions 0.55..0.95; closed pole caps excluded",
        "method": "Unique UV ring vertices in longitudinal order; closed 3D perimeter, source/posed ring-centre spacing and actual triangle-normal changes across shared transverse ring edges",
        "minimumPerimeterRetention": min(value["perimeterRetention"] for value in selected),
        "maximumCentreSpacingStretch": max(value["centreSpacingStretch"] for value in bands),
        "maximumAdjacentBandNormalIncreaseDeg": max(value["adjacentBandNormalIncreaseMaxDeg"] for value in selected if value["adjacentBandNormalIncreaseMaxDeg"] is not None),
        "rings": selected, "bands": bands,
        "scope": "Morphology measurements for the identified root bridge; not a global triangle-aspect threshold or an anatomical/clinical certification",
    }


def flat_material(name, color):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output, emission = nodes.new("ShaderNodeOutputMaterial"), nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = (*color, 1)
    material.node_tree.links.new(emission.outputs[0], output.inputs["Surface"])
    return material


def text(label, at, size, material, align="LEFT"):
    curve = bpy.data.curves.new(label, "FONT")
    curve.body, curve.align_x, curve.size = label, align, size
    curve.extrude = 0
    ob = bpy.data.objects.new(label, curve)
    bpy.context.collection.objects.link(ob)
    ob.location = at
    ob.data.materials.append(material)
    return ob


def render(document, asset, rows, output, size, samples, asset_sha):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # The import is solely the real asset's material/embedded-texture decoder.
    # Mesh positions below come directly from its original glTF accessors.
    bpy.ops.import_scene.gltf(filepath=str(asset))
    materials = [bpy.data.materials.get(value.get("name", "")) for value in document["materials"]]
    if any(material is None for material in materials):
        raise ValueError("Blender did not preserve the actual GLB material names")
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.eevee.taa_render_samples = samples
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    scene.world = bpy.data.worlds.new("Audit studio")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.80, 0.84, 0.89, 1)
    scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.8
    ink = flat_material("Audit ink", (0.025, 0.035, 0.05))
    grey = flat_material("Audit note", (0.09, 0.12, 0.16))
    spacing = 0.252
    bounds = [vertex for row in rows for mesh in row["meshes"] for vertex in mesh["vertices"]]
    # Shared palm-space centre and scale keep proportions comparable in all nine cells.
    palm = rows[0]["palm"]
    local = [palm.transposed() @ value for value in bounds]
    low = Vector(tuple(min(value[index] for value in local) for index in range(3)))
    high = Vector(tuple(max(value[index] for value in local) for index in range(3)))
    centre = palm @ ((low + high) / 2)
    scale = min(1.08, 0.219 / max((high - low).length, 0.001))
    view_names = ("PALMAR", "DORSAL", "RADIAL SIDE")
    forward, volar, radial = (palm @ Vector(value) for value in ((-1, 0, 0), (0, -1, 0), (0, 0, 1)))
    views = [(radial, forward, volar), (-radial, forward, -volar), (-volar, forward, radial)]
    text("ACTUAL GLB  /  FIXED-LENGTH FINGER FLEXION AUDIT", (-0.375, 0.407, 0.12), 0.015, ink)
    thumb_label = "relaxed abducted thumb" if rows[0]["report"]["thumb"]["mode"] == "relaxed-abducted" else "independent authored thumb"
    text(f"Four-finger flexion + {thumb_label}. Geometric rig inspection; not clinical ROM or a needle-contact pose.", (-0.375, 0.387, 0.12), 0.0084, grey)
    for column, name in enumerate(view_names):
        text(name, ((column - 1) * spacing, 0.362, 0.12), 0.012, ink, "CENTER")
    for row_index, row in enumerate(rows):
        y = 0.225 - row_index * spacing
        for column, axes in enumerate(views):
            x = (column - 1) * spacing
            view = Matrix(axes)
            for source in row["meshes"]:
                vertices = [view @ (value - centre) * scale + Vector((x, y, 0)) for value in source["vertices"]]
                normals = [view @ value for value in source["normals"]]
                mesh = bpy.data.meshes.new(source["name"])
                mesh.from_pydata(vertices, [], source["faces"])
                mesh.update()
                uv = mesh.uv_layers.new(name="TEXCOORD_0")
                for loop in mesh.loops:
                    value = source["uvs"][loop.vertex_index]
                    uv.data[loop.index].uv = (value[0], 1 - value[1])
                for face in mesh.polygons:
                    face.use_smooth = True
                mesh.normals_split_custom_set_from_vertices(normals)
                ob = bpy.data.objects.new(f"{row_index}_{column}_{source['name']}", mesh)
                bpy.context.collection.objects.link(ob)
                ob.data.materials.append(materials[source["material"]])
            label = row["report"]["name"].upper()
            text(label, (x, y - 0.116, 0.12), 0.011, ink, "CENTER")
            angles = row["report"]["fingers"]
            for line, digits in enumerate((("index", "middle"), ("ring", "little"))):
                value = "  ".join(f"{digit[0].upper()}:" + "/".join(str(round(number)) for number in angles[digit]["requestedMcpPipDipDeg"]) for digit in digits)
                text(value, (x, y - 0.130 - line * 0.010, 0.12), 0.0076, grey, "CENTER")
    if any(not row["report"]["interDigitBoundaryIntersections"]["clear"] for row in rows):
        affected = sorted({"/".join(name[0].upper() for name in pair["surfaces"])
                           for row in rows for pair in row["report"]["interDigitBoundaryIntersections"]["pairs"]
                           if pair["exposedCrossingTrianglePairs"] or pair["unclassifiedCoplanarTrianglePairs"]})
        text(f"LIMITATION: diagnostic skin boundary overlap/contact remains ({', '.join(affected)}). Not a collision-free holding-pose proof.", (-0.375, -0.440, 0.12), 0.0084, ink)
    text("Angles: MCP/PIP/DIP degrees; flexion-dependent splay. Same actual mesh, normals, scale, fixed bones and glTF skinning.", (-0.375, -0.455, 0.12), 0.0078, grey)
    text(f"GLB SHA256 {asset_sha[:32]}...  |  tools/blender/render_hand_audit.py", (-0.375, -0.469, 0.12), 0.0076, grey)
    camera_data = bpy.data.cameras.new("Audit orthographic camera")
    camera = bpy.data.objects.new("Audit orthographic camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (0, -0.026, 1)
    camera.rotation_euler = (0, 0, 0)
    camera_data.type, camera_data.ortho_scale = "ORTHO", 0.94
    scene.camera = camera
    # A large distant studio source gives all nine actual meshes the same
    # illumination without a different lighting rig exaggerating each view.
    lamp_data = bpy.data.lights.new("Broad studio key", "AREA")
    lamp_data.energy, lamp_data.shape, lamp_data.size = 80, "DISK", 2.0
    lamp = bpy.data.objects.new("Broad studio key", lamp_data)
    bpy.context.collection.objects.link(lamp)
    lamp.location = (-0.45, 0.55, 1.0)
    lamp.rotation_euler = (Vector((0, 0, 0)) - lamp.location).to_track_quat("-Z", "Y").to_euler()
    output.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(output)
    bpy.ops.render.render(write_still=True)


def main():
    args = arguments()
    raw, document, binary = glb(args.asset)
    asset_sha = hashlib.sha256(raw).hexdigest()
    if args.expected_asset_sha256 and asset_sha != args.expected_asset_sha256.lower():
        raise ValueError(f"Wrong asset: expected {args.expected_asset_sha256}, read {asset_sha}")
    physiology = runtime_physiology(args.physiology_table)
    poses = json.loads(args.pose_spec.read_text()) if args.pose_spec else copy.deepcopy(POSES)
    if not args.pose_spec:
        poses[2]["jointsDeg"].update(physiology["angles"]["curled"])
    if len(poses) != 3:
        raise ValueError("The audit requires exactly three inspection poses")
    rows = []
    source_worlds = world_matrices(document["nodes"])
    source_meshes = deformed_meshes(document, binary, source_worlds)
    source_names = {node.get("name"): index for index, node in enumerate(document["nodes"])}
    for pose in poses:
        _, worlds, palm, report = inspect_pose(document, pose, physiology, args.thumb_pose, args.thumb_cmc_abduction_deg)
        meshes = deformed_meshes(document, binary, worlds)
        report["interDigitBoundaryIntersections"] = boundary_intersections(meshes)
        report["thumbRootMorphology"] = thumb_root_morphology(source_meshes, meshes,
            source_worlds[source_names["thumb_CMC"]].translation,
            source_worlds[source_names["thumb_MCP"]].translation)
        rows.append({"palm": palm, "report": report, "meshes": meshes})
    report = {
        "asset": str(args.asset.resolve()), "assetSha256": asset_sha,
        "assetBytes": len(raw), "script": str(Path(__file__).resolve()),
        "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "method": "Actual GLB accessors and standard LBS; fixed-length anatomical hinges in palm_frame; no clip interpolation, no mesh modifiers",
        "scope": "Four-finger deformation inspection with an independent named thumb pose. The third row reads the authored closed-fist M/R/L curled table; the index 52/72/42-degree example is an independent rig probe, not the operator's actual working index. Actual thumb bearings and source-relative rotations are reported separately. Runtime needle-grip solutions require their own UI checks. These are not neutral/comfort or clinical ROM measurements.",
        "runtimePhysiology": physiology,
        "spreadEnvelope": {"formula": "nominal*(0.2+0.8*cos(MCP)^2)", "nominalUlnarDeg": {"index": 0, **physiology["nominalSpreadDeg"]}},
        "maximumAngleErrorDeg": max([finger["maximumAngleErrorDeg"] for row in rows for finger in row["report"]["fingers"].values()] + [row["report"]["thumb"]["maximumAngleErrorDeg"] or 0 for row in rows]),
        "maximumBoneLengthErrorMm": max([finger["maximumBoneLengthErrorMm"] for row in rows for finger in row["report"]["fingers"].values()] + [row["report"]["thumb"]["maximumBoneLengthErrorMm"] for row in rows]),
        "poses": [row["report"] for row in rows],
        "diagnosticBoundaryClear": all(row["report"]["interDigitBoundaryIntersections"]["clear"] for row in rows),
        "boundarySummary": [{"pose": row["report"]["name"], **{
            key: sum(pair[key] for pair in row["report"]["interDigitBoundaryIntersections"]["pairs"])
            for key in ("rawOverlappingTrianglePairs", "exposedCrossingTrianglePairs", "buriedInPalmTrianglePairs", "unclassifiedCoplanarTrianglePairs")}} for row in rows],
        "diagnosticLimitations": "The independent free-hand probes can retain skin-boundary crossings/contacts; see the actual affected surfaces, poses, counts and intersection points. Palm-enclosed intersections are reported separately using the actual posed palm union and three-direction parity. This diagnostic is not evidence of a natural collision-free grip; public runtime grip poses are verified separately.",
        "render": None if args.no_render else {"path": str(args.output.resolve()), "resolution": [args.size, args.size], "engine": "Blender EEVEE", "samples": args.samples},
    }
    if report["maximumAngleErrorDeg"] > 0.02 or report["maximumBoneLengthErrorMm"] > 0.01:
        raise ValueError(f"Hinge or fixed-length audit failed: {report['maximumAngleErrorDeg']} degrees, {report['maximumBoneLengthErrorMm']} mm")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    if not args.no_render:
        render(document, args.asset, rows, args.output, args.size, args.samples, report["assetSha256"])
        report["render"]["sha256"] = hashlib.sha256(args.output.read_bytes()).hexdigest()
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ("assetSha256", "maximumAngleErrorDeg", "maximumBoneLengthErrorMm", "diagnosticBoundaryClear", "boundarySummary", "render")}))


if __name__ == "__main__":
    main()
