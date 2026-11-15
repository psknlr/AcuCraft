"""Build the articulated hand used by the encounter's precision grip.

    blender -b -P tools/blender/build_hand.py

No downloaded model, add-on, or ClinicalCraft checkout is needed. Coordinates are
already glTF's metre/Y-up frame: +Y follows the needle and +X runs from the pinch
to the wrist. Export without Blender's usual Z-up conversion for that reason.
The neutral pose pinches a 1.4 mm visualization of a needle at the origin. It is a
schematic animation asset, not an anatomical or clinical reference.
"""
from __future__ import annotations

import hashlib
import json
import math
import struct
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "content/world/assets/models/acu-practitioner-hand.glb"
MANIFEST = Path(__file__).with_name("hand.json")
DIGITS = {
    "thumb": [(0.087, 0.000, -0.031), (0.055, 0.008, -0.02221), (0.022, 0.006, -0.01314), (-0.004, 0.000, -0.006)],
    "index": [(0.067, 0.003, 0.027), (0.037, 0.0112, 0.01812676056), (0.0135, 0.0077, 0.01117605634), (-0.004, 0.000, 0.006)],
    "middle": [(0.065, 0.001, 0.007), (0.037, -0.017, 0.007), (0.034, -0.041, 0.007), (0.048, -0.053, 0.007)],
    "ring": [(0.068, 0.000, -0.013), (0.044, -0.018, -0.013), (0.044, -0.040, -0.013), (0.059, -0.049, -0.013)],
    "little": [(0.076, -0.002, -0.031), (0.055, -0.019, -0.031), (0.057, -0.037, -0.031), (0.071, -0.045, -0.031)],
}
JOINTS = ("proximal", "middle", "distal")
ANATOMICAL = {digit: ("CMC", "MCP", "IP") if digit == "thumb" else ("MCP", "PIP", "DIP") for digit in DIGITS}
SKIN_WEIGHTS = {}


def empty(name: str, parent=None, at=(0, 0, 0), normal=None):
    ob = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(ob)
    ob.parent = parent
    ob.location = at
    if normal is not None:
        ob.rotation_mode = "QUATERNION"
        ob.rotation_quaternion = Vector((0, 1, 0)).rotation_difference(Vector(normal).normalized())
    return ob


def material(name: str, color, roughness=0.62):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    return mat


def mesh(name: str, vertices, faces, mat, parent):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.materials.append(mat)
    data.update()
    ob = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(ob)
    ob.parent = parent
    for poly in data.polygons:
        poly.use_smooth = True
    return ob


def ellipsoid(name, centre, radii, mat, parent, segments=12, rings=6, axis=None, dorsal=None):
    """A small closed, smooth mesh; axis is the direction of its long (+X) axis."""
    basis = Vector((1, 0, 0)).rotation_difference(Vector(axis).normalized()) if axis else None
    if axis is not None and dorsal is not None:
        x = Vector(axis).normalized()
        y = Vector(dorsal) - x * Vector(dorsal).dot(x)
        y.normalize()
        basis = Matrix((x, y, x.cross(y))).transposed()
    vertices = []
    for j in range(rings + 1):
        a = math.pi * j / rings
        for i in range(segments):
            b = 2 * math.pi * i / segments
            p = Vector((radii[0] * math.cos(a), radii[1] * math.sin(a) * math.cos(b), radii[2] * math.sin(a) * math.sin(b)))
            if basis:
                p = basis @ p
            vertices.append(tuple(p + Vector(centre)))
    faces = []
    for j in range(rings):
        for i in range(segments):
            nxt = (i + 1) % segments
            a, b = j * segments + i, j * segments + nxt
            c, d = (j + 1) * segments + nxt, (j + 1) * segments + i
            if j == 0:
                faces.append((a, d, c))
            elif j == rings - 1:
                faces.append((a, d, b))
            else:
                faces.append((a, d, c, b))
    return mesh(name, vertices, faces, mat, parent)


def smoothstep(value):
    t = min(1, max(0, value))
    return t * t * (3 - 2 * t)


def continuous_finger(digit, mat, parent):
    """One closed deforming surface per digit, without independent joint balls.

    Adjacent joints share vertices through a short weight transition. The entire
    contact-bearing terminal half of a distal phalanx remains rigidly attached
    to its distal control, retaining exact pad and nail contact geometry.
    """
    points = [Vector(p) for p in DIGITS[digit]]
    lengths = [(points[i + 1] - points[i]).length for i in range(3)]
    cumulative = [0, lengths[0], lengths[0] + lengths[1]]
    radius = {"thumb": 0.0102, "index": 0.0080, "middle": 0.0084, "ring": 0.0078, "little": 0.0065}[digit]
    precision = digit in ("thumb", "index")
    toward_gap = Vector((0, 0, 1 if digit == "thumb" else -1)) if precision else Vector((0, -1, 0))
    directions = [(points[i + 1] - points[i]).normalized() for i in range(3)]
    tangents = [directions[0], (directions[0] + directions[1]).normalized(), (directions[1] + directions[2]).normalized(), directions[2]]
    sections = []
    # The first thumb segment is a metacarpal, broad and merged into the thenar
    # mass, not a third exposed phalanx with its own spherical knuckle.
    for segment in range(3):
        length = lengths[segment]
        cap_start = 1 - 0.004 / length
        samples = [0, 0.12, 0.28, 0.46, 0.64, 0.82] if segment < 2 else [0, 0.10, 0.26, 0.43, min(0.61, cap_start * 0.82), cap_start] + [cap_start + 0.0065 / length * math.sin(angle) for angle in (0.25, 0.50, 0.75, 1.00, 1.25, 1.48)]
        for t in sorted(set(samples)):
            # Keep the distal centreline straight so its exact moving contact
            # is represented by the same frame as the runtime contact solver.
            if segment == 2:
                if precision:
                    pad_centre = Vector((0, 0, -0.006 if digit == "thumb" else 0.006))
                    q = t / cap_start
                    terminal = Vector((-1, 0, 0))
                    if q <= 1:
                        a, b = points[2], pad_centre
                        span = (b - a).length
                        h00, h10, h01, h11 = 2*q**3 - 3*q*q + 1, q**3 - 2*q*q + q, -2*q**3 + 3*q*q, q**3 - q*q
                        centre = a*h00 + directions[2]*(span*h10) + b*h01 + terminal*(span*h11)
                        tangent = (a*(6*q*q - 6*q) + directions[2]*(span*(3*q*q - 4*q + 1)) + b*(-6*q*q + 6*q) + terminal*(span*(3*q*q - 2*q))).normalized()
                    else:
                        centre = pad_centre + terminal * ((t - cap_start) * length)
                        tangent = terminal
                else:
                    centre = points[2] + directions[2] * (length * t)
                    tangent = directions[2]
            else:
                a, b = points[segment], points[segment + 1]
                h00, h10, h01, h11 = 2*t**3 - 3*t*t + 1, t**3 - 2*t*t + t, -2*t**3 + 3*t*t, t**3 - t*t
                centre = a*h00 + tangents[segment]*(length*h10) + b*h01 + tangents[segment + 1]*(length*h11)
                tangent = (a*(6*t*t - 6*t) + tangents[segment]*(length*(3*t*t - 4*t + 1)) + b*(-6*t*t + 6*t) + tangents[segment + 1]*(length*(3*t*t - 2*t))).normalized()
            # A gradual opposition twist connects the palm frame to the pad
            # frame, rather than placing both nails on the same global side.
            if precision:
                twist = smoothstep((segment + min(t, 1)) / 2)
                normal = Vector((0, -1, 0)).lerp(toward_gap, twist)
                normal -= tangent * normal.dot(tangent)
                normal.normalize()
                width = tangent.cross(normal).normalized()
            else:
                # Transport the lateral axis through palmar flexion. Projecting
                # a fixed palmar -Y normal at every ring flips the frame when a
                # curled finger points along -Y, creating a false narrow neck.
                width = Vector((0, 0, 1))
                width -= tangent * width.dot(tangent)
                width.normalize()
                normal = width.cross(tangent).normalized()
            along = cumulative[segment] + t * length
            if segment == 2:
                # Broad nail bed and fleshy pad, with a softly rounded cap.
                q = max(0, min(1, t))
                half_width = radius * 0.75 * (1 - 0.13*q)
                half_depth = 0.0058 if precision else radius * 0.73
                if t >= cap_start:
                    cap = min(1, max(0, (t - cap_start) * length / 0.0065))
                    rounding = math.sqrt(max(0, 1 - cap * cap))
                    half_width = radius * 0.75 * (1 - 0.13*cap_start) * rounding
                    if digit == "middle":
                        # Real soft side pulp at the distal pad supports the
                        # narrower handle 6 mm below the main thumb/index grip.
                        half_width = 0.0063096 * rounding
                    half_depth = (0.0053 if precision else radius * 0.73) * rounding
            else:
                taper = 1 - 0.13 * (segment + t)
                half_width = radius * taper
                half_depth = radius * (0.78 if digit == "thumb" else 0.74) * taper
                # A small joint contour, rather than a separate bead-shaped
                # knuckle, preserves the natural continuous finger silhouette.
                half_depth += 0.00035 * sum(math.exp(-((along - joint) / 0.004) ** 2) for joint in cumulative[1:])
                if digit == "thumb" and segment == 0:
                    half_width *= 1.25 - 0.18*t
                    half_depth *= 1.13
            blend1 = smoothstep((along - cumulative[1] + min(lengths[:2]) * 0.19) / (min(lengths[:2]) * 0.38))
            blend2 = smoothstep((along - cumulative[2] + min(lengths[1:]) * 0.17) / (min(lengths[1:]) * 0.34))
            weights = (1 - blend1, blend1 - blend2, blend2)
            sections.append((centre, normal, width, half_width, half_depth, weights))
    segments = 20
    vertices, weights = [], []
    for centre, normal, width, half_width, half_depth, weighting in sections:
        for i in range(segments):
            angle = 2 * math.pi * i / segments
            vertices.append(tuple(centre + width * (half_width * math.sin(angle)) + normal * (half_depth * math.cos(angle))))
            weights.append(weighting)
    faces = []
    for ring in range(len(sections) - 1):
        for i in range(segments):
            a, b = ring * segments + i, ring * segments + (i + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    faces.append(tuple(reversed(range(segments))))
    faces.append(tuple((len(sections) - 1) * segments + i for i in range(segments)))
    ob = mesh(f"{digit}_skin", vertices, faces, mat, parent)
    SKIN_WEIGHTS[ob.name] = (digit, vertices, weights)
    return ob


def palm(root, skin):
    # A lozenge cross section following the thenar mass, knuckles and wrist.
    sections = [
        (0.056, 0.000, 0.000, 0.009, 0.022),
        (0.066, 0.000, 0.000, 0.013, 0.038),
        (0.082, 0.002, -0.001, 0.014, 0.041),
        (0.105, 0.003, -0.002, 0.015, 0.040),
        (0.126, 0.004, -0.001, 0.013, 0.032),
        (0.144, 0.004, 0.000, 0.011, 0.025),
        (0.165, 0.004, 0.000, 0.010, 0.024),
    ]
    vertices = []
    n = 20
    for x, y, z, ry, rz in sections:
        for i in range(n):
            a = 2 * math.pi * i / n
            vertices.append((x, y + ry * math.cos(a), z + rz * math.sin(a)))
    faces = []
    for j in range(len(sections) - 1):
        for i in range(n):
            a, b = j * n + i, j * n + (i + 1) % n
            faces.append((a, b, b + n, a + n))
    faces.append(tuple(reversed(range(n))))
    faces.append(tuple((len(sections) - 1) * n + i for i in range(n)))
    mesh("palm_surface", vertices, faces, skin, root)
    # A broad thenar mound covers the first metacarpal rather than exposing it
    # as an extra finger segment. The visible thumb has two phalanges.
    ellipsoid("thenar", (0.085, -0.005, -0.024), (0.035, 0.014, 0.025), skin, root, segments=24, rings=12)


def surface_anchor(name, parent, surface, target):
    """Place a moving attachment on the actual mesh, with +Y along its outward normal."""
    bpy.context.view_layer.update()
    transform = parent.matrix_world.inverted() @ surface.matrix_world
    vertices = [transform @ v.co for v in surface.data.vertices]
    faces = [list(p.vertices) for p in surface.data.polygons]
    tree = BVHTree.FromPolygons(vertices, faces)
    point, normal, _, _ = tree.find_nearest(Vector(target))
    anchor = empty(name, parent, point, normal)
    anchor["surface"] = surface.name
    return anchor


def nail_plate(name, parent, skin_surface, centre, dorsal, axis, half_length, half_width, mat):
    """A thin curved nail fitted to the actual distal skin, with a free edge.

    Unlike a floating flattened ellipsoid, its perimeter follows the underlying
    skin. The returned contact is on the distal nail edge, where scraping and
    flicking make contact, rather than at the middle of the nail bed.
    """
    bpy.context.view_layer.update()
    transform = parent.matrix_world.inverted() @ skin_surface.matrix_world
    tree = BVHTree.FromPolygons([transform @ v.co for v in skin_surface.data.vertices], [list(p.vertices) for p in skin_surface.data.polygons])
    n = Vector(dorsal).normalized()
    u = Vector(axis) - n * Vector(axis).dot(n)
    u.normalize()
    v = n.cross(u).normalized()
    steps = 24
    rings = (0.25, 0.50, 0.75, 0.94, 1.0)
    points = [(0, 0)] + [(r, 2 * math.pi * i / steps) for r in rings for i in range(steps)]
    centre_hit, _, _, _ = tree.ray_cast(Vector(centre) + n * 0.025, -n, 0.05)
    if centre_hit is None:
        centre_hit, _, _, _ = tree.find_nearest(Vector(centre))
    bed_height = centre_hit.dot(n)
    top, bottom = [], []
    for radius, angle in points:
        plane = Vector(centre) + u * (half_length * radius * math.cos(angle)) + v * (half_width * radius * math.sin(angle))
        hit, _, _, _ = tree.ray_cast(plane + n * 0.025, -n, 0.05)
        if hit is None:
            hit, _, _, _ = tree.find_nearest(plane)
        # A rigid nail's free edge continues the dorsal nail-bed tangent. It
        # must not wrap down the soft fingertip like another piece of skin.
        free_edge = smoothstep((radius * math.cos(angle) - 0.45) / 0.22)
        height = hit.dot(n) * (1 - free_edge) + bed_height * free_edge
        hit = plane + n * (height - plane.dot(n))
        top.append(tuple(hit + n * (0.00006 + 0.00012 * (1 - radius*radius))))
        bottom.append(tuple(hit + n * 0.00002))
    faces = [(0, 1 + i, 1 + (i + 1) % steps) for i in range(steps)]
    for ring in range(len(rings) - 1):
        for i in range(steps):
            a, b = 1 + ring * steps + i, 1 + ring * steps + (i + 1) % steps
            faces.append((a, a + steps, b + steps, b))
    upper_faces = len(faces)
    count = len(top)
    faces += [tuple(index + count for index in reversed(face)) for face in list(faces)]
    boundary = 1 + (len(rings) - 1) * steps
    for i in range(steps):
        a, b = boundary + i, boundary + (i + 1) % steps
        faces.append((a, a + count, b + count, b))
    ob = mesh(name, top + bottom, faces, mat, parent)
    edge = 1 + 3 * steps  # radius .94, distal free edge, just inside the thin rim
    smooth_normal = Vector()
    for polygon in ob.data.polygons[:upper_faces]:
        if edge in polygon.vertices:
            smooth_normal += polygon.normal * polygon.area
    if smooth_normal.length < 1e-9:
        smooth_normal = n
    return ob, Vector(top[edge]), smooth_normal.normalized()


def align_contact(axis, normal, target_axis, target_normal):
    """Rigid orientation mapping a bone axis and contact-normal plane to their requested frame."""
    def basis(a, n):
        x = Vector(a).normalized()
        y = Vector(n) - x * Vector(n).dot(x)
        if y.length < 1e-7:
            y = Vector((0, 0, 1)) - x * x.z
        y.normalize()
        z = x.cross(y).normalized()
        return Matrix((x, y, z)).transposed()
    return (basis(target_axis, target_normal) @ basis(axis, normal).transposed()).to_quaternion()


def chain_rotations(digit, directions, terminal=None):
    """Compute parent-local joint rotations while retaining every phalanx length."""
    points = [Vector(p) for p in DIGITS[digit]]
    parent = Quaternion()
    out = []
    for i, direction in enumerate(directions):
        inherited = parent @ (points[i + 1] - points[i])
        world = terminal if i == 2 and terminal is not None else inherited.rotation_difference(Vector(direction).normalized()) @ parent
        # Carry the parent's frame through the chain, adding only the minimum
        # swing required by this joint. Independent world rotations introduce
        # unrelated axial rolls and twist a continuous skin when it unfolds.
        local = parent.inverted() @ world
        out.append(local)
        parent = parent @ local
    return out


def contact_pose(digit, attachment, target, direction, outward):
    """Three-joint pose placing a real pad/nail anchor at a target with a specified distal direction."""
    points = [Vector(p) for p in DIGITS[digit]]
    delta = points[3] - points[2]
    local_normal = attachment.rotation_quaternion @ Vector((0, 1, 0))
    terminal = align_contact(delta, local_normal, direction, outward)
    end = Vector(target) - terminal @ attachment.location
    root = points[0]
    lengths = [(points[i + 1] - points[i]).length for i in range(3)]
    vector = end - root
    distance = vector.length
    lo, hi = abs(lengths[0] - lengths[1]) + 1e-6, lengths[0] + lengths[1] - 1e-6
    if not lo <= distance <= hi:
        raise ValueError(f"{digit} contact target outside proximal chain: {distance:.5f} not in [{lo:.5f}, {hi:.5f}]")
    axis = vector.normalized()
    along = (lengths[0] ** 2 - lengths[1] ** 2 + distance ** 2) / (2 * distance)
    height = math.sqrt(max(0, lengths[0] ** 2 - along ** 2))
    pole = Vector((0, -1, 0))
    pole -= axis * pole.dot(axis)
    if pole.length < 1e-6:
        pole = Vector((0, 0, 1)) - axis * axis.z
    pole.normalize()
    mid = root + axis * along + pole * height
    return chain_rotations(digit, [mid - root, end - mid, direction], terminal)


def add_clip(name, nodes, frames):
    """Bake independent named NLA tracks; every clip has a neutral frame at zero seconds."""
    for digit in DIGITS:
        for i, joint in enumerate(JOINTS):
            node = nodes[f"{digit}_{joint}"]
            node.rotation_mode = "QUATERNION"
            for frame, pose in frames:
                node.rotation_quaternion = pose[digit][i]
                node.keyframe_insert(data_path="rotation_quaternion", frame=frame, group=node.name)
            action = node.animation_data.action
            action.name = f"{node.name}_{name}"
            track = node.animation_data.nla_tracks.new()
            track.name = name
            track.strips.new(name, 1, action)
            node.animation_data.action = None


def pose_points(anchors):
    bpy.context.view_layer.update()
    return {name: [round(v, 9) for v in node.matrix_world.translation] for name, node in anchors.items()}


def bind_continuous_skins():
    """Bind the exported continuous meshes to the existing animated controls.

    glTF permits ordinary transform nodes as skin joints. Using those exact
    nodes preserves both the authored clips and runtime anatomical overlays;
    no separate armature or per-frame copying of bone transforms is needed.
    Blender supplies all geometry and animation. This deterministic export step
    adds only standard glTF JOINTS_0, WEIGHTS_0 and inverse bind matrices.
    """
    raw = OUT.read_bytes()
    json_length = struct.unpack_from("<I", raw, 12)[0]
    gltf = json.loads(raw[20:20 + json_length])
    binary_header = 20 + json_length
    binary_length = struct.unpack_from("<I", raw, binary_header)[0]
    binary = bytearray(raw[binary_header + 8:binary_header + 8 + binary_length])
    nodes = {node.get("name"): i for i, node in enumerate(gltf["nodes"])}
    joint_names = [f"{digit}_{joint}" for digit in DIGITS for joint in JOINTS]

    def append_accessor(payload, component_type, kind, count):
        while len(binary) % 4:
            binary.append(0)
        offset = len(binary)
        binary.extend(payload)
        view = len(gltf["bufferViews"])
        gltf["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(payload)})
        accessor = len(gltf["accessors"])
        gltf["accessors"].append({"bufferView": view, "componentType": component_type, "count": count, "type": kind})
        return accessor

    inverse_binds = []
    for digit in DIGITS:
        for i, joint in enumerate(JOINTS):
            node = gltf["nodes"][nodes[f"{digit}_{joint}"]]
            if any(abs(value - expected) > 1e-6 for value, expected in zip(node.get("rotation", [0, 0, 0, 1]), [0, 0, 0, 1])):
                raise ValueError("Skin bind export must occur in the neutral rest pose")
            matrix = Matrix.Translation(-Vector(DIGITS[digit][i]))
            inverse_binds.extend(matrix[row][column] for column in range(4) for row in range(4))
    ibm_accessor = append_accessor(struct.pack(f"<{len(inverse_binds)}f", *inverse_binds), 5126, "MAT4", len(joint_names))
    gltf["skins"] = [{"name": "continuous_hand_skin", "joints": [nodes[name] for name in joint_names], "inverseBindMatrices": ibm_accessor, "skeleton": nodes["acu_practitioner_hand"]}]
    skin_meshes = set()
    for mesh_index, exported in enumerate(gltf["meshes"]):
        name = exported.get("name")
        if name not in SKIN_WEIGHTS:
            continue
        digit, positions, weighting = SKIN_WEIGHTS[name]
        lookup = {tuple(round(v, 6) for v in p): weight for p, weight in zip(positions, weighting)}
        base_joint = list(DIGITS).index(digit) * 3
        for primitive in exported["primitives"]:
            position_accessor = gltf["accessors"][primitive["attributes"]["POSITION"]]
            position_view = gltf["bufferViews"][position_accessor["bufferView"]]
            start = position_view.get("byteOffset", 0) + position_accessor.get("byteOffset", 0)
            stride = position_view.get("byteStride", 12)
            joints, weights = [], []
            for vertex in range(position_accessor["count"]):
                point = struct.unpack_from("<3f", binary, start + vertex * stride)
                weight = lookup.get(tuple(round(v, 6) for v in point))
                if weight is None:
                    nearest = min(range(len(positions)), key=lambda i: (Vector(positions[i]) - Vector(point)).length_squared)
                    if (Vector(positions[nearest]) - Vector(point)).length > 1e-6:
                        raise ValueError(f"Cannot map exported skin vertex {name}: {point}")
                    weight = weighting[nearest]
                joints.extend((base_joint, base_joint + 1, base_joint + 2, 0))
                weights.extend((*weight, 0))
            primitive["attributes"]["JOINTS_0"] = append_accessor(bytes(joints), 5121, "VEC4", position_accessor["count"])
            primitive["attributes"]["WEIGHTS_0"] = append_accessor(struct.pack(f"<{len(weights)}f", *weights), 5126, "VEC4", position_accessor["count"])
        skin_meshes.add(mesh_index)
    for node in gltf["nodes"]:
        if node.get("mesh") in skin_meshes:
            node["skin"] = 0
    gltf["buffers"][0]["byteLength"] = len(binary)
    json_bytes = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode()
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    binary.extend(b"\x00" * ((-len(binary)) % 4))
    total = 12 + 8 + len(json_bytes) + 8 + len(binary)
    OUT.write_bytes(struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes + struct.pack("<II", len(binary), 0x004E4942) + binary)


def apply_preview_skin():
    """Evaluate the same standard linear skin in Blender for visual review.

    Production glTF consumers do this in their skinning shader. This helper is
    only for Blender still renders after sampling one of the existing clips.
    """
    bpy.context.view_layer.update()
    for name, (digit, positions, weights) in SKIN_WEIGHTS.items():
        transforms = [bpy.data.objects[f"{digit}_{joint}"].matrix_world @ Matrix.Translation(-Vector(DIGITS[digit][i])) for i, joint in enumerate(JOINTS)]
        ob = bpy.data.objects[name]
        for vertex, point, blend in zip(ob.data.vertices, positions, weights):
            vertex.co = sum((transforms[i] @ Vector(point) * blend[i] for i in range(3)), Vector())
        ob.data.update()


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    SKIN_WEIGHTS.clear()
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.frame_start, scene.frame_end = 1, 31
    root = empty("acu_practitioner_hand")
    root["license"] = "CC0-1.0"
    root["source"] = "AcuCraft tools/blender/build_hand.py; original procedural geometry"
    root["units"] = "metres; +Y needle axis; +X pinch to wrist"
    skin = material("hand_skin", (0.64, 0.40, 0.27))
    nail = material("hand_nails", (0.70, 0.49, 0.39), 0.36)
    palm(root, skin)
    empty("wrist", root, (0.162, 0.004, 0))
    empty("pinch", root)
    anchors = {}
    anchors["palm_contact"] = empty("palm_contact", root, (0.103, -0.013, -0.002), (0, -1, 0))
    anchors["support_contact"] = empty("support_contact", root, (0.071, -0.010, 0.016), (0, -1, 0))
    nodes = {}
    for digit, points in DIGITS.items():
        radius = {"thumb": 0.0090, "index": 0.0075, "middle": 0.0080, "ring": 0.0075, "little": 0.0064}[digit]
        surface = continuous_finger(digit, skin, root)
        parent = root
        for i, joint in enumerate(JOINTS):
            start, end = Vector(points[i]), Vector(points[i + 1])
            parent_origin = Vector(points[i - 1]) if i else Vector((0, 0, 0))
            anatomical = empty(f"{digit}_{ANATOMICAL[digit][i]}", parent, start - parent_origin)
            anatomical["joint"] = ANATOMICAL[digit][i]
            anatomical["digit"] = digit
            # Existing clip controls stay at the same pivot, nested below the named anatomical overlay.
            node = empty(f"{digit}_{joint}", anatomical)
            node["anatomical_control"] = anatomical.name
            nodes[node.name] = node
            delta = end - start
            r = radius * (1 - i * 0.12)
            toward_gap = Vector((0, 0, 1 if digit == "thumb" else -1))
            precision = i == 2 and digit in ("thumb", "index")
            if i == 2:
                empty(f"{digit}_tip", node, delta)
                # Nails on the dorsal side, following each distal phalanx.
                axis = delta.normalized()
                width = Vector((0, 0, 1))
                width -= axis * width.dot(axis)
                dorsal = -width.normalized().cross(axis)
                if digit == "thumb":
                    dorsal = -toward_gap
                elif digit == "index":
                    dorsal = Vector((0, 1, 0))
                dorsal -= axis * dorsal.dot(axis)
                dorsal.normalize()
                nail_axis = delta
                # Preserve the longitudinal nail-bed coordinate. A nearest
                # point search from far outside can slide along the rounded
                # tip, placing the whole nail beyond its intended free edge.
                nail_centre = delta * 0.67
                nail_surface, nail_edge, nail_normal = nail_plate(f"{digit}_nail", node, surface, nail_centre, dorsal, nail_axis, delta.length * 0.28, r * 0.62, nail)
                if precision:
                    target = Vector((0, 0, -0.0007 if digit == "thumb" else 0.0007)) - start
                else:
                    target = delta * 0.86 + Vector((0, -r * 0.85, 0))
                pad = surface_anchor(f"{digit}_pad_contact", node, surface, target)
                if precision:
                    # At the crest, the analytic smooth-surface normal is exactly
                    # toward the gap. A single adjacent triangle's facet normal
                    # must not rotate the whole finger away from the handle.
                    pad.rotation_quaternion = Vector((0, 1, 0)).rotation_difference(toward_gap)
                anchors[pad.name] = pad
                # Both names are offered while existing runtime integrations migrate to *_pad_contact.
                empty(f"{digit}_pad", node, pad.location, pad.rotation_quaternion @ Vector((0, 1, 0)))
                if digit == "middle":
                    side_target = delta * (1 - 0.004 / delta.length) + Vector((0, 0, -0.0063096))
                    side = surface_anchor("middle_side_contact", node, surface, side_target)
                    side.rotation_quaternion = Vector((0, 1, 0)).rotation_difference(Vector((0, 0, -1)))
                    anchors[side.name] = side
                nail_anchor = empty(f"{digit}_nail_contact", node, nail_edge, nail_normal)
                nail_anchor["surface"] = nail_surface.name
                anchors[nail_anchor.name] = nail_anchor
            parent = node
    empty("thumb_contact", root, (0, 0, -0.0007))
    empty("index_contact", root, (0, 0, 0.0007))

    # Named poses are contact choreography, not measured joint-angle prescriptions.
    open_degrees = {
        "thumb": [(-8, 0, -20), (0, 0, -12), (0, 0, -8)],
        "index": [(0, 0, 18), (0, 0, 10), (0, 0, 8)],
        "middle": [(0, 0, 45), (0, 0, -70), (0, 0, -45)],
        "ring": [(0, 0, 44), (0, 0, -72), (0, 0, -45)],
        "little": [(0, 0, 43), (0, 0, -72), (0, 0, -45)],
    }
    neutral = {digit: [Quaternion() for _ in JOINTS] for digit in DIGITS}
    opened = {digit: [Euler(tuple(math.radians(v) for v in angles), "XYZ").to_quaternion() for angles in open_degrees[digit]] for digit in DIGITS}
    for digit in ("middle", "ring", "little"):
        points = [Vector(p) for p in DIGITS[digit]]
        bones = [points[i + 1] - points[i] for i in range(3)]
        hinge = Vector((0, 0, 1))
        # Relative rotations are computed from each digit's actual rest flexion.
        # The previous hard-coded -70/-45 degree offsets reversed the PIP of
        # these new natural rest chains during release.
        for joint, target in ((1, 10), (2, 7)):
            rest = math.atan2(bones[joint - 1].cross(bones[joint]).dot(hinge), bones[joint - 1].dot(bones[joint]))
            opened[digit][joint] = Quaternion(hinge, math.radians(target) - rest)
    support = {}
    for digit in DIGITS:
        axis = {"thumb": (-0.72, -0.04, -0.70), "index": (-1, -0.06, 0.06), "middle": (-1, -0.04, 0), "ring": (-1, -0.04, -0.02), "little": (-1, -0.04, -0.08)}[digit]
        support[digit] = chain_rotations(digit, [axis] * 3)
    tripod = {d: list(q) for d, q in neutral.items()}
    tripod["middle"] = contact_pose("middle", anchors["middle_side_contact"], (0, -0.006, 0.0006904), (-0.8, 0.6, 0), (0, 0, -1))
    scrape = {d: list(q) for d, q in tripod.items()}
    # The nail contact has its own anchor. The renderer aligns that anchor, rather than the pinch root,
    # with the handle while the other hand stabilizes it; a nail is proximal to the fingertip pad.
    scrape["index"] = contact_pose("index", anchors["index_nail_contact"], (0.012, 0.005, 0.001), (-1, 0.15, 0), (0, 0, -1))
    flick_loaded = {d: list(q) for d, q in tripod.items()}
    flick_loaded["index"] = contact_pose("index", anchors["index_nail_contact"], (0.010, 0.008, 0.0007), (-0.8, 0.6, 0), (0, 0, -1))
    flick_release = {d: list(q) for d, q in tripod.items()}
    flick_release["index"] = opened["index"]
    clips = {
        "hand_open": [(1, neutral), (31, opened)],
        "hand_support": [(1, neutral), (31, support)],
        "hand_three_finger": [(1, neutral), (31, tripod)],
        "hand_scrape": [(1, neutral), (31, scrape)],
        "hand_flick": [(1, neutral), (13, flick_loaded), (17, flick_release), (31, neutral)],
    }
    for name, frames in clips.items():
        add_clip(name, nodes, frames)

    # Measure the real contact transforms of each authored pose for both runtime attachment and tests.
    for node in nodes.values():
        for track in node.animation_data.nla_tracks:
            track.mute = True
    contacts_by_pose = {}
    for name, pose in {"pinch": neutral, "open": opened, "support": support, "three_finger": tripod, "scrape": scrape, "flick_loaded": flick_loaded, "flick_release": flick_release}.items():
        for digit in DIGITS:
            for i, joint in enumerate(JOINTS):
                nodes[f"{digit}_{joint}"].rotation_quaternion = pose[digit][i]
        contacts_by_pose[name] = pose_points(anchors)
    for node in nodes.values():
        for track in node.animation_data.nla_tracks:
            track.mute = False
    scene.frame_set(1)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUT), export_format="GLB", export_yup=False,
        export_animations=True, export_nla_strips=True,
        export_animation_mode="NLA_TRACKS", export_force_sampling=True,
        export_anim_slide_to_zero=True,
        export_extras=True, export_cameras=False, export_lights=False,
    )

    bind_continuous_skins()

    # Manifest records the binary's actual contract, without geometry patient data.
    raw = OUT.read_bytes()
    json_length = struct.unpack_from("<I", raw, 12)[0]
    gltf = json.loads(raw[20:20 + json_length])
    triangles = sum(gltf["accessors"][p["indices"]]["count"] // 3 for m in gltf["meshes"] for p in m["primitives"])
    manifest = {
        "file": "assets/models/acu-practitioner-hand.glb",
        "license": "CC0-1.0", "source": "tools/blender/build_hand.py",
        "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
        "triangles": triangles, "root": root.name,
        "coordinates": "metres; +Y along needle, +X from pinch toward wrist; rest precision pinch",
        "wrist": [0.162, 0.004, 0], "pinch": [0, 0, 0],
        "tips": {d: list(points[-1]) for d, points in DIGITS.items()},
        "contact": {"thumb": [0, 0, -0.0007], "index": [0, 0, 0.0007]},
        "joints": {d: [f"{d}_{j}" for j in JOINTS] for d in DIGITS},
        "anatomicalJoints": {d: [f"{d}_{j}" for j in ANATOMICAL[d]] for d in DIGITS},
        "anatomicalMapping": {f"{d}_{j}": f"{d}_{ANATOMICAL[d][i]}" for d in DIGITS for i, j in enumerate(JOINTS)},
        "skin": {"surfaces": list(SKIN_WEIGHTS), "joints": [f"{d}_{j}" for d in DIGITS for j in JOINTS], "weights": "smooth neighbouring-joint blend; contact-bearing distal vertices are rigid", "clone": "SkeletonUtils.clone is required for independent hands"},
        "contactAnchors": {name: {"node": name, "normalAxis": "+Y", "follows": node.parent.name, **({"surface": node["surface"]} if "surface" in node else {})} for name, node in anchors.items()},
        "poseContacts": contacts_by_pose,
        "materials": ["hand_skin", "hand_nails"],
        "animations": [a["name"] for a in gltf.get("animations", [])],
        "animation": "Every clip is 0..1 second and begins at precision pinch. hand_open/support/three_finger/scrape end at the named pose. hand_flick is loaded at .4s, released at .533333s, back at pinch at 1s. Sample only one base clip per hand; anatomical parent controls may overlay it.",
        "clipFrames": {name: [round((frame - 1) / 30, 9) for frame, _ in frames] for name, frames in clips.items()},
        "review": "schematic animation asset, no anatomical or clinical validation",
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Hand: {triangles} triangles; {len(raw)} bytes; clips {manifest['animations']}")


if __name__ == "__main__":
    build()
