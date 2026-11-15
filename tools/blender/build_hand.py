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
from mathutils import Vector

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


def empty(name: str, parent=None, at=(0, 0, 0)):
    ob = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(ob)
    ob.parent = parent
    ob.location = at
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
    nodes = {}
    for digit, points in DIGITS.items():
        radius = {"thumb": 0.0090, "index": 0.0075, "middle": 0.0080, "ring": 0.0075, "little": 0.0064}[digit]
        parent = root
        for i, joint in enumerate(JOINTS):
            start, end = Vector(points[i]), Vector(points[i + 1])
            parent_origin = Vector(points[i - 1]) if i else Vector((0, 0, 0))
            node = empty(f"{digit}_{joint}", parent, start - parent_origin)
            nodes[node.name] = node
            delta = end - start
            r = radius * (1 - i * 0.12)
            ellipsoid(f"{digit}_{joint}_skin", delta * 0.5, (delta.length * 0.5 + r * 0.5, r * 0.95, r), skin, node, axis=delta)
            ellipsoid(f"{digit}_{joint}_knuckle", (0, 0, 0), (r * 0.9, r * 0.95, r), skin, node, rings=5)
            if i == 2:
                empty(f"{digit}_tip", node, delta)
                # Nails on the dorsal side, following each distal phalanx.
                ellipsoid(f"{digit}_nail", delta * 0.59 + Vector((0, r * 0.89, 0)), (delta.length * 0.30, 0.00075, r * 0.66), nail, node, rings=4, axis=delta)
            parent = node
    empty("thumb_contact", root, (0, 0, -0.001))
    empty("index_contact", root, (0, 0, 0.001))

    # One clip for the mixer: zero is the precision pinch, one is a loose open
    # grasp. At rest the named joints also accept procedural rotations directly.
    open_degrees = {
        "thumb": [(-8, 0, -20), (0, 0, -12), (0, 0, -8)],
        "index": [(0, 0, 18), (0, 0, 10), (0, 0, 8)],
        "middle": [(0, 0, 45), (0, 0, -70), (0, 0, -45)],
        "ring": [(0, 0, 44), (0, 0, -72), (0, 0, -45)],
        "little": [(0, 0, 43), (0, 0, -72), (0, 0, -45)],
    }
    for digit in DIGITS:
        for i, joint in enumerate(JOINTS):
            node = nodes[f"{digit}_{joint}"]
            node.rotation_mode = "XYZ"
            node.rotation_euler = (0, 0, 0)
            node.keyframe_insert(data_path="rotation_euler", frame=1, group=node.name)
            node.rotation_euler = tuple(math.radians(v) for v in open_degrees[digit][i])
            node.keyframe_insert(data_path="rotation_euler", frame=31, group=node.name)
            node.animation_data.action.name = f"{node.name}_hand_open"
            track = node.animation_data.nla_tracks.new()
            track.name = "hand_open"
            track.strips.new("hand_open", 1, node.animation_data.action)
            node.animation_data.action = None
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
        "materials": ["hand_skin", "hand_nails"],
        "animations": [a["name"] for a in gltf.get("animations", [])],
        "animation": "hand_open: t=0 precision pinch; t=1 second loose open grasp; clamp mixer time for blend",
        "review": "schematic animation asset, no anatomical or clinical validation",
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Hand: {triangles} triangles; {len(raw)} bytes; clips {manifest['animations']}")


if __name__ == "__main__":
    build()
