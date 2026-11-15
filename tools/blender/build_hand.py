"""Build the articulated hand used by the encounter's precision grip.

    blender -b -P tools/blender/build_hand.py

No downloaded model, add-on, or ClinicalCraft checkout is needed. Coordinates are
already glTF's metre/Y-up frame: +Y follows the needle and +X runs from the pinch
to the wrist. Export without Blender's usual Z-up conversion for that reason.
The neutral pose pinches a 2 mm visualization of a needle at the origin. It is a
schematic animation asset, not an anatomical or clinical reference.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "content/world/assets/models/acu-practitioner-hand.glb"
MANIFEST = Path(__file__).with_name("hand.json")
DIGITS = {
    "thumb": [(0.087, 0.000, -0.031), (0.055, -0.012, -0.034), (0.025, -0.007, -0.020), (0.000, 0.000, -0.006)],
    "index": [(0.067, 0.003, 0.027), (0.036, 0.013, 0.023), (0.014, 0.007, 0.013), (0.000, 0.000, 0.006)],
    "middle": [(0.065, 0.001, 0.007), (0.036, -0.024, 0.009), (0.057, -0.049, 0.009), (0.079, -0.035, 0.009)],
    "ring": [(0.068, 0.000, -0.013), (0.044, -0.027, -0.012), (0.066, -0.047, -0.012), (0.086, -0.032, -0.012)],
    "little": [(0.076, -0.002, -0.031), (0.056, -0.026, -0.030), (0.074, -0.041, -0.030), (0.092, -0.027, -0.030)],
}
JOINTS = ("proximal", "middle", "distal")
ANATOMICAL = {digit: ("CMC", "MCP", "IP") if digit == "thumb" else ("MCP", "PIP", "DIP") for digit in DIGITS}


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


def ellipsoid(name, centre, radii, mat, parent, segments=12, rings=6, axis=None):
    """A small closed, smooth mesh; axis is the direction of its long (+X) axis."""
    basis = Vector((1, 0, 0)).rotation_difference(Vector(axis).normalized()) if axis else None
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
    # The fleshy thenar cushion between the thumb and the wrist.
    ellipsoid("thenar", (0.103, -0.006, -0.021), (0.027, 0.013, 0.025), skin, root, segments=16, rings=8)


def surface_anchor(name, parent, surface, target):
    """Place a moving attachment on the actual mesh, with +Y along its outward normal."""
    vertices = [v.co.copy() for v in surface.data.vertices]
    faces = [list(p.vertices) for p in surface.data.polygons]
    tree = BVHTree.FromPolygons(vertices, faces)
    point, normal, _, _ = tree.find_nearest(Vector(target))
    anchor = empty(name, parent, point, normal)
    anchor["surface"] = surface.name
    return anchor


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
        world = terminal if i == 2 and terminal is not None else (points[i + 1] - points[i]).rotation_difference(Vector(direction).normalized())
        # rotation_difference retains the source vector's magnitude only in the source; its output is unit.
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


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
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
            surface = ellipsoid(f"{digit}_{joint}_skin", delta * 0.5, (delta.length * 0.5 + r * 0.5, r * 0.95, r), skin, node, axis=delta)
            ellipsoid(f"{digit}_{joint}_knuckle", (0, 0, 0), (r * 0.9, r * 0.95, r), skin, node, rings=5)
            if i == 2:
                empty(f"{digit}_tip", node, delta)
                # Nails on the dorsal side, following each distal phalanx.
                nail_surface = ellipsoid(f"{digit}_nail", delta * 0.59 + Vector((0, r * 0.89, 0)), (delta.length * 0.30, 0.00075, r * 0.66), nail, node, rings=4, axis=delta)
                if digit in ("thumb", "index"):
                    # Rounded fingertip pulp makes the neutral opposing contacts a real 2 mm gap,
                    # while preserving the existing fingertip/joint coordinates and clip pivots.
                    surface = ellipsoid(f"{digit}_pad_skin", delta, (0.0045, 0.0038, 0.005), skin, node)
                    target = Vector((0, 0, -0.001 if digit == "thumb" else 0.001)) - start
                else:
                    target = delta * 0.86 + Vector((0, -r * 0.85, 0))
                pad = surface_anchor(f"{digit}_pad_contact", node, surface, target)
                anchors[pad.name] = pad
                # Both names are offered while existing runtime integrations migrate to *_pad_contact.
                empty(f"{digit}_pad", node, pad.location, pad.rotation_quaternion @ Vector((0, 1, 0)))
                nail_anchor = surface_anchor(f"{digit}_nail_contact", node, nail_surface, delta * 0.59 + Vector((0, r + 0.002, 0)))
                anchors[nail_anchor.name] = nail_anchor
            parent = node
    empty("thumb_contact", root, (0, 0, -0.001))
    empty("index_contact", root, (0, 0, 0.001))

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
    support = {}
    for digit in DIGITS:
        axis = {"thumb": (-0.72, -0.04, -0.70), "index": (-1, -0.06, 0.06), "middle": (-1, -0.04, 0), "ring": (-1, -0.04, -0.02), "little": (-1, -0.04, -0.08)}[digit]
        support[digit] = chain_rotations(digit, [axis] * 3)
    tripod = {d: list(q) for d, q in neutral.items()}
    tripod["middle"] = contact_pose("middle", anchors["middle_pad_contact"], (0, -0.010, 0.001), (-0.8, 0.6, 0), (0, 0, -1))
    scrape = {d: list(q) for d, q in tripod.items()}
    # The nail contact has its own anchor. The renderer aligns that anchor, rather than the pinch root,
    # with the handle while the other hand stabilizes it; a nail is proximal to the fingertip pad.
    scrape["index"] = contact_pose("index", anchors["index_nail_contact"], (0.012, 0.005, 0.001), (-1, 0.15, 0), (0, 0, -1))
    flick_loaded = {d: list(q) for d, q in tripod.items()}
    flick_loaded["index"] = contact_pose("index", anchors["index_pad_contact"], (0.001, 0.008, 0.001), (-0.8, 0.6, 0), (0, 0, -1))
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

    # Manifest records the binary's actual contract, without geometry patient data.
    import struct
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
        "contact": {"thumb": [0, 0, -0.001], "index": [0, 0, 0.001]},
        "joints": {d: [f"{d}_{j}" for j in JOINTS] for d in DIGITS},
        "anatomicalJoints": {d: [f"{d}_{j}" for j in ANATOMICAL[d]] for d in DIGITS},
        "anatomicalMapping": {f"{d}_{j}": f"{d}_{ANATOMICAL[d][i]}" for d in DIGITS for i, j in enumerate(JOINTS)},
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
