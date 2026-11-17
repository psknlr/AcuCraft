"""Build AcuCraft's articulated practitioner hand from explicit source anatomy.

    blender -b -P tools/blender/build_hand.py

Coordinates are already glTF metre/Y-up coordinates: +Y follows the needle.
The palm has a complete anatomical basis, a near-carpal thumb CMC, and a
fixed-length articulated skeleton. Distal skin, volar pulp and dorsal nail
share each phalanx's frame. Source geometry is in hand_anatomy.json; exported
animation is sampled from the matching runtime in hand_poses.json.

This original procedural asset is an authored visualization, not a clinical
calibration or motion-capture reconstruction.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

REPO = Path(__file__).resolve().parents[2]
ANATOMY_SOURCE = Path(__file__).with_name("hand_anatomy.json")
POSES = Path(__file__).with_name("hand_poses.json")
OUT = REPO / "content/world/assets/models/acu-practitioner-hand.glb"
MANIFEST = Path(__file__).with_name("hand.json")
SOURCE_ANATOMY = json.loads(ANATOMY_SOURCE.read_text())
THUMB_TISSUE = SOURCE_ANATOMY["thumbMetacarpalSoftTissue"]
DIGITS = {digit: SOURCE_ANATOMY["digits"][digit] for digit in ("thumb", "index", "middle", "ring", "little")}
WRIST = tuple(SOURCE_ANATOMY["wristM"])
PALM_CENTRE = tuple(SOURCE_ANATOMY["palmCentreM"])
PALM_BASIS = Matrix(tuple(zip(*SOURCE_ANATOMY["palmBasisColumns"])))
PALM_LONGITUDINAL = PALM_BASIS.col[0].to_3d()
PALM_DORSAL = PALM_BASIS.col[1].to_3d()
PALM_RADIAL = PALM_BASIS.col[2].to_3d()
PALM_FRAME_ANGLE = math.atan2(PALM_LONGITUDINAL.y, PALM_LONGITUDINAL.x)
DIGIT_HINGES = {digit: Vector(value) for digit, value in SOURCE_ANATOMY["hinges"].items()}
END_VOLARS = {digit: Vector(value) for digit, value in SOURCE_ANATOMY["endVolars"].items()}
CAP_OFFSETS = SOURCE_ANATOMY["capOffsetsM"]
PAD_TARGETS = {digit: Vector(value) for digit, value in SOURCE_ANATOMY["padTargets"].items()}
PAD_NORMALS = {digit: Vector(value) for digit, value in SOURCE_ANATOMY["padNormals"].items()}
JOINTS = ("proximal", "middle", "distal")
ANATOMICAL = {digit: ("CMC", "MCP", "IP") if digit == "thumb" else ("MCP", "PIP", "DIP") for digit in DIGITS}
SKIN_WEIGHTS = {}
ANIMATED_MATERIALS = set()
MATERIALS_BY_CLIP = {}
MATERIAL_BIND_FRAMES = {}
WRIST_INTERFACE_ROWS = {}


def anatomy_point(point):
    """Canonical palm coordinates to the baked full model-space anatomy."""
    return Vector(SOURCE_ANATOMY["anatomyOriginM"]) + PALM_BASIS @ Vector(point)


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


def detail_textures(skin, nail):
    """Original deterministic PBR detail, packed into the GLB with the mesh UVs.

    Geometry supplies the anatomical folds and contact surfaces. Shared palm
    and finger UVs have different anatomical orientations and physical scales,
    so these maps add restrained, neutral skin grain rather than false crease
    bands, veins or measured pore sizes. No photographic pixels are embedded.
    """
    size = 512
    albedo, roughness, heights = [], [], []

    def noise(u, v, columns, rows, seed):
        # Smooth, repeatable lattice noise; horizontal wrapping matches the
        # cylindrical UV seam without a visible color or normal discontinuity.
        x, y = u * columns, v * rows
        ix, iy = math.floor(x), math.floor(y)
        fx, fy = x - ix, y - iy
        fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
        fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
        def value(a, b):
            n = ((a % columns) * 374761393 + b * 668265263 + seed * 1442695041) & 0xffffffff
            n = ((n ^ (n >> 13)) * 1274126177) & 0xffffffff
            return ((n ^ (n >> 16)) & 0xffff) / 65535
        lo = value(ix, iy) * (1 - fx) + value(ix + 1, iy) * fx
        hi = value(ix, iy + 1) * (1 - fx) + value(ix + 1, iy + 1) * fx
        return lo * (1 - fy) + hi * fy

    for y in range(size):
        v = y / (size - 1)
        for x in range(size):
            u = x / (size - 1)
            warmth = noise(u, v, 5, 8, 11) - 0.5
            tone = noise(u, v, 9, 14, 23) - 0.5
            grain = noise(u, v, 67, 113, 37) - 0.5
            fine = noise(u, v, 149, 241, 41)
            pore = smoothstep((fine - 0.61) / 0.30)
            # Sparse shallow pores and broken fine lines stay below the
            # anatomical folds. Warping avoids a regular cross-hatched grid.
            warp = noise(u, v, 17, 27, 53)
            line = math.sin(math.tau * (u * 43 + v * 31 + warp * 0.65))
            microcrease = max(0, line) ** 14 * (0.25 + noise(u, v, 31, 47, 59) * 0.75)
            h = grain * 0.055 - pore * 0.065 - microcrease * 0.018
            heights.append(h)
            shade = tone * 0.030 + grain * 0.0015 - pore * 0.0015 - microcrease * 0.002
            albedo.extend((0.964 + shade + warmth * 0.018,
                           0.937 + shade - warmth * 0.026,
                           0.918 + shade - warmth * 0.036, 1))
            roughness.extend((1, 0.615 + tone * 0.035 + grain * 0.022 + pore * 0.018, 0, 1))

    def normal_pixels(values, dimension, slope, wrap=True):
        pixels = []
        for y in range(dimension):
            for x in range(dimension):
                # The first/last columns duplicate a cylindrical seam. Use
                # its real neighbours rather than flattening the seam normal.
                left = (x - 1) % (dimension - 1) if wrap else max(0, x - 1)
                right = (x + 1) % (dimension - 1) if wrap else min(dimension - 1, x + 1)
                below, above = max(0, y - 1), min(dimension - 1, y + 1)
                dx = (values[y * dimension + right] - values[y * dimension + left]) * slope
                dy = (values[above * dimension + x] - values[below * dimension + x]) * slope
                n = Vector((-dx, -dy, 1)).normalized()
                pixels.extend((n.x * 0.5 + 0.5, n.y * 0.5 + 0.5, n.z * 0.5 + 0.5, 1))
        return pixels

    normal = normal_pixels(heights, size, 0.85)

    def image(name, pixels, noncolor=False, dimension=size):
        value = bpy.data.images.new(name, width=dimension, height=dimension, alpha=True)
        if noncolor:
            value.colorspace_settings.name = "Non-Color"
        value.pixels.foreach_set(pixels)
        value.pack()
        return value

    def texture_maps(mat, maps, dimension, normal_strength):
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        shader = nodes.get("Principled BSDF")
        for name, pixels, kind in maps:
            texture = nodes.new("ShaderNodeTexImage")
            texture.image = image(name, pixels, kind != "color", dimension)
            if kind == "normal":
                node = nodes.new("ShaderNodeNormalMap")
                node.inputs["Strength"].default_value = normal_strength
                links.new(texture.outputs["Color"], node.inputs["Color"])
                links.new(node.outputs["Normal"], shader.inputs["Normal"])
            elif kind == "roughness":
                node = nodes.new("ShaderNodeSeparateColor")
                links.new(texture.outputs["Color"], node.inputs["Color"])
                links.new(node.outputs["Green"], shader.inputs["Roughness"])
            elif mat == skin:
                multiply = nodes.new("ShaderNodeMix")
                multiply.data_type = "RGBA"
                multiply.blend_type = "MULTIPLY"
                multiply.inputs[0].default_value = 1
                multiply.inputs[7].default_value = (0.64, 0.40, 0.27, 1)
                links.new(texture.outputs["Color"], multiply.inputs[6])
                links.new(multiply.outputs[2], shader.inputs["Base Color"])
            else:
                links.new(texture.outputs["Color"], shader.inputs["Base Color"])
        return shader

    shader = texture_maps(skin, [("skin_albedo", albedo, "color"),
                                 ("skin_normal", normal, "normal"),
                                 ("skin_roughness", roughness, "roughness")], size, 0.38)
    shader.inputs["Base Color"].default_value = (0.64, 0.40, 0.27, 1)
    shader.inputs["Specular IOR Level"].default_value = 0.28

    nail_pixels, nail_roughness, nail_heights = [], [], []
    dimension = 256
    for y in range(dimension):
        v = y / (dimension - 1)
        across = (v - 0.5) * 2
        for x in range(dimension):
            u = x / (dimension - 1)
            # The proximal moon and distal ivory rim follow curved boundaries
            # across the nail, with soft transitions through the natural bed.
            moon_boundary = 0.19 - across * across * 0.22
            lunula = (1 - smoothstep((u - moon_boundary + 0.025) / 0.075)) * 0.52
            edge_boundary = 0.915 - across * across * 0.035
            edge = smoothstep((u - edge_boundary) / 0.050) * 0.86
            bed = noise(u, v, 4, 6, 71) - 0.5
            fibres = (math.sin(v * math.tau * 37 + math.sin(v * math.tau * 11) * 0.7)
                      + math.sin(v * math.tau * 61 + u * 2.1) * 0.35)
            color = (0.840 + bed * 0.016 + fibres * 0.0015,
                     0.690 + bed * 0.020 + fibres * 0.0015,
                     0.640 + bed * 0.020 + fibres * 0.0015)
            for target, mix in [((0.91, 0.85, 0.79), lunula), ((0.94, 0.91, 0.85), edge)]:
                color = tuple(a * (1 - mix) + b * mix for a, b in zip(color, target))
            nail_pixels.extend((*color, 1))
            nail_roughness.extend((1, 0.375 + bed * 0.025 + fibres * 0.006 + edge * 0.065, 0, 1))
            nail_heights.append(fibres * 0.012 * (1 - edge * 0.55))
    shader = texture_maps(nail, [("nail_bed", nail_pixels, "color"),
                                 ("nail_normal", normal_pixels(nail_heights, dimension, 0.65, wrap=False), "normal"),
                                 ("nail_roughness", nail_roughness, "roughness")], dimension, 0.22)
    shader.inputs["Coat Weight"].default_value = 0.045
    shader.inputs["Coat Roughness"].default_value = 0.34
    shader.inputs["Specular IOR Level"].default_value = 0.38


def surface_uv(ob, values):
    layer = ob.data.uv_layers.new(name="skin_uv")
    for polygon in ob.data.polygons:
        uv = [values[ob.data.loops[index].vertex_index] for index in polygon.loop_indices]
        seam = max(p[0] for p in uv) - min(p[0] for p in uv) > 0.5
        for loop, point in zip(polygon.loop_indices, uv):
            layer.data[loop].uv = (point[0] + (1 if seam and point[0] < 0.5 else 0), point[1])


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


def smoothstep(value):
    t = min(1, max(0, value))
    return t * t * (3 - 2 * t)


def thumb_root_static_weight(metacarpal_fraction):
    """One C1 material transition, shared by the thumb and its thenar envelope."""
    start, end = THUMB_TISSUE["rootStaticTransition"]
    return THUMB_TISSUE["proximalStaticWeight"]*(1-smoothstep((metacarpal_fraction-start)/(end-start)))


def transported_dorsal(digit):
    """The distal nail bed is opposite this same phalanx's true volar skin."""
    return -Vector(END_VOLARS[digit]).normalized()


def _finger_profile(along, positions, values):
    """A monotone C1 profile; knuckle accents are added separately."""
    if along <= positions[0]:
        return values[0]
    for i in range(len(positions) - 1):
        if along <= positions[i + 1]:
            q = smoothstep((along - positions[i]) / (positions[i + 1] - positions[i]))
            return values[i] + (values[i + 1] - values[i])*q
    return values[-1]


def continuous_finger(digit, mat, parent):
    """Closed, anatomically transported skin with continuous joint contours.

    The single fixed flexion-plane hinge transports the complete transverse
    skin frame: Nvolar=H x T, lateral=T x Nvolar.  Thus skin and the dorsal
    nail share one physical frame, including for the opposed thumb/index.
    Distal bone, distal skin centerline, and nail longitudinal axis agree.
    """
    points = [Vector(p) for p in DIGITS[digit]]
    directions = [(points[i + 1] - points[i]).normalized() for i in range(3)]
    lengths = [(points[i + 1] - points[i]).length for i in range(3)]
    cumulative = [0.0, lengths[0], lengths[0] + lengths[1]]
    total = sum(lengths)
    hinge = Vector(DIGIT_HINGES[digit]).normalized()
    end_volar = hinge.cross(directions[2]).normalized()
    if end_volar.dot(Vector(END_VOLARS[digit]).normalized()) < 0.9999:
        raise ValueError(f"{digit}: END_VOLARS must equal H.cross(distal tangent)")
    cap_offset = float(CAP_OFFSETS.get(digit, 0.004))
    if not (0.001 < cap_offset < lengths[2]*0.45):
        raise ValueError(f"{digit}: CAP_OFFSETS must be a distal offset in metres")
    cap_start = lengths[2] - cap_offset
    # CAP_OFFSETS locates the distal bearing center.  A short real crest
    # continues past that center before rounding; otherwise a nearest-face
    # query exactly on the cap boundary can select its first oblique facet.
    cap_plateau = 0.0006 if digit in ("thumb", "index") else 0.0
    cap_round_start = cap_start + cap_plateau
    cap_round_length = cap_offset - cap_plateau
    precise = digit in ("thumb", "index")

    # Half-widths at MCP/PIP/DIP/bearing (CMC/MCP/IP/bearing for thumb),
    # in metres.  The thumb's first radius is hidden metacarpal tissue.
    width_values = {
        "thumb": (0.0090, 0.0090, 0.00725, 0.0065),
        "index": (0.00815, 0.00715, 0.00585, 0.00540),
        "middle": (0.00855, 0.00755, 0.00635, 0.00570),
        "ring": (0.00785, 0.00695, 0.00585, 0.00515),
        "little": (0.00665, 0.00575, 0.00485, 0.00425),
    }[digit]
    # Separate dorsal and volar depth leaves a broad pulp, a flatter nail
    # bed, and a tapered shaft rather than a circular pipe or joint beads.
    volar_values = {
        "thumb": (0.0070, 0.0066, 0.0049, 0.0053),
        "index": (0.0059, 0.00525, 0.00430, 0.0053),
        "middle": (0.0061, 0.00555, 0.00470, 0.0055),
        "ring": (0.0057, 0.00510, 0.00435, 0.0050),
        "little": (0.0048, 0.00425, 0.00365, 0.0044),
    }[digit]
    dorsal_values = {
        "thumb": (0.0066, 0.0060, 0.0045, 0.0042),
        "index": (0.0054, 0.00465, 0.0038, 0.0038),
        "middle": (0.0056, 0.00490, 0.00405, 0.0042),
        "ring": (0.0052, 0.00450, 0.00375, 0.0039),
        "little": (0.0044, 0.00380, 0.00315, 0.0033),
    }[digit]
    knots = [0.0, cumulative[1], cumulative[2], cumulative[2] + cap_start]
    tangents = [directions[0], (directions[0] + directions[1]).normalized(),
                directions[2], directions[2]]

    # Keep the existing ring UV order and avoid duplicate coincident joint
    # rings.  Exact crest and cap-start rings make the bearing
    # a real triangulated planar patch instead of a smoothed shading effect.
    along_samples = []
    for segment in range(2):
        samples = [0, 0.12, 0.25, 0.40, 0.55, 0.70, 0.84, 0.94]
        if digit == "thumb" and segment == 0:
            samples += [0.76, 0.88]
        along_samples += [cumulative[segment] + lengths[segment]*t for t in samples]
    distal_samples = [0.0, 0.0015, 0.003, 0.0045, cap_start*0.45,
                       cap_start*0.66, cap_start*0.84, cap_start]
    if precise:
        distal_samples += [max(0.0, cap_start - d)
                            for d in (0.003, 0.002, 0.001, 0.0005)]
    else:
        distal_samples += [max(0.0, cap_start - d)
                            for d in (0.003, 0.002, 0.001)]
    if precise:
        distal_samples += [cap_start + cap_plateau*0.5, cap_round_start]
    cap_angles = (0.22, 0.44, 0.66, 0.88, 1.10, 1.30, 1.46, 1.56)
    distal_samples += [cap_round_start + cap_round_length*math.sin(a) for a in cap_angles]
    along_samples += [cumulative[2] + s for s in distal_samples
                       if 0 <= s < lengths[2]]
    along_samples = sorted(set(round(s, 12) for s in along_samples))

    # 24 sides plus two real transverse bearing boundaries are sufficient
    # for this original procedural mesh.  Each precision bearing is 1.5 mm
    # wide before the cap; the surrounding cross-section is an ellipse.
    flat_angle = math.pi/24
    sides = int(SOURCE_ANATOMY["precisionSides"]) if precise else 20
    angles = [math.tau*i/sides for i in range(sides)]
    if precise:
        angles += [flat_angle, math.tau - flat_angle]
    angles = sorted(set(angles))
    ring_size = len(angles)
    vertices, weights, uv = [], [], []
    section_centres, section_weights = [], []
    for along in along_samples:
        segment = 2 if along >= cumulative[2] - 1e-11 else (1 if along >= cumulative[1] - 1e-11 else 0)
        t = (along - cumulative[segment])/lengths[segment]
        t = max(0.0, t)
        if segment == 2:
            # A physical distal phalanx has one straight bone/skin/nail axis.
            centre = points[2] + directions[2]*(along - cumulative[2])
            tangent = directions[2]
        elif digit == "thumb" and segment == 0 and t <= 0.70:
            centre = points[0].lerp(points[1], t)
            tangent = directions[0]
        else:
            a, b = points[segment], points[segment + 1]
            start_tangent = tangents[segment]
            end_tangent = tangents[segment + 1]
            span = lengths[segment]
            q = t
            if digit == "thumb" and segment == 0:
                # The first 70% remains a straight, buried carpal connector.
                a = points[0].lerp(points[1], 0.70)
                q = (t - 0.70)/0.30
                span *= 0.30
                start_tangent = directions[0]
            centre = (a*(2*q*q*q - 3*q*q + 1)
                      + start_tangent*(span*(q*q*q - 2*q*q + q))
                      + b*(-2*q*q*q + 3*q*q)
                      + end_tangent*(span*(q*q*q - q*q)))
            tangent = (a*(6*q*q - 6*q)
                       + start_tangent*(span*(3*q*q - 4*q + 1))
                       + b*(-6*q*q + 6*q)
                       + end_tangent*(span*(3*q*q - 2*q))).normalized()
        normal = hinge.cross(tangent).normalized()
        lateral = tangent.cross(normal).normalized()
        half_width = _finger_profile(along, knots, width_values)
        volar_depth = _finger_profile(along, knots, volar_values)
        dorsal_depth = _finger_profile(along, knots, dorsal_values)
        # Small, longitudinally broad knuckles preserve the shaft silhouette.
        # The thumb metacarpal/MCP is already enveloped by the palm/thenar.
        joint_profile = sum(math.exp(-((along - joint)/0.0040)**2)
                            for joint in cumulative[1:])
        half_width += 0.00028*joint_profile
        dorsal_depth += 0.00022*joint_profile
        if segment == 2:
            s = along - cumulative[2]
            if precise:
                # Both opposed precision contacts use the actual volar crest.
                settle = max(0.0015, cap_start - 0.0030)
                volar_depth = volar_values[2] + (0.0053 - volar_values[2])*smoothstep(s/settle)
            if s >= cap_round_start:
                axial = min(1.0, max(0.0, (s - cap_round_start)/cap_round_length))
                rounding = math.sqrt(max(1e-10, 1 - axial*axial))
                half_width = width_values[-1]*rounding
                volar_depth = volar_values[-1]*rounding
                dorsal_depth = dorsal_values[-1]*rounding
            else:
                rounding = 1.0
        else:
            rounding = 1.0
        if digit == "thumb" and segment == 0:
            buried = THUMB_TISSUE["minimumRadiusScale"] + (1-THUMB_TISSUE["minimumRadiusScale"])*smoothstep((t - 0.70)/0.30)
            half_width *= buried
            volar_depth *= buried
            dorsal_depth *= buried

        blend1 = smoothstep((along - cumulative[1] + min(lengths[:2])*0.19)/(min(lengths[:2])*0.38))
        blend2 = smoothstep((along - cumulative[2] + min(lengths[1:])*0.17)/(min(lengths[1:])*0.34))
        phalange_weights = (1 - blend1, blend1 - blend2, blend2)
        root_weight = (thumb_root_static_weight(along/lengths[0])
                       if digit == "thumb" else 1 - smoothstep(along/(lengths[0]*0.46)))
        weighting = (*[w*(1 - root_weight) for w in phalange_weights], root_weight)
        # Flexion folds affect only the local volar joints, never the rigid
        # distal bearing plane that runtime IK measures on actual triangles.
        crease = sum(math.exp(-((along - joint)/0.00125)**2)
                     for joint in cumulative[1:])*0.00014
        section_centres.append(centre)
        section_weights.append(weighting)
        for angle in angles:
            signed_angle = angle if angle <= math.pi else angle - math.tau
            absolute = abs(signed_angle)
            if precise and absolute <= math.pi/2 + 1e-12:
                # A narrow flat center merges tangentially into round lateral
                # shoulders.  Both axial and transverse bearing slopes are
                # represented by vertex geometry, not custom normals.
                patch = min(0.00075*rounding, half_width*0.30)
                if absolute <= flat_angle + 1e-12:
                    transverse = patch*(signed_angle/flat_angle)
                    depth = volar_depth
                else:
                    a = (absolute - flat_angle)/(math.pi/2 - flat_angle)*math.pi/2
                    transverse = math.copysign(patch + (half_width - patch)*math.sin(a), signed_angle)
                    depth = volar_depth*math.cos(a)
                depth -= crease*max(0, math.cos(angle))**6
            else:
                transverse = half_width*math.sin(angle)
                depth = ((volar_depth if math.cos(angle) >= 0 else dorsal_depth)*math.cos(angle)
                         - crease*max(0, math.cos(angle))**6)
            vertices.append(tuple(centre + lateral*transverse + normal*depth))
            weights.append(weighting)
            uv.append((angle/math.tau, along/(total + 0.0025)))

    faces = []
    for ring in range(len(along_samples) - 1):
        for side in range(ring_size):
            a = ring*ring_size + side
            b = ring*ring_size + (side + 1) % ring_size
            faces.append((a, b, b + ring_size, a + ring_size))
    # Explicit fans avoid the skinny/degenerate triangles produced when an
    # exporter ear-clips a very small terminal ngon.  The final rounded ring
    # is about 0.1--0.16 mm across, comfortably below the 0.2-mm tip target.
    start_index = len(vertices)
    vertices.append(tuple(section_centres[0])); weights.append(section_weights[0])
    uv.append((0.5, along_samples[0]/(total + 0.0025)))
    end_index = len(vertices)
    vertices.append(tuple(section_centres[-1])); weights.append(section_weights[-1])
    uv.append((0.5, along_samples[-1]/(total + 0.0025)))
    base = (len(along_samples) - 1)*ring_size
    for side in range(ring_size):
        nxt = (side + 1) % ring_size
        faces.append((start_index, nxt, side))
        faces.append((end_index, base + side, base + nxt))
    ob = mesh(f"{digit}_skin", vertices, faces, mat, parent)
    surface_uv(ob, uv)
    SKIN_WEIGHTS[ob.name] = (digit, vertices, weights)
    ob["anatomicalFrame"] = "volar=hinge cross tangent; nail=-distal volar"
    ob["distalCapOffsetM"] = cap_offset
    ob["anatomyFrame"] = "coherent-carpal"
    return ob


def palm(root, skin):
    """One closed adult palm in the same full basis as its bones and nails.

    The carpal/thenar mass grows at the proximal radial edge. The central
    palm remains thin; no whole-palm inflation hides a displaced thumb CMC.
    """
    origin = Vector(SOURCE_ANATOMY['anatomyOriginM'])
    centre_u = SOURCE_ANATOMY['palmCanonicalCentreM'][0]
    scale_u = SOURCE_ANATOMY['wristCanonicalM'][0] / 0.085
    # canonical u, half breadth, dorsal depth, palmar depth, thenar fullness
    controls = [
        (-.014, .001, .001, .001, 0), (-.010, .016, .007, .008, 0),
        (-.004, .034, .011, .011, .002), (.008, .041, .012, .012, .000),
        (.024, .042, .012, .012, .000), (.044, .038, .011, .012, .004),
        (.065, .031, .010, .011, .012), (.080, .025, .009, .009, .009),
        (.092, .022, .008, .009, .003), (.098, .001, .001, .001, 0),
    ]
    controls = [(u * scale_u, w, back, front, fullness) for u, w, back, front, fullness in controls]
    def section(t):
        segment = min(len(controls) - 2, int(t)); f = t - segment
        out = []
        for coordinate in range(5):
            a = controls[max(0, segment - 1)][coordinate]; b = controls[segment][coordinate]
            c = controls[segment + 1][coordinate]; d = controls[min(len(controls) - 1, segment + 2)][coordinate]
            out.append(.5*((2*b)+(-a+c)*f+(2*a-5*b+4*c-d)*f*f+(-a+3*b-3*c+d)*f*f*f))
        return out
    vertices, weights, uv = [], [], []; n, source_rows = 48, 61
    lower, upper = controls[0][0], controls[-1][0]
    interface_u = SOURCE_ANATOMY["wristInterface"]["canonicalU"]
    if SOURCE_ANATOMY["wristInterface"].get("samples") != n:
        raise ValueError("Wrist interface must preserve the original 48-sample palm perimeter")
    if not math.isfinite(interface_u) or not controls[-4][0] < interface_u < upper:
        raise ValueError("Wrist interface must be a finite proximal crop inside the source palm")
    samples = []
    for row in range(source_rows):
        t = row*(len(controls)-1)/(source_rows-1)
        if section(t)[0] >= interface_u:
            low = samples[-1] if samples else 0
            high = t
            for _ in range(48):
                middle = (low+high)/2
                if section(middle)[0] < interface_u: low = middle
                else: high = middle
            samples.append((low+high)/2)
            break
        samples.append(t)
    rows = len(samples)
    for row, sample_t in enumerate(samples):
        u, width, back, front, fullness = section(sample_t)
        end_fade = smoothstep((u-lower)/.010) * smoothstep((upper-u)/.010)
        for i in range(n):
            angle = math.tau*i/n; c,s=math.cos(angle),math.sin(angle)
            v = (back if c >= 0 else front) * c
            radial_palmar = math.exp(-((angle-2.35)/.62)**2)
            v -= fullness * radial_palmar
            r = width*s + fullness*radial_palmar*.12
            # A proximal radial carpal/thenar wing contains the real thumb CMC.
            carpal = math.exp(-((u-.070*scale_u)/(.026*scale_u))**2)*end_fade
            r += .011*carpal*math.exp(-((angle-1.80)/.66)**2)
            v -= .0025*carpal*math.exp(-((angle-2.00)/.66)**2)
            # Local carpal cushion encloses the adult metacarpal root without
            # adding thickness to the central palm or the distal first web.
            v -= THUMB_TISSUE["carpalCushionM"]*math.exp(-((u-SOURCE_ANATOMY["thumbCmcCanonicalMm"][0]*.001)/.014)**2-((angle-2.35)/.60)**2)*end_fade
            # Separate hypothenar cushion and a mild central longitudinal arch.
            v -= .0030*math.exp(-((u-.046*scale_u)/(.034*scale_u))**2-((angle-3.95)/.48)**2)*end_fade
            v += .0015*math.exp(-((u-.035*scale_u)/(.032*scale_u))**2)*max(0,-c)**8*end_fade
            # The first web is a recess between the index metacarpal and
            # the proximal thenar mass. It does not cover the free thumb IP.
            web_recess=.0065*math.exp(-((u-.020*scale_u)/(.020*scale_u))**2-((r-.025)/.012)**2)*max(0,-c)**2*end_fade
            v += web_recess
            # Give the moving metacarpal soft tissue a positive embedded
            # margin; this localized radial cushion leaves the central palm
            # and four MCP roots unchanged.
            cmc_canonical_u = SOURCE_ANATOMY["thumbCmcCanonicalMm"][0]*.001
            mcp_canonical_u = (PALM_BASIS.transposed() @ (Vector(DIGITS["thumb"][1])-origin)).x
            embedded_end_u = cmc_canonical_u*.30 + mcp_canonical_u*.70
            v -= (THUMB_TISSUE["metacarpalMarginCushionM"]*math.exp(-((u-embedded_end_u)/.018)**2-((r-.025)/.012)**2)
                  * smoothstep((r-.010)/.008)*max(0,-c)**2*end_fade)
            # The MCP knuckles and dorsal metacarpals follow the true radial row.
            knuckle = sum(math.exp(-((u-q)/.009)**2-((r-z)/.010)**2) for q,z in [(0,.025),(-.003,.005),(.003,-.015),(.012,-.031)])
            v += .0010*knuckle*max(0,c)**3
            ridges = sum(math.exp(-((r-z)/.006)**2) for z in [.025,.005,-.015,-.031])
            v += .00065*ridges*max(0,c)**4*math.exp(-((u-.030*scale_u)/(.032*scale_u))**2)*end_fade
            crease=.00018*math.exp(-((u-.026*scale_u-r*.20)/.0013)**2)+.00013*math.exp(-((u-.047*scale_u+r*.18)/.0012)**2)
            v += crease*max(0,-c)**6*end_fade
            # A small asymmetric distal boundary blends the ulnar MCP roots.
            ulna=max(0,(-r-.006)/.025)
            arch=.004*min(1.6,ulna)**2*smoothstep((.045*scale_u-u)/(.055*scale_u))
            p=origin+PALM_LONGITUDINAL*(u+arch)+PALM_DORSAL*v+PALM_RADIAL*r
            vertices.append(tuple(p));uv.append((i/n,.15+sample_t/(len(controls)-1)*.5))
            influence=.22*radial_palmar*math.exp(-((u-.059*scale_u)/(.034*scale_u))**2)*smoothstep((r-.010)/.014)*end_fade
            # The thenar follows the same metacarpal material progression as
            # the embedded thumb root. Central palm and the four MCP roots
            # remain outside this radial-palmar, proximal influence window.
            cmc_u = SOURCE_ANATOMY["thumbCmcCanonicalMm"][0]*.001
            mcp_u = (PALM_BASIS.transposed() @ (Vector(DIGITS["thumb"][1]) - origin)).x
            fraction = (cmc_u-u)/(cmc_u-mcp_u)
            root_static = thumb_root_static_weight(fraction)
            muscle_mask = (radial_palmar * smoothstep((r-.010)/.012)
                           * smoothstep((u-.032)/.018) * end_fade)
            influence = max(influence, min(THUMB_TISSUE["maximumThenarCmcWeight"], 1-root_static)*muscle_mask)
            weights.append((1-influence,influence,0,0))
    faces=[]
    for j in range(rows-1):
        for i in range(n):
            a=j*n+i;b=j*n+(i+1)%n;faces.append((a,b,b+n,a+n))
    faces.append(tuple(reversed(range(n))))
    # An explicit internal fan avoids long, thin n-gon ears folding when the
    # local CMC influence bends one part of the perimeter. Its interior point
    # follows the static carpal frame; all real lateral-ring weights are kept.
    ring_start = (rows-1)*n
    cap_centre = len(vertices)
    vertices.append(tuple(sum((Vector(p) for p in vertices[ring_start:]), Vector()) / n))
    weights.append((1, 0, 0, 0))
    uv.append((0.5, uv[-1][1]))
    faces += [(cap_centre, ring_start+i, ring_start+(i+1)%n) for i in range(n)]
    surface=mesh('palm_surface',vertices,faces,skin,root);surface_uv(surface,uv)
    # A flat hidden closure must not pull the lateral skin normal into its
    # longitudinal direction. glTF splits the cap's corner normals at the rim.
    for polygon in surface.data.polygons[-n:]:
        polygon.use_smooth = False
    surface['anatomicalRegions']='carpal wrist; thin central palm; proximal thenar; hypothenar; first web; MCP arch'
    surface['thenarTopology']='one closed adult palm component'
    # Keep the collision solid closed, while the runtime transition covers
    # this internal cap and meets the actual lateral skin at its perimeter.
    WRIST_INTERFACE_ROWS["ring"] = vertices[ring_start:ring_start+n]
    # A crop can land within micrometres of the previous retained row. Use
    # a real ring at least 1 mm distal for a stable runtime tangent secant.
    distal_row = max(i for i, t in enumerate(samples) if section(t)[0] <= interface_u - 0.001)
    WRIST_INTERFACE_ROWS["distalRing"] = vertices[distal_row*n:(distal_row+1)*n]
    SKIN_WEIGHTS[surface.name]=('palm',vertices,weights);empty('palm_root',root)
    return surface


def surface_anchor(name, parent, surface, target):
    """A real mesh point, using one consistent continuous precision normal field.

    Smooth precision normals are barycentric samples of the exact same exported
    vertex normals used by runtime material rolling; they never interpolate
    between a fabricated ideal normal and a measured triangle normal.
    """
    bpy.context.view_layer.update()
    transform = parent.matrix_world.inverted() @ surface.matrix_world
    vertices = [transform @ vertex.co for vertex in surface.data.vertices]
    smooth = surface.name.endswith("_skin")
    if smooth:
        from mathutils.geometry import barycentric_transform
        surface.data.calc_loop_triangles()
        faces = [tuple(triangle.vertices) for triangle in surface.data.loop_triangles]
        tree = BVHTree.FromPolygons(vertices, faces, all_triangles=True)
        point, facet_normal, triangle_index, _ = tree.find_nearest(Vector(target))
        tri = faces[triangle_index]
        normal_matrix = transform.to_3x3().inverted().transposed()
        normals = [(normal_matrix @ surface.data.vertices[i].normal).normalized() for i in tri]
        normal = barycentric_transform(point, *(vertices[i] for i in tri), *normals).normalized()
    else:
        tree = BVHTree.FromPolygons(vertices, [list(face.vertices) for face in surface.data.polygons])
        point, normal, _, _ = tree.find_nearest(Vector(target))
    anchor = empty(name, parent, point, normal)
    anchor['surface'] = surface.name
    anchor['normalField'] = 'barycentric-exported-smooth-vertex-normals' if smooth else 'actual-triangle-facet'
    if smooth:
        anchor['normalField'] = 'barycentric-exported-smooth-vertex-normals'
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
        longitudinal = radius * math.cos(angle)
        transverse = radius * math.sin(angle)
        if name.startswith(("thumb_", "index_")):
            # Adult precision nails have gently squared shoulders, rather
            # than the perfect oval of a separate button on a round tube.
            longitudinal = radius * math.copysign(abs(math.cos(angle)) ** 0.76, math.cos(angle))
            transverse = radius * math.copysign(abs(math.sin(angle)) ** 0.76, math.sin(angle))
        free_extension = 0.00045 * smoothstep((longitudinal - 0.55) / 0.45) if name == "middle_nail" else 0
        plane = Vector(centre) + u * (half_length * longitudinal + free_extension) + v * (half_width * transverse)
        hit, _, _, _ = tree.ray_cast(plane + n * 0.025, -n, 0.05)
        if hit is None:
            hit, _, _, _ = tree.find_nearest(plane)
        # A rigid nail's free edge continues the dorsal nail-bed tangent. It
        # must not wrap down the soft fingertip like another piece of skin.
        free_edge = smoothstep((radius * math.cos(angle) - 0.45) / 0.22)
        height = hit.dot(n) * (1 - free_edge) + bed_height * free_edge
        hit = plane + n * (height - plane.dot(n))
        # Thin, seated cuticles; only the free edge projects beyond its bed.
        top.append(tuple(hit + n * (0.00004 + 0.00009 * (1 - radius*radius))))
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
    uv = [(0.5 + radius * math.cos(angle) * 0.5, 0.5 + radius * math.sin(angle) * 0.5) for radius, angle in points]
    surface_uv(ob, uv + uv)
    edge = 1 + 3 * steps  # radius .94, distal free edge, just inside the thin rim
    smooth_normal = Vector()
    for polygon in ob.data.polygons[:upper_faces]:
        if edge in polygon.vertices:
            smooth_normal += polygon.normal * polygon.area
    if smooth_normal.length < 1e-9:
        smooth_normal = n
    return ob, Vector(top[edge]), smooth_normal.normalized()


def add_clip(name, nodes, frames):
    """Bake independent named NLA tracks with a stable contact frame at zero seconds."""
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
            strip = track.strips.new(name, 1, action)
            strip.extrapolation = "NOTHING"
            node.animation_data.action = None


def add_pose_frame_clip(name, node, frames):
    node.rotation_mode = "QUATERNION"
    for frame, position, rotation in frames:
        node.location = position
        x, y, z, w = rotation
        node.rotation_quaternion = Quaternion((w, x, y, z)).normalized()
        node.keyframe_insert(data_path="location", frame=frame, group=node.name)
        node.keyframe_insert(data_path="rotation_quaternion", frame=frame, group=node.name)
    action = node.animation_data.action
    action.name = f"{node.name}_{name}"
    track = node.animation_data.nla_tracks.new(); track.name = name
    strip = track.strips.new(name, 1, action); strip.extrapolation = "NOTHING"
    node.animation_data.action = None


def pose_points(anchors):
    bpy.context.view_layer.update()
    return {name: [round(v, 9) for v in node.matrix_world.translation] for name, node in anchors.items()}


def write_exact_animation_samplers(clips, model_clips, material_clips):
    """Write runtime samples directly as standard glTF LINEAR samplers.

    Blender's forced 30 fps sampling discards fractional Tan strike/recovery
    keys. These explicit accessors preserve one shared authored clock for all
    bone, presentation and material channels, including .28 and .58 seconds.
    Geometry, source transforms and fixed skeletal translations are untouched.
    """
    raw = OUT.read_bytes()
    json_length = struct.unpack_from('<I', raw, 12)[0]
    gltf = json.loads(raw[20:20 + json_length])
    binary_header = 20 + json_length
    binary_length = struct.unpack_from('<I', raw, binary_header)[0]
    binary = bytearray(raw[binary_header + 8:binary_header + 8 + binary_length])
    nodes = {node.get('name'): i for i, node in enumerate(gltf['nodes'])}

    def accessor(values, kind, bounds=False):
        width = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[kind]
        flat = [component for value in values for component in value] if width > 1 else list(values)
        if not all(math.isfinite(value) for value in flat):
            raise ValueError('Non-finite authored animation accessor')
        while len(binary) % 4:
            binary.append(0)
        offset = len(binary)
        payload = struct.pack(f'<{len(flat)}f', *flat)
        binary.extend(payload)
        view = len(gltf['bufferViews'])
        gltf['bufferViews'].append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(payload)})
        index = len(gltf['accessors'])
        value = {'bufferView': view, 'componentType': 5126, 'count': len(values), 'type': kind}
        if bounds:
            value.update(min=[min(flat)], max=[max(flat)])
        gltf['accessors'].append(value)
        return index

    animations = []
    for name, frames in clips.items():
        times = [(frame - 1) / 30 for frame, _ in frames]
        input_accessor = accessor(times, 'SCALAR', True)
        animation = {'name': name, 'channels': [], 'samplers': []}

        def channel(node_name, path, values, clock):
            if len(clock) != len(times) or any(abs(a-b) > 1e-9 for a, b in zip(times, clock)):
                raise ValueError(f'{name}/{node_name}: bone, model and material clocks differ')
            output = accessor(values, 'VEC4' if path == 'rotation' else 'VEC3')
            sampler = len(animation['samplers'])
            animation['samplers'].append({'input': input_accessor, 'output': output, 'interpolation': 'LINEAR'})
            animation['channels'].append({'sampler': sampler, 'target': {'node': nodes[node_name], 'path': path}})

        for digit in DIGITS:
            for index, joint in enumerate(JOINTS):
                values = [pose[digit][index] for _, pose in frames]
                channel(f'{digit}_{joint}', 'rotation', [[q.x, q.y, q.z, q.w] for q in values], times)
        model_frames = model_clips[name]
        model_clock = [(frame - 1) / 30 for frame, _, _ in model_frames]
        channel('hand_pose_frame', 'translation', [position for _, position, _ in model_frames], model_clock)
        channel('hand_pose_frame', 'rotation', [rotation for _, _, rotation in model_frames], model_clock)
        for contact, material_frames in material_clips[name].items():
            material_clock = [(frame - 1) / 30 for frame, _, _ in material_frames]
            channel(contact, 'translation', [position for _, position, _ in material_frames], material_clock)
            channel(contact, 'rotation', [rotation for _, _, rotation in material_frames], material_clock)
        animations.append(animation)
    gltf['animations'] = animations
    gltf['buffers'][0]['byteLength'] = len(binary)
    encoded = json.dumps(gltf, separators=(',', ':'), ensure_ascii=False).encode()
    encoded += b' ' * ((-len(encoded)) % 4)
    total = 12 + 8 + len(encoded) + 8 + len(binary)
    OUT.write_bytes(struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(encoded), 0x4E4F534A) + encoded + struct.pack('<II', len(binary), 0x004E4942) + binary)


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
    # Blender omits default TRS properties on animated contact empties. Restore
    # their separately captured raw bind frame; clip key 1 must never become
    # the immutable source seen by a fresh runtime controller.
    for name in ANIMATED_MATERIALS:
        position, rotation = MATERIAL_BIND_FRAMES[name]
        gltf["nodes"][nodes[name]]["translation"] = list(position)
        rotation = rotation.normalized()
        # Match the built-in static glTF export's near-zero/unit quaternion
        # snapping (2e-6), including its removal of matrix-decompose noise.
        values = [rotation.x, rotation.y, rotation.z, rotation.w]
        values = [0.0 if abs(value) <= 2e-6 else value for value in values[:3]] + [1.0 if abs(values[3]-1) <= 2e-6 else values[3]]
        gltf["nodes"][nodes[name]]["rotation"] = values
    joint_names = [f"{digit}_{joint}" for digit in DIGITS for joint in JOINTS] + ["palm_root"]
    skeletal_rotation_nodes = {nodes[name] for name in joint_names} | {nodes["hand_pose_frame"]}
    # Keep constant, non-neutral primary rotations in the nail-work clips.
    # Blender's corresponding option also emits unchanged object locations
    # and scales; these legacy controls have no animated translation/scale.
    for animation in gltf.get("animations", []):
        animated_material_nodes = {nodes[name] for name in MATERIALS_BY_CLIP.get(animation["name"], [])}
        rotation_nodes = skeletal_rotation_nodes | animated_material_nodes
        channels = [channel for channel in animation["channels"]
                    if channel["target"]["path"] == "rotation" and channel["target"]["node"] in rotation_nodes
                    or channel["target"]["path"] == "translation" and
                    (channel["target"]["node"] == nodes["hand_pose_frame"] or channel["target"]["node"] in animated_material_nodes)]
        used = sorted({channel["sampler"] for channel in channels})
        remap = {old: new for new, old in enumerate(used)}
        animation["samplers"] = [animation["samplers"][old] for old in used]
        for channel in channels:
            channel["sampler"] = remap[channel["sampler"]]
        animation["channels"] = channels

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
    identity = Matrix.Identity(4)
    inverse_binds.extend(identity[row][column] for column in range(4) for row in range(4))
    ibm_accessor = append_accessor(struct.pack(f"<{len(inverse_binds)}f", *inverse_binds), 5126, "MAT4", len(joint_names))
    gltf["skins"] = [{"name": "continuous_hand_skin", "joints": [nodes[name] for name in joint_names], "inverseBindMatrices": ibm_accessor, "skeleton": nodes["acu_practitioner_hand"]}]
    skin_meshes = set()
    for mesh_index, exported in enumerate(gltf["meshes"]):
        name = exported.get("name")
        if name not in SKIN_WEIGHTS:
            continue
        digit, positions, weighting = SKIN_WEIGHTS[name]
        lookup = {tuple(round(v, 6) for v in p): weight for p, weight in zip(positions, weighting)}
        base_joint = list(DIGITS).index(digit) * 3 if digit != "palm" else None
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
                if digit == "palm":
                    joints.extend((15, 0, 0, 0))
                    weights.extend(weight)
                else:
                    joints.extend((base_joint, base_joint + 1, base_joint + 2, 15))
                    weights.extend(weight)
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



def bind_exported_wrist_interface():
    """Publish real glTF lateral-skin vertex indices, excluding cap-only splits."""
    raw = OUT.read_bytes()
    length = struct.unpack_from('<I', raw, 12)[0]
    gltf = json.loads(raw[20:20+length])
    offset = 20+length
    binary_length = struct.unpack_from('<I', raw, offset)[0]
    binary = raw[offset+8:offset+8+binary_length]
    node = next(node for node in gltf['nodes'] if node.get('name') == 'palm_surface')
    primitive = gltf['meshes'][node['mesh']]['primitives'][0]
    def read(index, width):
        a=gltf['accessors'][index];v=gltf['bufferViews'][a['bufferView']]
        codes={5121:('B',1),5123:('H',2),5125:('I',4),5126:('f',4)}
        code,size=codes[a['componentType']]
        start=v.get('byteOffset',0)+a.get('byteOffset',0);stride=v.get('byteStride',width*size)
        return [struct.unpack_from('<'+code*width,binary,start+i*stride) for i in range(a['count'])]
    positions=read(primitive['attributes']['POSITION'],3)
    uv=read(primitive['attributes']['TEXCOORD_0'],2)
    ids=[v[0] for v in read(primitive['indices'],1)]
    origin=Vector(SOURCE_ANATOMY['anatomyOriginM']);plane=SOURCE_ANATOMY['wristInterface']['canonicalU']
    coordinates=[(Vector(p)-origin).dot(PALM_LONGITUDINAL) for p in positions]
    lateral=set()
    for i in range(0,len(ids),3):
        triangle=ids[i:i+3]
        if not all(abs(coordinates[v]-plane)<1e-6 for v in triangle): lateral.update(triangle)
    bindings={}
    for name,points in WRIST_INTERFACE_ROWS.items():
        ring=[]
        for i,point in enumerate(points):
            candidates=[v for v,p in enumerate(positions) if v in lateral and (Vector(p)-Vector(point)).length<1e-7]
            if not candidates: raise ValueError(f'No actual lateral wrist vertex for {name}/{i}')
            ring.append(min(candidates,key=lambda v:abs(uv[v][0]-i/len(points))))
        if len(set(ring)) != len(points): raise ValueError('Wrist interface lost a material perimeter point')
        bindings[name]=ring
    node.setdefault('extras',{})['wristInterface']={
        **bindings, 'canonicalU':plane, 'normalField':'actual-exported-NORMAL',
        'internalCap':'closed collision solid; covered by runtime forearm skin',
    }
    encoded=json.dumps(gltf,separators=(',',':'),ensure_ascii=False).encode()
    encoded+=b' '*((-len(encoded))%4)
    total=12+8+len(encoded)+8+len(binary)
    OUT.write_bytes(struct.pack('<III',0x46546C67,2,total)+struct.pack('<II',len(encoded),0x4E4F534A)+encoded+struct.pack('<II',len(binary),0x004E4942)+binary)


def apply_preview_skin():
    """Evaluate the same standard linear skin in Blender for visual review.

    Production glTF consumers do this in their skinning shader. This helper is
    only for Blender still renders after sampling one of the existing clips.
    """
    bpy.context.view_layer.update()
    for name, (digit, positions, weights) in SKIN_WEIGHTS.items():
        ob = bpy.data.objects[name]
        local = ob.matrix_world.inverted()
        if digit == "palm":
            transforms = [local @ bpy.data.objects["palm_root"].matrix_world,
                          local @ bpy.data.objects["thumb_proximal"].matrix_world @ Matrix.Translation(-Vector(DIGITS["thumb"][0])),
                          Matrix.Identity(4), Matrix.Identity(4)]
        else:
            transforms = [local @ bpy.data.objects[f"{digit}_{joint}"].matrix_world @ Matrix.Translation(-Vector(DIGITS[digit][i])) for i, joint in enumerate(JOINTS)]
            transforms.append(local @ bpy.data.objects["palm_root"].matrix_world)
        for vertex, point, blend in zip(ob.data.vertices, positions, weights):
            vertex.co = sum((transforms[i] @ Vector(point) * blend[i] for i in range(len(blend))), Vector())
        ob.data.update()


def align_exported_smooth_contact_fields():
    """Sample real exported NORMAL data so material motion starts continuously.

    Blender's exporter may triangulate/split its smooth corner normals. The
    runtime samples that exported field, so attachment frames use it as well.
    This changes no mesh, point, bone, or texture bytes.
    """
    from mathutils.geometry import barycentric_transform
    raw = OUT.read_bytes()
    json_length = struct.unpack_from('<I', raw, 12)[0]
    gltf = json.loads(raw[20:20 + json_length])
    binary_header = 20 + json_length
    binary_length = struct.unpack_from('<I', raw, binary_header)[0]
    binary = raw[binary_header + 8:binary_header + 8 + binary_length]
    node_ids = {node.get('name'): i for i, node in enumerate(gltf['nodes'])}
    parents = {child: i for i, node in enumerate(gltf['nodes']) for child in node.get('children', [])}
    def world_matrix(index):
        node = gltf['nodes'][index]
        if 'matrix' in node:
            values = node['matrix']; local = Matrix(tuple(tuple(values[column*4 + row] for column in range(4)) for row in range(4)))
        else:
            x, y, z, w = node.get('rotation', [0, 0, 0, 1])
            local = Matrix.LocRotScale(Vector(node.get('translation', [0, 0, 0])), Quaternion((w, x, y, z)), Vector(node.get('scale', [1, 1, 1])))
        return world_matrix(parents[index]) @ local if index in parents else local
    def accessor(index):
        value = gltf['accessors'][index]; view = gltf['bufferViews'][value['bufferView']]
        kind = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[value['type']]
        code, size = {5121: ('B', 1), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}[value['componentType']]
        offset = view.get('byteOffset', 0) + value.get('byteOffset', 0); stride = view.get('byteStride', kind*size)
        return [struct.unpack_from('<' + code*kind, binary, offset + i*stride) for i in range(value['count'])]
    material_names = [name for name, index in node_ids.items()
                      if gltf['nodes'][index].get('extras', {}).get('normalField') == 'barycentric-exported-smooth-vertex-normals']
    for name in material_names:
        index = node_ids[name]; node = gltf['nodes'][index]; parent_matrix = world_matrix(parents[index])
        digit = name.split('_', 1)[0]
        skin_index = node_ids[f'{digit}_skin']; skin_matrix = world_matrix(skin_index)
        transform = parent_matrix.inverted() @ skin_matrix; normal_matrix = transform.to_3x3().inverted().transposed()
        primitive = gltf['meshes'][gltf['nodes'][skin_index]['mesh']]['primitives'][0]
        points = [transform @ Vector(point) for point in accessor(primitive['attributes']['POSITION'])]
        normals = [(normal_matrix @ Vector(normal)).normalized() for normal in accessor(primitive['attributes']['NORMAL'])]
        flat = [value[0] for value in accessor(primitive['indices'])]; faces = [flat[i:i+3] for i in range(0, len(flat), 3)]
        tree = BVHTree.FromPolygons(points, faces, all_triangles=True)
        origin = Vector(node.get('translation', [0, 0, 0])); point, _, triangle, distance = tree.find_nearest(origin)
        if distance > 1e-6: raise ValueError(f'{name}: exported material origin is off the real skin by {distance} metres')
        face = faces[triangle]
        normal = barycentric_transform(point, *(points[i] for i in face), *(normals[i] for i in face)).normalized()
        rotation = Vector((0, 1, 0)).rotation_difference(normal)
        node['rotation'] = [rotation.x, rotation.y, rotation.z, rotation.w]
        node.setdefault('extras', {})['normalField'] = 'barycentric-exported-smooth-vertex-normals'
        barycentric = barycentric_transform(point, *(points[i] for i in face), Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
        node['extras']['materialSurface'] = {
            'mesh': f'{digit}_skin', 'primitive': 0, 'triangle': triangle,
            'vertices': face, 'barycentric': list(barycentric),
            'parentPoint': list(origin), 'parentNormal': list(normal),
            'surfaceDistanceM': distance,
            'normalField': 'barycentric-exported-smooth-vertex-normals',
        }
    json_bytes = json.dumps(gltf, separators=(',', ':'), ensure_ascii=False).encode()
    json_bytes += b' ' * ((-len(json_bytes)) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(binary)
    OUT.write_bytes(struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(json_bytes), 0x4E4F534A) + json_bytes + struct.pack('<II', len(binary), 0x004E4942) + binary)



def validate_choreography_sources(choreography):
    """Reject choreography sampled from stale geometry or controller code."""
    provenance = choreography.get("provenance", {})
    expected = {
        "hand": "packages/server/web/stage/hand.ts",
        "physiology": "packages/server/web/stage/hand-physiology.ts",
        "nailWork": "packages/server/web/stage/hand-nail-work.ts",
        "anatomy": "tools/blender/hand_anatomy.json",
        "exporter": "tools/blender/export_hand_poses.ts",
    }
    if provenance.get("animationsRead") is not False or provenance.get("runtimeContactsValidAtEveryExportedFrame") is not True:
        raise ValueError("Choreography must come from validated live controls with input animations ignored")
    def require_hash(relative, recorded):
        path = (REPO / relative).resolve()
        if not path.is_relative_to(REPO) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != recorded:
            raise ValueError(f"Stale choreography source: {relative}; export matching hand_poses.json first")
    for name, relative in expected.items():
        recorded = provenance.get("sources", {}).get(name, {})
        if recorded.get("path") != relative:
            raise ValueError(f"Choreography lacks expected source provenance: {name}")
        require_hash(relative, recorded.get("sha256"))
    # Follow the controller's local import/export graph, including re-exported
    # core constants and future split modules. Package imports remain external.
    aliases = {"@acucraft/core": REPO / "packages/core/src/index.ts",
               "@clinicalcraft/core": REPO / ".deps/clinicalcraft/packages/core/src/index.ts"}
    imported = re.compile(r"(?:\b(?:import|export)\s+(?:(?:type\s+)?[^;]*?\s+from\s*)?|\bimport\s*\()([\"'])([^\"']+)\1")
    pending, seen = [REPO / expected["hand"]], set()
    while pending:
        path = pending.pop().resolve()
        if path in seen:
            continue
        seen.add(path)
        for _, specifier in imported.findall(path.read_text()):
            candidates = []
            if specifier.startswith("."):
                dependency = path.parent / specifier
                if dependency.suffix in (".js", ".mjs"):
                    candidates = [dependency.with_suffix(".ts" if dependency.suffix == ".js" else ".mts"), dependency]
                else:
                    candidates = [dependency, Path(str(dependency) + ".ts"), dependency / "index.ts"]
            elif specifier in aliases:
                candidates = [aliases[specifier]]
            target = next((candidate for candidate in candidates if candidate.is_file()), None)
            if target is not None and target.resolve() not in seen:
                pending.append(target)
    actual = {str(path.relative_to(REPO)) for path in seen}
    recorded = provenance.get("runtimeModules", {})
    if set(recorded) != actual:
        raise ValueError(f"Choreography controller dependency graph differs: missing {sorted(actual-set(recorded))}; unexpected {sorted(set(recorded)-actual)}")
    for relative, digest in recorded.items():
        require_hash(relative, digest)


def validate_source_handedness():
    """Verify the source points before advertising their anatomical side."""
    distal = (sum((Vector(DIGITS[digit][0]) for digit in ("index", "middle", "ring", "little")), Vector()) / 4 - Vector(WRIST)).normalized()
    radial = (Vector(DIGITS["index"][0]) - Vector(DIGITS["little"][0])).normalized()
    triad = distal.cross(radial).dot(PALM_DORSAL.normalized())
    # The independently authored pinned LEFT reference uses distal +Y, radial
    # +X and dorsal +Z: (Y cross X) dot Z = -1. This source has the opposite
    # sign; scene rotations preserve it and the runtime supplies the left mirror.
    if SOURCE_ANATOMY.get("sourceHandedness") != "right" or triad <= 0.8:
        raise ValueError(f"Source handedness disagrees with the actual wrist/MCP/palm triad: {triad}")
    return triad


def build(calibration_only=False):
    validate_source_handedness()
    # Calibration deliberately does not consume hand_poses.json, so a changed
    # anatomical source can be exported before the live controller is sampled.
    choreography = {"sequences": {}} if calibration_only else json.loads(POSES.read_text())
    if not calibration_only:
        validate_choreography_sources(choreography)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    SKIN_WEIGHTS.clear()
    ANIMATED_MATERIALS.clear()
    MATERIALS_BY_CLIP.clear()
    MATERIAL_BIND_FRAMES.clear()
    WRIST_INTERFACE_ROWS.clear()
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.frame_start, scene.frame_end = 1, 31
    asset_root = empty("acu_practitioner_hand")
    asset_root["license"] = "CC0-1.0"
    asset_root["sourceHandedness"] = SOURCE_ANATOMY["sourceHandedness"]
    asset_root["source"] = "AcuCraft tools/blender/build_hand.py; original procedural geometry and PBR textures"
    asset_root["units"] = "metres; +Y needle axis; raised reference hold"
    asset_root["assetPurpose"] = "geometry-calibration-only" if calibration_only else "production-articulated-hand"
    root = empty("hand_pose_frame", asset_root)
    root["runtimeContract"] = "Authored clip frame; reset before applying live operator model transform"
    skin = material("hand_skin", (0.64, 0.40, 0.27))
    nail = material("hand_nails", (0.70, 0.49, 0.39), 0.36)
    detail_textures(skin, nail)
    palm_surface = palm(root, skin)
    empty("wrist", root, WRIST)
    palm_frame = empty("palm_frame", root, PALM_CENTRE)
    palm_frame.rotation_mode = "QUATERNION"
    palm_frame.rotation_quaternion = PALM_BASIS.to_quaternion()
    palm_frame["forwardAxis"] = "-X toward fingers; -Y volar; +Z radial"
    palm_frame["sourceHandedness"] = SOURCE_ANATOMY["sourceHandedness"]
    palm_frame["contactFrameHorizontalBranch"] = SOURCE_ANATOMY["contactFrameHorizontalBranch"]
    wrist_frame = empty("wrist_frame", root, WRIST)
    wrist_frame.rotation_mode = "QUATERNION"
    wrist_frame.rotation_quaternion = PALM_BASIS.to_quaternion()
    empty("pinch", root)
    anchors = {}
    palm_surface.data.calc_loop_triangles()
    heel_target = anatomy_point((0.070 * SOURCE_ANATOMY['wristCanonicalM'][0] / 0.085, -0.013, -0.025))
    heel = min(palm_surface.data.loop_triangles,
               key=lambda triangle: ((sum((palm_surface.data.vertices[i].co for i in triangle.vertices), Vector()) / 3) - heel_target).length_squared)
    heel_point = sum((palm_surface.data.vertices[i].co for i in heel.vertices), Vector()) / 3
    anchors["palm_contact"] = empty("palm_contact", bpy.data.objects["palm_root"], heel_point, heel.normal)
    anchors["palm_contact"]["surface"] = "palm_surface"
    anchors["palm_contact"]["feature"] = "ulnar-heel"
    anchors["palm_contact"]["normalField"] = "actual-triangle-facet"
    # The legacy fallback is the same real, entirely static heel facet.
    # A nearest point on an untriangulated curved quad need not lie on the
    # final glTF triangles and must not stand in for a material attachment.
    anchors["support_contact"] = empty("support_contact", bpy.data.objects["palm_root"], heel_point, heel.normal)
    anchors["support_contact"]["surface"] = "palm_surface"
    anchors["support_contact"]["feature"] = "legacy-ulnar-heel-alias"
    anchors["support_contact"]["normalField"] = "actual-triangle-facet"
    anchors["support_contact"]["aliases"] = "palm_contact"
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
                width = PALM_RADIAL.copy()
                width -= axis * width.dot(axis)
                dorsal = -END_VOLARS[digit].copy()
                nail_axis = delta
                # Preserve the longitudinal nail-bed coordinate. A nearest
                # point search from far outside can slide along the rounded
                # tip, placing the whole nail beyond its intended free edge.
                nail_centre = delta * 0.67
                nail_width = {"thumb": 0.78, "index": 0.72, "middle": 0.82, "ring": 0.72, "little": 0.70}[digit]
                nail_surface, nail_edge, nail_normal = nail_plate(f"{digit}_nail", node, surface, nail_centre, dorsal, nail_axis, delta.length * 0.28, r * nail_width, nail)
                if precision:
                    target = PAD_TARGETS[digit] - start
                else:
                    volar = END_VOLARS[digit]
                    target = delta * 0.86 + volar * (r * 0.85)
                pad = surface_anchor(f"{digit}_pad_contact", node, surface, target)
                if precision:
                    # At the crest, the analytic smooth-surface normal is exactly
                    # toward the gap. A single adjacent triangle's facet normal
                    # must not rotate the whole finger away from the handle.
                    pad.rotation_quaternion = Vector((0, 1, 0)).rotation_difference(PAD_NORMALS[digit])
                anchors[pad.name] = pad
                if precision:
                    # Material points move over this real rigid distal-skin patch during
                    # pad rolling. Every attachment is projected to actual triangles;
                    # no contact is translated through empty space to imply motion.
                    # Rolling around the +Y needle follows its circumferential
                    # tangent, independent of the anatomical long axis of the
                    # distal phalanx. Opposing pulp normals yield -X/+X here.
                    terminal = toward_gap.cross(Vector((0, 1, 0))).normalized()
                    for sample in range(-3, 4):
                        offset = sample * 0.0007 / 3
                        marker = f"{digit}_pad_roll_{'m' if sample < 0 else 'p' if sample > 0 else 'c'}{abs(sample)}_contact"
                        point = surface_anchor(marker, node, surface, pad.location + terminal * offset)
                        point["feature"] = "rolling-pad-surface"
                        point["offsetMm"] = offset * 1000
                        anchors[point.name] = point
                if digit == "index":
                    target_side = delta * 0.60 + PALM_RADIAL * 0.0068
                    side = surface_anchor("index_side_contact", node, surface, target_side)
                    side["feature"] = "radial-side-pulp"
                    anchors[side.name] = side
                    # Surface pressing uses the true volar fingertip, separately
                    # from the lateral pulp that pinches the needle handle.
                    surface.data.calc_loop_triangles()
                    forward = delta.normalized()
                    volar_normal = END_VOLARS["index"]
                    source_weights = SKIN_WEIGHTS[surface.name][2]
                    target = PAD_TARGETS['index'] + forward * 0.004 - volar_normal * 0.0015
                    desired_normal = (volar_normal + forward).normalized()
                    candidates = [triangle for triangle in surface.data.loop_triangles if all(source_weights[i][2] > 0.9999 for i in triangle.vertices) and triangle.normal.dot(volar_normal) > 0.4 and triangle.normal.dot(forward) > 0.4 and ((sum((surface.data.vertices[i].co for i in triangle.vertices), Vector()) / 3) - PAD_TARGETS['index']).length < 0.012]
                    if not candidates: raise ValueError('No real rigid volar-distal index facet')
                    face = min(candidates, key=lambda triangle: 1 - triangle.normal.dot(desired_normal) + 0.001 * (((sum((surface.data.vertices[i].co for i in triangle.vertices), Vector()) / 3) - target).length / 0.012) ** 2)
                    feature = 'true-volar-distal-tip'
                    point = sum((surface.data.vertices[i].co for i in face.vertices), Vector()) / 3
                    volar = empty('index_volar_contact', node, point - start, face.normal)
                    volar['surface'] = surface.name; volar['feature'] = feature
                    volar['normalField'] = 'actual-triangle-facet'
                    anchors[volar.name] = volar
                # Both names are offered while existing runtime integrations migrate to *_pad_contact.
                empty(f"{digit}_pad", node, pad.location, pad.rotation_quaternion @ Vector((0, 1, 0)))
                if digit == "middle":
                    side_target = delta * (1 - 0.004 / delta.length) + PALM_RADIAL * -0.0063096
                    side = surface_anchor("middle_side_contact", node, surface, side_target)
                    anchors[side.name] = side
                    radial = surface_anchor("middle_radial_contact", node, surface, delta * (1 - 0.004 / delta.length) + PALM_RADIAL * 0.0063096)
                    radial["feature"] = "radial-side-pulp"
                    anchors[radial.name] = radial
                    for sign, side_name in ((-1, "ulnar"), (1, "radial")):
                        for percent in (55, 65, 72, 78, 88, 98, 108):
                            point = surface_anchor(f"middle_{side_name}_pulp_{percent}_contact", node, surface, delta * (percent / 100) + PALM_RADIAL * (sign * 0.0065))
                            point["feature"] = "oblique-fore-side-pulp"
                            anchors[point.name] = point
                    for percent in (55, 65, 72, 78, 88, 98):
                        for role, cross in [('volar', END_VOLARS[digit]), ('volar_radial', (END_VOLARS[digit] + PALM_RADIAL).normalized())]:
                            point = surface_anchor(f'middle_{role}_pulp_{percent}_contact', node, surface, delta * (percent/100) + cross * 0.0060)
                            point['feature'] = 'true-' + role.replace('_', '-') + '-pulp'; anchors[point.name] = point
                    # The bounded three-finger hold uses the actual radial
                    # fore-side pulp. Preserve its measured point and facet
                    # orientation rather than an idealized lateral normal.
                    bearing = anchors["middle_radial_pulp_78_contact"]
                    side.location = bearing.location
                    side.rotation_quaternion = bearing.rotation_quaternion
                    side["feature"] = "oblique-fore-side-pulp"
                nail_anchor = empty(f"{digit}_nail_contact", node, nail_edge, nail_normal)
                nail_anchor["surface"] = nail_surface.name
                nail_anchor["normalField"] = "area-weighted-nail-bed"
                anchors[nail_anchor.name] = nail_anchor
                if digit == "index":
                    # The index's leading free edge is distinct from its
                    # dorsal nail bed. Gua/Tan can acquire an actual shared
                    # edge normal cone at runtime; the immutable bind marker
                    # starts on this real front rim triangle.
                    nail_surface.data.calc_loop_triangles()
                    front = nail_surface.data.loop_triangles[-1]
                    point = sum((nail_surface.data.vertices[i].co for i in front.vertices), Vector()) / 3
                    edge = empty("index_nail_edge_contact", node, point, front.normal)
                    edge["surface"] = nail_surface.name
                    edge["feature"] = "distal-leading-free-edge"
                    edge["normalField"] = "actual-triangle-facet"
                    edge["sourceTriangle"] = front.index
                    anchors[edge.name] = edge
                if digit == "middle":
                    # Scraping/flicking can use the lateral rim while the thumb
                    # and index keep their ordinary pad pinch. Select a real
                    # front-side rim face, not the dorsal nail-bed surface.
                    rim = [p for p in nail_surface.data.polygons[-24:]
                           if p.normal.dot(-PALM_RADIAL) > 0.99 and p.normal.dot(axis) > 0]
                    if not rim:
                        raise ValueError("The middle nail has no usable lateral rim")
                    face = max(rim, key=lambda p: p.normal.dot(-PALM_RADIAL))
                    point = sum((nail_surface.data.vertices[i].co for i in list(face.vertices)[:3]), Vector()) / 3
                    lateral = empty("middle_nail_lateral_contact", node, point, face.normal)
                    lateral["surface"] = nail_surface.name
                    lateral["feature"] = "lateral-rim"
                    anchors[lateral.name] = lateral
                    # The active contact is the actual front free edge. A
                    # maximum-lateral-normal rim is around 69% of the phalanx,
                    # where neighbouring pulp would reach the handle first.
                    nail_surface.data.calc_loop_triangles()
                    front = nail_surface.data.loop_triangles[-1]
                    point = sum((nail_surface.data.vertices[i].co for i in front.vertices), Vector()) / 3
                    edge = empty("middle_nail_edge_contact", node, point, front.normal)
                    edge["surface"] = nail_surface.name
                    edge["feature"] = "distal-free-edge"
                    anchors[edge.name] = edge
                    for degrees in (10, 20, 30, 40):
                        candidates = [p for p in nail_surface.data.polygons[-24:]
                                      if p.normal.dot(-PALM_RADIAL) > 0.65 and p.normal.dot(axis) > 0]
                        face = min(candidates, key=lambda p: abs(math.degrees(math.atan2(p.normal.dot(axis), p.normal.dot(-PALM_RADIAL))) - degrees))
                        point = sum((nail_surface.data.vertices[i].co for i in list(face.vertices)[:3]), Vector()) / 3
                        sample = empty(f"middle_nail_oblique_{degrees}_contact", node, point, face.normal)
                        sample["surface"] = nail_surface.name
                        sample["feature"] = "fore-lateral-rim"
                        anchors[sample.name] = sample
            parent = node
    empty("thumb_contact", root, (0, 0, -0.0007))
    empty("index_contact", root, (0, 0, 0.0007))

    clips, model_clips, material_clips = {}, {}, {}
    material_poses, active_materials, contacts_by_pose = {}, {}, {}
    if not calibration_only:
        # The exported choreography uses the same fixed-hinge solutions and real
        # material attachments as the runtime controls, including the index nail
        # free edge used by scrape/flick and their distinct preparation contacts.
        authored = choreography["poses"]
        material_poses = choreography.get("materialPoses", {})
        active_materials = choreography.get("activeContacts", {})
        bpy.context.view_layer.update()
        material_bind = {name: (node.location.copy(), node.rotation_quaternion.copy()) for name, node in anchors.items()}
        # Match the static exporter's parent-local matrix decomposition, including
        # its float32 rounding, instead of substituting an animation's first key.
        for name, node in anchors.items():
            position, rotation, _ = node.matrix_local.decompose()
            MATERIAL_BIND_FRAMES[name] = (position.copy(), rotation.copy())

        def material_pose_name(name):
            return "scrape_end" if name == "scrape" else name

        def apply_material_pose(name):
            for contact, (position, rotation) in material_bind.items():
                anchors[contact].location = position
                anchors[contact].rotation_quaternion = rotation
            for contact, value in material_poses.get(material_pose_name(name), {}).items():
                if contact not in anchors or not contact.endswith("_contact") or "surface" not in anchors[contact]:
                    raise ValueError(f"Material animation must use a real surface attachment: {contact}")
                if value.get("parent", anchors[contact].parent.name) != anchors[contact].parent.name:
                    raise ValueError(f"{name}/{contact}: exported material parent differs from the source bone")
                if value.get("surface", anchors[contact]["surface"]) != anchors[contact]["surface"]:
                    raise ValueError(f"{name}/{contact}: exported material surface differs from the source")
                anchors[contact].location = value["position"]
                anchors[contact].rotation_mode = "QUATERNION"
                anchors[contact].rotation_quaternion = quat(value["quaternion"])
        def quat(values):
            x, y, z, w = values
            return Quaternion((w, x, y, z)).normalized()

        def authored_pose(name):
            return {digit: [quat(authored[name][f"{digit}_{joint}"]) for joint in JOINTS] for digit in DIGITS}

        def authored_sequence(name, base):
            sequence = choreography["sequences"][name]
            frames = []
            for frame, *rotations in sequence["frames"]:
                pose = {digit: list(values) for digit, values in base.items()}
                for name, values in zip(sequence["joints"], rotations):
                    digit, joint = name.rsplit("_", 1)
                    pose[digit][JOINTS.index(joint)] = quat(values)
                frames.append((frame, pose))
            return frames
        neutral = authored_pose("pinch")
        opened = authored_pose("open")
        support = authored_pose("support")
        tripod = authored_pose("three_finger")
        scrape_start = authored_pose("scrape_start")
        scrape = authored_pose("scrape_end")
        flick_loaded = authored_pose("flick_loaded")
        flick_release = authored_pose("flick_release")
        flick_return = authored_pose("flick_return")
        clips = {
            "hand_open": authored_sequence("open", neutral),
            "hand_support": [(1, support), (31, support)],
            "hand_three_finger": [(1, tripod), (31, tripod)],
            "hand_scrape": authored_sequence("scrape", scrape_start),
            "hand_flick": authored_sequence("flick", scrape_start),
        }
        for name, frames in clips.items():
            add_clip(name, nodes, frames)
        pose_frames = choreography.get("poseFrames", {})
        def model_pose(name):
            if name == "scrape":
                name = "scrape_end"
            value = pose_frames.get(name, {})
            return value.get("modelPosition", [0, 0, 0]), value.get("modelQuaternion", [0, 0, 0, 1])
        model_clips = {}
        for clip, sequence, first_pose in [("hand_open", "open", "pinch"), ("hand_support", None, "support"),
                                           ("hand_three_finger", None, "three_finger"), ("hand_scrape", "scrape", "scrape_start"),
                                           ("hand_flick", "flick", "flick_loaded")]:
            frames = choreography["sequences"].get(sequence, {}).get("modelFrames") if sequence else None
            if not frames:
                position, rotation = model_pose(first_pose)
                frames = [(1, position, rotation), (31, position, rotation)]
            model_clips[clip] = frames
            add_pose_frame_clip(clip, root, frames)

        # A material attachment can migrate on rigid distal skin without moving
        # any bone pivot. Bake only the active canonical *_contact aliases, using
        # their real runtime material P/Q and explicit per-role normal provenance.
        material_clips = {}
        for clip, sequence, first_pose in [("hand_open", "open", "pinch"), ("hand_support", None, "support"),
                                           ("hand_three_finger", None, "three_finger"), ("hand_scrape", "scrape", "scrape_start"),
                                           ("hand_flick", "flick", "flick_loaded")]:
            entries = choreography["sequences"].get(sequence, {}).get("contactFrames", {}) if sequence else {}
            names = active_materials.get(first_pose, list(entries))
            if entries and set(entries) != set(names):
                raise ValueError(f"{clip}: active materials and contactFrames differ")
            if material_poses and sequence and not entries:
                raise ValueError(f"{clip}: matching runtime export must supply all material frames")
            tracks = {}
            for contact in names:
                if contact not in anchors or not contact.endswith("_contact") or "surface" not in anchors[contact]:
                    raise ValueError(f"Cannot animate a non-surface or skeletal contact: {contact}")
                definition = choreography["sequences"].get(sequence, {}).get("materialDefinitions", {}).get(contact, {}) if sequence else {}
                if definition.get("parent", anchors[contact].parent.name) != anchors[contact].parent.name:
                    raise ValueError(f"{clip}/{contact}: material track parent differs from the source")
                if definition.get("surface", anchors[contact]["surface"]) != anchors[contact]["surface"]:
                    raise ValueError(f"{clip}/{contact}: material track surface differs from the source")
                frames = entries.get(contact)
                if frames is None:
                    value = material_poses[first_pose][contact]
                    frames = [(1, value["position"], value["quaternion"]), (31, value["position"], value["quaternion"])]
                if sequence:
                    expected = sorted(set([i/30 for i in range(31)] + ([.08, .28, .5, .58] if sequence == 'flick' else [])))
                    actual = [(frame - 1) / 30 for frame, _, _ in frames]
                    if len(actual) != len(expected) or any(abs(a-b) > 1e-9 for a, b in zip(actual, expected)):
                        raise ValueError(f"{clip}/{contact}: expected the exact authored sampling clock")
                if any(len(position) != 3 or len(rotation) != 4 or not all(math.isfinite(v) for v in (*position, *rotation))
                       for _, position, rotation in frames):
                    raise ValueError(f"{clip}/{contact}: non-finite material frame")
                ANIMATED_MATERIALS.add(contact)
                add_pose_frame_clip(clip, anchors[contact], frames)
                tracks[contact] = frames
            material_clips[clip] = tracks
            MATERIALS_BY_CLIP[clip] = list(tracks)

        # Measure the real contact transforms of each authored pose for both runtime attachment and tests.
        animated_nodes = [*nodes.values(), root, *(anchors[name] for name in sorted(ANIMATED_MATERIALS))]
        for node in animated_nodes:
            for track in node.animation_data.nla_tracks:
                track.mute = True
        contacts_by_pose = {}
        for name, pose in {"pinch": neutral, "open": opened, "support": support, "three_finger": tripod, "scrape_start": scrape_start, "scrape": scrape, "flick_loaded": flick_loaded, "flick_release": flick_release, "flick_return": flick_return}.items():
            position, rotation = model_pose(name)
            root.location = position
            root.rotation_quaternion = quat(rotation)
            for digit in DIGITS:
                for i, joint in enumerate(JOINTS):
                    nodes[f"{digit}_{joint}"].rotation_quaternion = pose[digit][i]
            apply_material_pose(name)
            contacts_by_pose[name] = pose_points(anchors)
        # Bind the static skin in the true source pose. Scrape/flick intentionally
        # start in their own stable hold, so their first animation keys cannot also
        # supply the common mesh bind frame.
        scene.frame_set(0)
        root.location = (0, 0, 0)
        for node in [*nodes.values(), root]:
            node.rotation_quaternion = Quaternion()
        # The raw source material frame is immutable. Animation's key at t=0
        # belongs to the one-second clip, never to the shared skeleton bind.
        apply_material_pose("__source_bind__")
        for node in animated_nodes:
            for track in node.animation_data.nla_tracks:
                track.mute = False
        bpy.context.view_layer.update()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUT), export_format="GLB", export_yup=False,
        export_animations=not calibration_only, export_nla_strips=True,
        export_animation_mode="NLA_TRACKS", export_force_sampling=True,
        export_optimize_animation_keep_anim_object=True,
        export_anim_slide_to_zero=True,
        export_extras=True, export_cameras=False, export_lights=False,
    )

    bind_continuous_skins()
    bind_exported_wrist_interface()
    if not calibration_only:
        write_exact_animation_samplers(clips, model_clips, material_clips)
    align_exported_smooth_contact_fields()

    # Manifest records the binary's actual contract, without geometry patient data.
    raw = OUT.read_bytes()
    json_length = struct.unpack_from("<I", raw, 12)[0]
    gltf = json.loads(raw[20:20 + json_length])
    triangles = sum(gltf["accessors"][p["indices"]]["count"] // 3 for m in gltf["meshes"] for p in m["primitives"])
    exported_nodes = {node.get("name"): node for node in gltf["nodes"]}
    manifest = {
        "file": str(OUT) if calibration_only else "assets/models/acu-practitioner-hand.glb",
        "buildMode": "geometry-calibration-only" if calibration_only else "production-articulated-hand",
        "sourceHandedness": SOURCE_ANATOMY["sourceHandedness"],
        "license": "CC0-1.0", "source": "tools/blender/build_hand.py",
        "choreography": None if calibration_only else "tools/blender/hand_poses.json",
        "choreographySha256": None if calibration_only else hashlib.sha256(POSES.read_bytes()).hexdigest(),
        "choreographyProvenance": choreography.get("provenance", {}),
        "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
        "triangles": triangles, "root": asset_root.name, "authoredPoseFrame": root.name,
        "coordinates": "metres; +Y along needle; complete baked model-space palm basis; opposed true-volar rest pinch",
        "wrist": list(WRIST), "pinch": [0, 0, 0],
        "baselineElevationDeg": math.degrees(math.atan2(WRIST[1], math.hypot(WRIST[0], WRIST[2]))),
        "palmFrame": {"node": "palm_frame", "angleDeg": math.degrees(PALM_FRAME_ANGLE), "forward": "-X", "volar": "-Y", "radial": "+Z", "basisColumns": SOURCE_ANATOMY["palmBasisColumns"], "contactFrameHorizontalBranch": SOURCE_ANATOMY["contactFrameHorizontalBranch"]},
        "tips": {d: list(points[-1]) for d, points in DIGITS.items()},
        "contact": {"thumb": [0, 0, -0.0007], "index": [0, 0, 0.0007]},
        "joints": {d: [f"{d}_{j}" for j in JOINTS] for d in DIGITS},
        "anatomicalJoints": {d: [f"{d}_{j}" for j in ANATOMICAL[d]] for d in DIGITS},
        "anatomicalMapping": {f"{d}_{j}": f"{d}_{ANATOMICAL[d][i]}" for d in DIGITS for i, j in enumerate(JOINTS)},
        "skin": {"surfaces": list(SKIN_WEIGHTS), "joints": [f"{d}_{j}" for d in DIGITS for j in JOINTS] + ["palm_root"], "weights": "smooth neighbouring-joint blend and proximal palm/MCP transition; contact-bearing distal vertices are rigid; connected palm uses static/CMC blend", "staticInfluence": "palm_root", "clone": "SkeletonUtils.clone is required for independent hands"},
        "wristInterface": exported_nodes["palm_surface"]["extras"]["wristInterface"],
        "palm": {"surface": "palm_surface", "topology": "single closed connected skin including thenar", "thenar": {"region": "localized radial-palmar quadrant", "maximumCmcWeight": THUMB_TISSUE["maximumThenarCmcWeight"]}, "knuckles": "asymmetric MCP arch and dorsal metacarpal contours", "frame": "palm_frame", "shape": "localized thenar and hypothenar cushions with central palmar hollow; hidden thumb connector follows the true skin envelope"},
        "restAnatomy": {"thumb": {"points": {joint: list(point) for joint, point in zip((*ANATOMICAL["thumb"], "tip"), DIGITS["thumb"])},
                                  "boneLengthsMm": [(Vector(DIGITS["thumb"][i + 1]) - Vector(DIGITS["thumb"][i])).length * 1000 for i in range(3)],
                                  "flexionDeg": [(Vector(DIGITS["thumb"][i]) - Vector(DIGITS["thumb"][i - 1])).angle(Vector(DIGITS["thumb"][i + 1]) - Vector(DIGITS["thumb"][i])) * 180 / math.pi for i in (1, 2)],
                                  "hinges": "coplanar and consistently signed; CMC near the carpal frame; bone lengths fixed throughout animation"}},
        "contactAnchors": {name: {"node": name, "normalAxis": "+Y", "follows": node.parent.name, **({"surface": node["surface"]} if "surface" in node else {}), **({"feature": node["feature"]} if "feature" in node else {}), **({"normalField": node["normalField"]} if "normalField" in node else {}), **({"materialSurface": exported_nodes[name]["extras"]["materialSurface"]} if "materialSurface" in exported_nodes[name].get("extras", {}) else {})} for name, node in anchors.items()},
        "rollingPatches": {digit: {"surface": f"{digit}_skin", "joint": f"{digit}_distal", "axis": "bind samples on real skin; runtime derives the live circumferential tangent from the posed pulp normal crossed with +Y needle axis", "extentMm": 0.7,
            "samples": [{"node": name, "offsetMm": round(node["offsetMm"], 9), "position": [round(v, 9) for v in node.location],
                         "normal": [round(v, 9) for v in node.rotation_quaternion @ Vector((0, 1, 0))]}
                        for name, node in anchors.items() if name.startswith(f"{digit}_pad_roll_")]}
                           for digit in ("thumb", "index")},
        "poseContacts": contacts_by_pose,
        "materialAnimation": {
            "baked": bool(material_poses), "source": None if calibration_only else "tools/blender/hand_poses.json",
            "provenance": choreography.get("provenance", {}),
            "bindFrame": "raw source restored at Blender frame 0 and explicitly in exported glTF; clip time zero is independent",
            "activeContacts": active_materials, "poseMaterials": material_poses,
            "clipContacts": {clip: list(tracks) for clip, tracks in material_clips.items()},
            "clipMaterialFrames": {clip: {name: [{"time": (frame-1)/30, "position": list(position), "rotation": list(rotation)}
                for frame, position, rotation in frames] for name, frames in tracks.items()} for clip, tracks in material_clips.items()},
            "materialDefinitions": {name: value.get("materialDefinitions", {}) for name, value in choreography["sequences"].items()},
            "sourceBindings": {name: {"position": exported_nodes[name].get("translation", [0, 0, 0]),
                "rotation": exported_nodes[name].get("rotation", [0, 0, 0, 1]), "surface": anchors[name]["surface"],
                "normalField": exported_nodes[name].get("extras", {}).get("normalField")}
                for name in sorted(ANIMATED_MATERIALS)},
        },
        "materials": ["hand_skin", "hand_nails"],
        "animations": [a["name"] for a in gltf.get("animations", [])],
        "animation": "Geometry calibration only; no choreography consumed and no animation clips exported." if calibration_only else "Every clip is 0..1 second and carries its actual whole-hand presentation frame. Source bone lengths and skeletal control translations remain fixed; bone motion uses rotations and the complete hand frame. Canonical contact aliases independently carry the actual material point positions and orientations on skin or keratin. Supporting index contact uses a real rounded volar-distal fingertip facet. Primary grip, third-finger pulp and nail-work roles use actual skin or keratin surfaces. Scrape has a 6 mm axial stroke. Live runtime resets hand_pose_frame before applying operator controls. The matching hand_poses.json supplies the final authored layouts.",
        "clipFrames": {name: [round((frame - 1) / 30, 9) for frame, _ in frames] for name, frames in clips.items()},
        "modelClipFrames": {name: [{"time": round((frame - 1) / 30, 9), "position": list(position), "rotation": list(rotation)} for frame, position, rotation in frames] for name, frames in model_clips.items()},
        "sourceAnatomy": {"file": "tools/blender/hand_anatomy.json", "sourceHandedness": SOURCE_ANATOMY["sourceHandedness"], "sha256": hashlib.sha256(ANATOMY_SOURCE.read_bytes()).hexdigest(), "primaryMaterialContactNames": SOURCE_ANATOMY["materialContactNames"], "materialContactNames": [name for name, node in exported_nodes.items() if "materialSurface" in node.get("extras", {})], "thumbMetacarpalSoftTissue": THUMB_TISSUE, "wristCanonicalM": SOURCE_ANATOMY["wristCanonicalM"], "thumbCmcCanonicalMm": SOURCE_ANATOMY["thumbCmcCanonicalMm"], "wristToThumbCmcMm": SOURCE_ANATOMY["wristToThumbCmcMm"], "adultLengthsMm": SOURCE_ANATOMY["adultLengthsMm"], "sourceAnglesDeg": SOURCE_ANATOMY["sourceAnglesDeg"], "skinNailFrame": "one transported anatomical frame; true volar pulp opposite the dorsal nail"},
        "review": "authored anatomical visualization; no clinical calibration or motion-capture claim",
    }
    if triangles >= 24000 or len(raw) >= 1600000:
        raise ValueError(f"Hand exceeds the production asset budget: {triangles} triangles, {len(raw)} bytes")
    expected_clips = 0 if calibration_only else 5
    if len(manifest["animations"]) != expected_clips:
        raise ValueError(f"Expected {expected_clips} animation clips, got {manifest['animations']}")
    if not calibration_only:
        validate_choreography_sources(choreography)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Hand: {triangles} triangles; {len(raw)} bytes; clips {manifest['animations']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration-only", action="store_true", help="Export geometry and source binds only, with no choreography or animation")
    parser.add_argument("--output", type=Path, help="Explicit GLB destination; pair with --manifest")
    parser.add_argument("--manifest", type=Path, help="Explicit manifest destination; pair with --output")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if bool(args.output) != bool(args.manifest):
        parser.error("--output and --manifest must be supplied together")
    if args.calibration_only and not args.output:
        parser.error("--calibration-only requires explicit --output and --manifest destinations")
    if args.output:
        output, manifest = args.output.resolve(), args.manifest.resolve()
        if output.suffix != ".glb" or manifest.suffix != ".json" or output == manifest:
            parser.error("Use distinct .glb and .json output destinations")
        if args.calibration_only and (output == OUT.resolve() or manifest == MANIFEST.resolve()):
            parser.error("Calibration must not overwrite either production artifact")
        OUT, MANIFEST = output, manifest
    build(calibration_only=args.calibration_only)
