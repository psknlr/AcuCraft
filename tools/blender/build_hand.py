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
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "content/world/assets/models/acu-practitioner-hand.glb"
MANIFEST = Path(__file__).with_name("hand.json")
DIGITS = {
    "thumb": [(0.061, 0.056, 0.0309464), (0.038, 0.018, 0.0178732), (0.015, 0.003, 0.0048000), (-0.004, 0.000, -0.0059996)],
    "index": [(0.012, 0.060, 0.027), (-0.016, 0.035, 0.01825), (-0.012, 0.016, 0.0116), (0.004, 0.000, 0.006)],
    "middle": [(0.009, 0.057, 0.007), (0.000868272, 0.019594051, 0.007), (0.017944901, -0.002361614, 0.007), (0.039087394, -0.000735269, 0.007)],
    "ring": [(0.014, 0.063, -0.013), (0.009120963, 0.028846742, -0.013), (0.027010765, 0.010956941, -0.013), (0.046526912, 0.015835978, -0.013)],
    "little": [(0.027, 0.066, -0.031), (0.024030152, 0.037786439, -0.031), (0.038879394, 0.025907046, -0.031), (0.055213561, 0.030361818, -0.031)],
}
WRIST = (0.080, 0.110, 0.0)
PALM_CENTRE = (0.048, 0.086, -0.002)
PALM_FRAME_ANGLE = math.atan2(WRIST[1] - 0.0615, WRIST[0] - 0.0155)
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


def detail_textures(skin, nail):
    """Original deterministic PBR detail, packed into the GLB with the mesh UVs.

    Geometry supplies the folds and contact surfaces. These fine variations add
    pores, fingertip ridges and nail-bed detail without inventing anatomy from
    an AI-generated reference photograph or pretending to measure contact force.
    """
    size = 512
    albedo, normal, roughness = [], [], []
    def height(u, v):
        pore = math.sin(u * math.tau * 97 + math.sin(v * 71.0)) * math.sin(v * 673.0 + math.sin(u * math.tau * 13))
        grain = math.sin(u * math.tau * 29 + v * 193.0) * 0.12 + math.sin(u * math.tau * 56 - v * 347.0) * 0.08
        pad = math.exp(-((v - 0.90) / 0.12) ** 2) * max(0, math.cos(u * math.tau)) ** 4
        fingerprint = math.sin(math.tau * (v * 94.0 + math.sin(u * math.tau) * 2.2)) * pad * 0.16
        return pore * 0.15 + grain + fingerprint
    for y in range(size):
        v = y / (size - 1)
        for x in range(size):
            u = x / (size - 1)
            h = height(u, v)
            mottle = math.sin(u * math.tau * 3 + v * 13.0) * math.sin(v * 23.0 - u * math.tau)
            albedo.extend((0.965 + h * 0.010, 0.940 + h * 0.009 - mottle * 0.006, 0.925 + h * 0.008 - mottle * 0.009, 1))
            dx = (height(u + 1 / size, v) - height(u - 1 / size, v)) * 0.075
            dy = (height(u, v + 1 / size) - height(u, v - 1 / size)) * 0.075
            n = Vector((-dx, -dy, 1)).normalized()
            normal.extend((n.x * 0.5 + 0.5, n.y * 0.5 + 0.5, n.z * 0.5 + 0.5, 1))
            roughness.extend((1, 0.54 + h * 0.025 + mottle * 0.025, 0, 1))
    def image(name, pixels, noncolor=False, dimension=size):
        value = bpy.data.images.new(name, width=dimension, height=dimension, alpha=True)
        if noncolor: value.colorspace_settings.name = "Non-Color"
        value.pixels.foreach_set(pixels)
        value.pack()
        return value
    nodes, links = skin.node_tree.nodes, skin.node_tree.links
    shader = nodes.get("Principled BSDF")
    for name, pixels, socket, noncolor in [("skin_albedo", albedo, "Base Color", False), ("skin_normal", normal, None, True), ("skin_roughness", roughness, None, True)]:
        texture = nodes.new("ShaderNodeTexImage"); texture.image = image(name, pixels, noncolor)
        if socket:
            multiply = nodes.new("ShaderNodeMix"); multiply.data_type = "RGBA"; multiply.blend_type = "MULTIPLY"
            multiply.inputs[0].default_value = 1
            multiply.inputs[7].default_value = (0.64, 0.40, 0.27, 1)
            links.new(texture.outputs["Color"], multiply.inputs[6]); links.new(multiply.outputs[2], shader.inputs[socket])
        elif name == "skin_normal":
            node = nodes.new("ShaderNodeNormalMap"); node.inputs["Strength"].default_value = 0.20
            links.new(texture.outputs["Color"], node.inputs["Color"]); links.new(node.outputs["Normal"], shader.inputs["Normal"])
        else:
            node = nodes.new("ShaderNodeSeparateColor"); links.new(texture.outputs["Color"], node.inputs["Color"])
            links.new(node.outputs["Green"], shader.inputs["Roughness"])
    shader.inputs["Base Color"].default_value = (0.64, 0.40, 0.27, 1)
    shader.inputs["Specular IOR Level"].default_value = 0.32
    nail_pixels = []
    dimension = 128
    for y in range(dimension):
        for x in range(dimension):
            u, v = x / (dimension - 1), y / (dimension - 1)
            lunula = math.exp(-((u - 0.14) / 0.17) ** 2 - ((v - 0.5) / 0.40) ** 2)
            edge = smoothstep((u - 0.90) / 0.10)
            sheen = math.sin(v * 257.0) * 0.006
            nail_pixels.extend((0.86 + lunula * 0.10 + edge * 0.10 + sheen, 0.68 + lunula * 0.17 + edge * 0.24 + sheen, 0.61 + lunula * 0.19 + edge * 0.28 + sheen, 1))
    texture = nail.node_tree.nodes.new("ShaderNodeTexImage"); texture.image = image("nail_bed", nail_pixels, False, dimension)
    shader = nail.node_tree.nodes.get("Principled BSDF")
    nail.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    shader.inputs["Coat Weight"].default_value = 0.12
    shader.inputs["Coat Roughness"].default_value = 0.22


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


def transported_dorsal(digit):
    points = [Vector(p) for p in DIGITS[digit]]
    directions = [(points[i + 1] - points[i]).normalized() for i in range(3)]
    normal = Vector((-math.sin(PALM_FRAME_ANGLE), math.cos(PALM_FRAME_ANGLE), 0))
    normal -= directions[0] * normal.dot(directions[0]); normal.normalize()
    for before, after in zip(directions, directions[1:]):
        normal = before.rotation_difference(after) @ normal
    return normal.normalized()


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
        if precision and segment == 2:
            samples += [cap_start + mm * 0.001 / length for mm in (-3, -2, -1, -0.5, 0.5, 1, 1.2, 1.8)]
        if digit == "index" and segment == 2:
            samples += [0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65]
        if digit == "middle" and segment == 2:
            samples += [cap_start + mm * 0.001 / length for mm in (-4, -3, -2.5, -2, -1.5, -1, -0.5, 0.5, 1, 2)]
        if digit == "thumb" and segment == 0:
            samples += [0.70, 0.76, 0.88, 0.94]
        for t in sorted(set(samples)):
            # Keep the distal centreline straight so its exact moving contact
            # is represented by the same frame as the runtime contact solver.
            if segment == 2:
                if precision:
                    pad_centre = Vector((0, 0, -0.006 if digit == "thumb" else 0.006))
                    q = t / cap_start
                    terminal = Vector((-1 if digit == "thumb" else 1, 0, 0))
                    bearing_start = cap_start - 0.003 / length
                    if t >= bearing_start and q <= 1:
                        # A real three-millimetre pulp bearing zone rounds out
                        # the oblique thumb phalanx. Neighbouring geometry shares
                        # the contact tangent; the normal is not faked on one empty.
                        centre = pad_centre + terminal * ((t - cap_start) * length)
                        tangent = terminal
                    elif q <= 1:
                        a, b = points[2], pad_centre
                        q = t / bearing_start
                        b = pad_centre - terminal * 0.003
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
                if digit == "thumb" and segment == 0:
                    blend = smoothstep((t - 0.70) / 0.30)
                    centre = a.lerp(b, t).lerp(centre, blend)
                    tangent = directions[0].lerp(tangent, blend).normalized()
            # A gradual opposition twist connects the palm frame to the pad
            # frame, rather than placing both nails on the same global side.
            if precision:
                twist = smoothstep((segment + min(t, 1)) / 2)
                normal = Vector((math.sin(PALM_FRAME_ANGLE), -math.cos(PALM_FRAME_ANGLE), 0)).lerp(toward_gap, twist)
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
                if digit == "middle":
                    fore = (t - cap_start) * length
                    half_width += 0.0010 * math.exp(-(fore / 0.0020) ** 2)
                half_depth = 0.0058 if precision else radius * 0.73
                if precision:
                    bearing_start = cap_start - 0.003 / length
                    half_depth -= 0.0005 * smoothstep((t - bearing_start + 0.004 / length) / (0.004 / length))
                if t >= cap_start:
                    cap_distance = (t - cap_start) * length
                    cap = min(1, max(0, (cap_distance - (0.0012 if precision else 0)) / (0.0053 if precision else 0.0065)))
                    rounding = math.sqrt(max(0, 1 - cap * cap))
                    half_width = radius * 0.75 * (1 - 0.13*cap_start) * rounding
                    if digit == "middle":
                        # A rounded fore-side pulp gives the MCP a real oblique
                        # bearing zone rather than constraining it to a plane.
                        half_width = (radius * 0.75 * (1 - 0.13*cap_start) + 0.0010) * rounding
                    half_depth = (0.0053 if precision else radius * 0.73) * rounding
            else:
                taper = 1 - 0.13 * (segment + t)
                half_width = radius * taper
                half_depth = radius * (0.78 if digit == "thumb" else 0.74) * taper
                # A small joint contour, rather than a separate bead-shaped
                # knuckle, preserves the natural continuous finger silhouette.
                half_depth += 0.00035 * sum(math.exp(-((along - joint) / 0.004) ** 2) for joint in cumulative[1:])
                if digit == "thumb" and segment == 0:
                    # This metacarpal lies inside the one-piece palm/thenar skin.
                    # A slim internal transition avoids an exposed CMC tube cap;
                    # the normal broad external thumb begins at the MCP.
                    buried = 0.15 + 0.85 * smoothstep((t - 0.70) / 0.30)
                    half_width *= buried
                    half_depth *= buried
            blend1 = smoothstep((along - cumulative[1] + min(lengths[:2]) * 0.19) / (min(lengths[:2]) * 0.38))
            blend2 = smoothstep((along - cumulative[2] + min(lengths[1:]) * 0.17) / (min(lengths[1:]) * 0.34))
            weights = (1 - blend1, blend1 - blend2, blend2)
            # The MCP root is embedded in the palm, rather than the end of a
            # rigid cylinder pushed through it. Transport the short web/knuckle
            # skin continuously from the static palm into the rotating proximal
            # phalanx. Contact-bearing distal skin remains wholly rigid.
            if digit == "thumb":
                # The hidden metacarpal connector follows the surrounding
                # thenar skin's partial CMC opposition. Its free external thumb
                # phalanges retain their full anatomical bone influence.
                root_weight = 0.78 * (1 - smoothstep((along / lengths[0] - 0.70) / 0.18))
            else:
                root_weight = 1 - smoothstep(along / (lengths[0] * 0.46))
            weights = (*[weight * (1 - root_weight) for weight in weights], root_weight)
            crease = sum(math.exp(-((along - joint) / 0.0012) ** 2) for joint in cumulative[1:]) * 0.00016
            side = smoothstep((t - 0.25) / 0.10) * (1 - smoothstep((t - 0.55) / 0.12)) if digit == "index" and segment == 2 else 0
            side_centre = points[2].lerp(points[3], t) if side else None
            sections.append((centre, normal, width, half_width, half_depth, weights, along, crease, side, side_centre))
    angles = [2 * math.pi * i / 20 for i in range(20)]
    if digit == "index":
        angles += [math.radians(degrees) % math.tau for degrees in (-30, -24, -12, -6, 6, 12, 24, 30)]
    angles = sorted(set(angles)); segments = len(angles)
    vertices, weights, uv = [], [], []
    for centre, normal, width, half_width, half_depth, weighting, along, crease, side, side_centre in sections:
        for i, angle in enumerate(angles):
            fold = crease * max(0, math.cos(angle)) ** 6
            point = centre + width * (half_width * math.sin(angle)) + normal * ((half_depth - fold) * math.cos(angle))
            if side:
                # A real broad radial pulp bearing zone supports the illustrated
                # side hold. It is part of the distal skin, with a flat interior
                # patch and rounded shoulders, not a relocated contact empty.
                projected = Vector((directions[2].x, directions[2].y, 0)).normalized()
                lateral = Vector((-projected.y, projected.x, 0))
                s, c = math.sin(angle), math.cos(angle)
                if c >= 0:
                    shoulder = 1 - smoothstep((abs(s) - 0.60) / 0.40)
                    z = side_centre.z + (0.0007 - side_centre.z) * shoulder
                else:
                    z = side_centre.z + max(half_depth, side_centre.z - 0.0007) * (-c)
                shaped = side_centre + lateral * (half_width * s)
                shaped.z = z
                point = point.lerp(shaped, side)
            vertices.append(tuple(point))
            weights.append(weighting)
            uv.append((angle / math.tau, along / (sum(lengths) + 0.0025)))
    faces = []
    for ring in range(len(sections) - 1):
        for i in range(segments):
            a, b = ring * segments + i, ring * segments + (i + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    faces.append(tuple(reversed(range(segments))))
    faces.append(tuple((len(sections) - 1) * segments + i for i in range(segments)))
    ob = mesh(f"{digit}_skin", vertices, faces, mat, parent)
    surface_uv(ob, uv)
    SKIN_WEIGHTS[ob.name] = (digit, vertices, weights)
    return ob


def palm(root, skin):
    """A single closed palm with a blended thenar region, not an attached egg.

    The asymmetric MCP arch follows the reference pose's raised index knuckle.
    The palm-side radial contour smoothly grows into the thumb metacarpal and
    has a small CMC influence so opposition deforms the same connected skin.
    """
    centre = Vector(PALM_CENTRE)
    along = Vector((math.cos(PALM_FRAME_ANGLE), math.sin(PALM_FRAME_ANGLE), 0))
    dorsal = Vector((-along.y, along.x, 0))
    # u, lateral centre, half-width, dorsal height, palmar depth, thenar fullness
    controls = [
        (-0.066, 0.007, 0.001, 0.001, 0.001, 0.000),
        (-0.061, 0.005, 0.020, 0.009, 0.010, 0.003),
        (-0.054, 0.003, 0.036, 0.015, 0.014, 0.020),
        (-0.045, 0.000, 0.042, 0.018, 0.017, 0.0381),
        (-0.031, -0.001, 0.042, 0.014, 0.016, 0.0351),
        (-0.014, -0.002, 0.041, 0.013, 0.015, 0.029),
        (0.002, -0.002, 0.039, 0.012, 0.014, 0.021),
        (0.018, -0.001, 0.032, 0.011, 0.012, 0.009),
        (0.037, 0.001, 0.024, 0.010, 0.011, 0.002),
        (0.045, 0.002, 0.021, 0.009, 0.010, 0.000),
        (0.051, 0.002, 0.001, 0.001, 0.001, 0.000),
    ]
    def section(t):
        segment = min(len(controls) - 2, int(t))
        f = t - segment
        out = []
        for coordinate in range(6):
            a = controls[max(0, segment - 1)][coordinate]
            b = controls[segment][coordinate]
            c = controls[segment + 1][coordinate]
            d = controls[min(len(controls) - 1, segment + 2)][coordinate]
            # Cubic interpolation gives a continuous silhouette without polygonal plate edges.
            out.append(0.5 * ((2*b) + (-a+c)*f + (2*a-5*b+4*c-d)*f*f + (-a+3*b-3*c+d)*f*f*f))
        return out
    vertices, weights, uv = [], [], []
    n, rows = 40, 51
    for row in range(rows):
        u, z0, width, back, front, fullness = section(row * (len(controls) - 1) / (rows - 1))
        for i in range(n):
            angle = 2 * math.pi * i / n
            c, s = math.cos(angle), math.sin(angle)
            v = (back if c >= 0 else front) * c
            # The radial-palmar quadrant carries the thenar muscle. Both ends
            # and all surrounding palm skin share the same continuous vertices.
            radial_palmar = math.exp(-((angle - 2.35) / 1.00) ** 2)
            v -= fullness * radial_palmar
            z = z0 + width * s + fullness * radial_palmar * 0.12
            knuckle = sum(math.exp(-((u - q) / 0.008) ** 2 - ((z - r) / 0.010) ** 2)
                           for q, r in [(-0.045, 0.029), (-0.049, 0.009), (-0.041, -0.011), (-0.029, -0.029)])
            v += max(0, c) ** 3 * knuckle * 0.0007
            crease = 0.00016 * math.exp(-((u + 0.014 + z * 0.25) / 0.0010) ** 2)
            crease += 0.00012 * math.exp(-((u + 0.030 - z * 0.18) / 0.0009) ** 2)
            v += crease * max(0, -c) ** 6
            # Ulnar metacarpals end nearer the wrist than the raised index ray.
            # This fan-shaped MCP boundary leaves real interdigital webs instead
            # of a rectangular plate underneath the curled little/ring fingers.
            lateral = (z - 0.009) / 0.020
            # Stop the ulnar arch receding beyond the little-finger metacarpal.
            # An unbounded quadratic pulls the outer web back behind the broad
            # proximal shaft, leaving a pointed intersection at its exit.
            ulnar = -lateral
            if ulnar > 1.3:
                ulnar = 1.3 + 0.5 * math.tanh((ulnar - 1.3) / 0.5)
            arch = 0.003 * min(1, lateral * lateral) if lateral >= 0 else 0.004 * ulnar * ulnar
            mcp_arch = smoothstep((0.040 - u) / 0.090) * arch
            # Soft interdigital tissue reaches a few millimetres along each
            # proximal phalanx. This local front envelope leaves the fixed heel,
            # thumb opposition mass and all fingertip/contact geometry intact.
            webs = sum(math.exp(-((z - DIGITS[digit][0][2]) / 0.010) ** 2)
                       for digit in ("middle", "ring", "little"))
            web_extension = 0.0045 * min(1.15, webs) * smoothstep((-u - 0.020) / 0.035) * (1 - smoothstep((z - 0.012) / 0.012))
            point = centre + along * (u + mcp_arch - web_extension) + dorsal * v + Vector((0, 0, z))
            vertices.append(tuple(point))
            cap_fade = smoothstep((u + 0.066) / 0.010) * smoothstep((0.051 - u) / 0.010)
            influence = 0.22 * radial_palmar * math.exp(-((u + 0.014) / 0.030) ** 2) * smoothstep((z - 0.008) / 0.012) * cap_fade
            weights.append((1 - influence, influence, 0, 0))
            uv.append((i / n, 0.15 + row / (rows - 1) * 0.50))
    faces = []
    for j in range(rows - 1):
        for i in range(n):
            a, b = j * n + i, j * n + (i + 1) % n
            faces.append((a, b, b + n, a + n))
    faces.append(tuple(reversed(range(n))))
    faces.append(tuple((rows - 1) * n + i for i in range(n)))
    surface = mesh("palm_surface", vertices, faces, skin, root)
    surface_uv(surface, uv)
    surface["anatomicalRegions"] = "palm; continuous thenar; MCP arch; wrist heel"
    surface["thenarTopology"] = "one closed palm component; no separate thenar mesh"
    SKIN_WEIGHTS[surface.name] = ("palm", vertices, weights)
    empty("palm_root", root)
    return surface


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
        longitudinal = radius * math.cos(angle)
        free_extension = 0.00045 * smoothstep((longitudinal - 0.55) / 0.45) if name == "middle_nail" else 0
        plane = Vector(centre) + u * (half_length * longitudinal + free_extension) + v * (half_width * radius * math.sin(angle))
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
    joint_names = [f"{digit}_{joint}" for digit in DIGITS for joint in JOINTS] + ["palm_root"]
    # Keep constant, non-neutral primary rotations in the nail-work clips.
    # Blender's corresponding option also emits unchanged object locations
    # and scales; these legacy controls have no animated translation/scale.
    for animation in gltf.get("animations", []):
        channels = [channel for channel in animation["channels"]
                    if channel["target"]["path"] == "rotation"
                    or channel["target"]["node"] == nodes["hand_pose_frame"] and channel["target"]["path"] == "translation"]
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


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    SKIN_WEIGHTS.clear()
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.frame_start, scene.frame_end = 1, 31
    asset_root = empty("acu_practitioner_hand")
    asset_root["license"] = "CC0-1.0"
    asset_root["source"] = "AcuCraft tools/blender/build_hand.py; original procedural geometry and PBR textures"
    asset_root["units"] = "metres; +Y needle axis; raised reference hold"
    root = empty("hand_pose_frame", asset_root)
    root["runtimeContract"] = "Authored clip frame; reset before applying live operator model transform"
    skin = material("hand_skin", (0.64, 0.40, 0.27))
    nail = material("hand_nails", (0.70, 0.49, 0.39), 0.36)
    detail_textures(skin, nail)
    palm_surface = palm(root, skin)
    empty("wrist", root, WRIST)
    palm_frame = empty("palm_frame", root, PALM_CENTRE)
    palm_frame.rotation_mode = "QUATERNION"
    palm_frame.rotation_quaternion = Quaternion((0, 0, 1), PALM_FRAME_ANGLE)
    palm_frame["forwardAxis"] = "-X toward fingers; -Y volar; +Z radial"
    wrist_frame = empty("wrist_frame", root, WRIST)
    wrist_frame.rotation_mode = "QUATERNION"
    wrist_frame.rotation_quaternion = Quaternion((0, 0, 1), PALM_FRAME_ANGLE)
    empty("pinch", root)
    anchors = {}
    palm_surface.data.calc_loop_triangles()
    heel_target = Vector((0.05182006955, 0.08137491842, -0.04218411818))
    heel = min(palm_surface.data.loop_triangles,
               key=lambda triangle: ((sum((palm_surface.data.vertices[i].co for i in triangle.vertices), Vector()) / 3) - heel_target).length_squared)
    heel_point = sum((palm_surface.data.vertices[i].co for i in heel.vertices), Vector()) / 3
    anchors["palm_contact"] = empty("palm_contact", bpy.data.objects["palm_root"], heel_point, heel.normal)
    anchors["palm_contact"]["surface"] = "palm_surface"
    anchors["palm_contact"]["feature"] = "ulnar-heel"
    anchors["support_contact"] = surface_anchor("support_contact", root, palm_surface, (0.043, 0.055, -0.022))
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
                    dorsal = transported_dorsal(digit)
                dorsal -= axis * dorsal.dot(axis)
                dorsal.normalize()
                nail_axis = delta
                # Preserve the longitudinal nail-bed coordinate. A nearest
                # point search from far outside can slide along the rounded
                # tip, placing the whole nail beyond its intended free edge.
                nail_centre = delta * 0.67
                nail_width = {"thumb": 0.78, "index": 0.72, "middle": 0.82, "ring": 0.72, "little": 0.70}[digit]
                nail_surface, nail_edge, nail_normal = nail_plate(f"{digit}_nail", node, surface, nail_centre, dorsal, nail_axis, delta.length * 0.28, r * nail_width, nail)
                if precision:
                    target = Vector((0, 0, -0.0007 if digit == "thumb" else 0.0007)) - start
                else:
                    volar = Vector((0, 0, 1)).cross(delta).normalized()
                    target = delta * 0.86 + volar * (r * 0.85)
                pad = surface_anchor(f"{digit}_pad_contact", node, surface, target)
                if precision:
                    # At the crest, the analytic smooth-surface normal is exactly
                    # toward the gap. A single adjacent triangle's facet normal
                    # must not rotate the whole finger away from the handle.
                    pad.rotation_quaternion = Vector((0, 1, 0)).rotation_difference(toward_gap)
                anchors[pad.name] = pad
                if precision:
                    # Material points move over this real rigid distal-skin patch during
                    # pad rolling. Every attachment is projected to actual triangles;
                    # no contact is translated through empty space to imply motion.
                    terminal = Vector((-1 if digit == "thumb" else 1, 0, 0))
                    for sample in range(-3, 4):
                        offset = sample * 0.0007 / 3
                        marker = f"{digit}_pad_roll_{'m' if sample < 0 else 'p' if sample > 0 else 'c'}{abs(sample)}_contact"
                        point = surface_anchor(marker, node, surface, pad.location + terminal * offset)
                        point["feature"] = "rolling-pad-surface"
                        point["offsetMm"] = offset * 1000
                        anchors[point.name] = point
                if digit == "index":
                    target_side = delta * 0.45
                    target_side.z = 0.0007 - start.z
                    side = surface_anchor("index_side_contact", node, surface, target_side)
                    side["feature"] = "radial-side-pulp"
                    anchors[side.name] = side
                    # Surface pressing uses the true volar fingertip, separately
                    # from the lateral pulp that pinches the needle handle.
                    surface.data.calc_loop_triangles()
                    target = Vector((-0.0008333334, -0.0052938413, 0.0065459302))
                    face = min(surface.data.loop_triangles,
                               key=lambda triangle: ((sum((surface.data.vertices[i].co for i in triangle.vertices), Vector()) / 3) - target).length_squared)
                    point = sum((surface.data.vertices[i].co for i in face.vertices), Vector()) / 3
                    volar = empty("index_volar_contact", node, point - start, face.normal)
                    volar["surface"] = surface.name
                    volar["feature"] = "volar-tip"
                    anchors[volar.name] = volar
                # Both names are offered while existing runtime integrations migrate to *_pad_contact.
                empty(f"{digit}_pad", node, pad.location, pad.rotation_quaternion @ Vector((0, 1, 0)))
                if digit == "middle":
                    side_target = delta * (1 - 0.004 / delta.length) + Vector((0, 0, -0.0063096))
                    side = surface_anchor("middle_side_contact", node, surface, side_target)
                    anchors[side.name] = side
                    radial = surface_anchor("middle_radial_contact", node, surface, delta * (1 - 0.004 / delta.length) + Vector((0, 0, 0.0063096)))
                    radial["feature"] = "radial-side-pulp"
                    anchors[radial.name] = radial
                    for sign, side_name in ((-1, "ulnar"), (1, "radial")):
                        for percent in (55, 65, 72, 78, 88, 98, 108):
                            point = surface_anchor(f"middle_{side_name}_pulp_{percent}_contact", node, surface, delta * (percent / 100) + Vector((0, 0, sign * 0.0065)))
                            point["feature"] = "oblique-fore-side-pulp"
                            anchors[point.name] = point
                    # The bounded three-finger hold uses the actual radial
                    # fore-side pulp. Preserve its measured point and facet
                    # orientation rather than an idealized lateral normal.
                    bearing = anchors["middle_radial_pulp_78_contact"]
                    side.location = bearing.location
                    side.rotation_quaternion = bearing.rotation_quaternion
                    side["feature"] = "oblique-fore-side-pulp"
                nail_anchor = empty(f"{digit}_nail_contact", node, nail_edge, nail_normal)
                nail_anchor["surface"] = nail_surface.name
                anchors[nail_anchor.name] = nail_anchor
                if digit == "middle":
                    # Scraping/flicking can use the lateral rim while the thumb
                    # and index keep their ordinary pad pinch. Select a real
                    # front-side rim face, not the dorsal nail-bed surface.
                    rim = [p for p in nail_surface.data.polygons[-24:]
                           if p.normal.z < -0.99 and p.normal.dot(axis) > 0]
                    if not rim:
                        raise ValueError("The middle nail has no usable lateral rim")
                    face = max(rim, key=lambda p: -p.normal.z)
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
                                      if p.normal.z < -0.65 and p.normal.dot(axis) > 0]
                        face = min(candidates, key=lambda p: abs(math.degrees(math.atan2(p.normal.dot(axis), -p.normal.z)) - degrees))
                        point = sum((nail_surface.data.vertices[i].co for i in list(face.vertices)[:3]), Vector()) / 3
                        sample = empty(f"middle_nail_oblique_{degrees}_contact", node, point, face.normal)
                        sample["surface"] = nail_surface.name
                        sample["feature"] = "fore-lateral-rim"
                        anchors[sample.name] = sample
            parent = node
    empty("thumb_contact", root, (0, 0, -0.0007))
    empty("index_contact", root, (0, 0, 0.0007))

    # The exported choreography uses the same fixed-hinge solutions as the
    # runtime controls. This keeps the independently playable asset consistent
    # with the thumb/index hold and the active middle nail-edge role.
    choreography = json.loads(Path(__file__).with_name("hand_poses.json").read_text())
    authored = choreography["poses"]
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
    support = {}
    for digit in DIGITS:
        if digit == "thumb":
            points = [Vector(p) for p in DIGITS[digit]]
            bones = [points[i + 1] - points[i] for i in range(3)]
            hinge = bones[0].cross(bones[1]).normalized()
            swing = bones[0].rotation_difference(Vector((-0.83, -0.10, 0.55)).normalized())
            axis, angle = swing.to_axis_angle()
            support[digit] = [Quaternion(axis, min(angle, math.radians(35)))]
            for joint, target in ((1, 40), (2, 20)):
                rest = math.atan2(bones[joint - 1].cross(bones[joint]).dot(hinge), bones[joint - 1].dot(bones[joint]))
                support[digit].append(Quaternion(hinge, math.radians(target) - rest))
            continue
        axis = {"index": (-1, -0.06, 0.06), "middle": (-1, -0.04, 0), "ring": (-1, -0.04, -0.02), "little": (-1, -0.04, -0.08)}[digit]
        support[digit] = chain_rotations(digit, [axis] * 3)
    if "support" in authored:
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

    # Measure the real contact transforms of each authored pose for both runtime attachment and tests.
    for node in [*nodes.values(), root]:
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
        contacts_by_pose[name] = pose_points(anchors)
    # Bind the static skin in the true source pose. Scrape/flick intentionally
    # start in their own stable hold, so their first animation keys cannot also
    # supply the common mesh bind frame.
    scene.frame_set(0)
    root.location = (0, 0, 0)
    for node in [*nodes.values(), root]:
        node.rotation_quaternion = Quaternion()
        for track in node.animation_data.nla_tracks:
            track.mute = False
    bpy.context.view_layer.update()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUT), export_format="GLB", export_yup=False,
        export_animations=True, export_nla_strips=True,
        export_animation_mode="NLA_TRACKS", export_force_sampling=True,
        export_optimize_animation_keep_anim_object=True,
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
        "choreography": "tools/blender/hand_poses.json",
        "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
        "triangles": triangles, "root": asset_root.name, "authoredPoseFrame": root.name,
        "coordinates": "metres; +Y along needle, +X from pinch toward wrist; rest precision pinch",
        "wrist": list(WRIST), "pinch": [0, 0, 0],
        "baselineElevationDeg": math.degrees(math.atan2(WRIST[1], WRIST[0])),
        "palmFrame": {"node": "palm_frame", "angleDeg": math.degrees(PALM_FRAME_ANGLE), "forward": "-X", "volar": "-Y", "radial": "+Z"},
        "tips": {d: list(points[-1]) for d, points in DIGITS.items()},
        "contact": {"thumb": [0, 0, -0.0007], "index": [0, 0, 0.0007]},
        "joints": {d: [f"{d}_{j}" for j in JOINTS] for d in DIGITS},
        "anatomicalJoints": {d: [f"{d}_{j}" for j in ANATOMICAL[d]] for d in DIGITS},
        "anatomicalMapping": {f"{d}_{j}": f"{d}_{ANATOMICAL[d][i]}" for d in DIGITS for i, j in enumerate(JOINTS)},
        "skin": {"surfaces": list(SKIN_WEIGHTS), "joints": [f"{d}_{j}" for d in DIGITS for j in JOINTS] + ["palm_root"], "weights": "smooth neighbouring-joint blend and proximal palm/MCP transition; contact-bearing distal vertices are rigid; connected palm uses static/CMC blend", "staticInfluence": "palm_root", "clone": "SkeletonUtils.clone is required for independent hands"},
        "palm": {"surface": "palm_surface", "topology": "single closed connected skin including thenar", "thenar": {"region": "radial-palmar quadrant", "maximumCmcWeight": 0.22}, "knuckles": "asymmetric MCP arch", "frame": "palm_frame"},
        "contactAnchors": {name: {"node": name, "normalAxis": "+Y", "follows": node.parent.name, **({"surface": node["surface"]} if "surface" in node else {}), **({"feature": node["feature"]} if "feature" in node else {})} for name, node in anchors.items()},
        "rollingPatches": {digit: {"surface": f"{digit}_skin", "joint": f"{digit}_distal", "axis": "longitudinal terminal skin", "extentMm": 0.7,
            "samples": [{"node": name, "offsetMm": round(node["offsetMm"], 9), "position": [round(v, 9) for v in node.location],
                         "normal": [round(v, 9) for v in node.rotation_quaternion @ Vector((0, 1, 0))]}
                        for name, node in anchors.items() if name.startswith(f"{digit}_pad_roll_")]}
                           for digit in ("thumb", "index")},
        "poseContacts": contacts_by_pose,
        "materials": ["hand_skin", "hand_nails"],
        "animations": [a["name"] for a in gltf.get("animations", [])],
        "animation": "Every clip is 0..1 second and includes its real whole-hand pose frame. Open begins at precision pinch with unused fingers naturally curled. Support is a stable volar-index palpation pose with a gently flexed opposed thumb; the procedure supplies approach/contact/retreat and a separate flat ulnar-heel pressing pose. Three_finger uses the bounded 48-degree radial-pulp hold. Three_finger/scrape/flick keep thumb/index contact at needle Y=-12 mm, while the middle bears at Y=+10 mm or moves along the upper handle. Scrape ends after a 6 mm upward stroke. Flick returns to the true distal nail free edge at 1s. Sample only one base clip per hand; anatomical parents may overlay it. Live runtime resets hand_pose_frame before applying its operator-controlled model frame.",
        "clipFrames": {name: [round((frame - 1) / 30, 9) for frame, _ in frames] for name, frames in clips.items()},
        "modelClipFrames": {name: [{"time": round((frame - 1) / 30, 9), "position": list(position), "rotation": list(rotation)} for frame, position, rotation in frames] for name, frames in model_clips.items()},
        "review": "schematic animation asset, no anatomical or clinical validation",
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Hand: {triangles} triangles; {len(raw)} bytes; clips {manifest['animations']}")


if __name__ == "__main__":
    build()
