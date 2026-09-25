"""Builds the Imperial China army miniatures (Qing army, c. 1840-1860) as animated glTF files.

Run with Blender 4.4 or later (tested with 5.2):

    blender -b --factory-startup --python tools/blender/build_army_models.py -- [out_dir] [--preview dir]

Every model is built from simple solids bound rigidly to an armature, and gets three looping
actions: Idle, Walk and Combat. Parts painted with the material "Nation" (which also carries
the extra krieg_tint = "nation") are meant to be recoloured with the owning nation's color.
See themes/imperial-china/models/README.md.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
PREVIEW_DIR = None
if "--preview" in ARGV:
    i = ARGV.index("--preview")
    PREVIEW_DIR = os.path.abspath(ARGV[i + 1])
    del ARGV[i:i + 2]
OUT_DIR = os.path.abspath(ARGV[0] if ARGV else os.path.join(HERE, "../../themes/imperial-china/models"))
ONLY = ARGV[1:]  # optional list of model names to build

FPS = 24
LENGTHS = {"Idle": 48, "Walk": 24, "Combat": 36}

# name: (sRGB hex, roughness, metallic, emission strength)
PALETTE = {
    "Nation": ("#a8362a", 0.55, 0.0, 0.0),
    "Indigo": ("#27314a", 0.8, 0.0, 0.0),
    "Linen": ("#e9e0c9", 0.85, 0.0, 0.0),
    "Skin": ("#dfb38b", 0.6, 0.0, 0.0),
    "Hair": ("#1d1b1b", 0.5, 0.0, 0.0),
    "Leather": ("#4d3322", 0.7, 0.0, 0.0),
    "Wood": ("#8d5c36", 0.75, 0.0, 0.0),
    "WoodDark": ("#4a3122", 0.8, 0.0, 0.0),
    "Rattan": ("#c9a25f", 0.8, 0.0, 0.0),
    "Bronze": ("#b3843f", 0.35, 1.0, 0.0),
    "Iron": ("#555861", 0.4, 1.0, 0.0),
    "Gold": ("#dcae3f", 0.3, 1.0, 0.0),
    "Horse": ("#8e5b33", 0.7, 0.0, 0.0),
    "HorseDark": ("#2b221d", 0.7, 0.0, 0.0),
    "Mule": ("#857767", 0.8, 0.0, 0.0),
    "Ceramic": ("#d8d4c4", 0.3, 0.0, 0.0),
    "Flash": ("#ffb040", 0.5, 0.0, 8.0),
    "Smoke": ("#ddd8cc", 1.0, 0.0, 0.0),
}
MATS = {}


def srgb(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c) + (1.0,)


def make_materials():
    MATS.clear()
    for name, (hx, rough, metal, emit) in PALETTE.items():
        m = bpy.data.materials.new(name)
        if m.node_tree is None:
            m.use_nodes = True
        bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        col = srgb(hx)
        bsdf.inputs["Base Color"].default_value = col
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        if emit:
            bsdf.inputs["Emission Color"].default_value = col
            bsdf.inputs["Emission Strength"].default_value = emit
        m.diffuse_color = col
        m.use_backface_culling = False
        if name == "Nation":
            m["krieg_tint"] = "nation"
        MATS[name] = m


# ---------------------------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------------------------

def V(*a):
    return Vector(a[0] if len(a) == 1 else a)


def T(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    return Matrix.LocRotScale(Vector(loc), Euler([math.radians(a) for a in rot], "XYZ"), Vector(scale))


def xf(bm, M):
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts[:])
    return bm


def cyl(r1, r2, h, seg=16):
    """Cylinder/cone from z=0 to z=h."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r1, radius2=r2, depth=h)
    bmesh.ops.translate(bm, vec=(0, 0, h / 2), verts=bm.verts[:])
    return bm


def sphere(r, seg=16, rings=10):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    return bm


def box(sx, sy, sz, bevel=0.0, bseg=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts[:])
    if bevel:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=bseg, affect="EDGES", profile=0.5)
    return bm


def lathe(prof, seg=20, closed=False):
    """Revolve a (radius, z) profile around Z."""
    bm = bmesh.new()
    rings = []
    for r, z in prof:
        if r < 1e-6:
            rings.append([bm.verts.new((0, 0, z))])
        else:
            rings.append([bm.verts.new((r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg), z))
                          for i in range(seg)])
    pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
    for a, b in pairs:
        if len(a) == 1 and len(b) == 1:
            continue
        for i in range(seg):
            j = (i + 1) % seg
            if len(a) == 1:
                bm.faces.new((a[0], b[i], b[j]))
            elif len(b) == 1:
                bm.faces.new((a[i], a[j], b[0]))
            else:
                bm.faces.new((a[i], a[j], b[j], b[i]))
    if not closed:
        for ring in (rings[0], rings[-1]):
            if len(ring) > 1:
                bm.faces.new(ring)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm


def slab(pts, t):
    """Extrude a polygon given in the XZ plane by t along Y (centred)."""
    bm = bmesh.new()
    f = bm.faces.new([bm.verts.new((x, -t / 2, z)) for x, z in pts])
    res = bmesh.ops.extrude_face_region(bm, geom=[f])
    bmesh.ops.translate(bm, vec=(0, t, 0), verts=[e for e in res["geom"] if isinstance(e, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm


def align(a, b):
    a, b = V(a), V(b)
    q = Vector((0, 0, 1)).rotation_difference((b - a).normalized())
    return Matrix.Translation(a) @ q.to_matrix().to_4x4()


def tube(a, b, r1, r2=None, seg=14):
    L = (V(b) - V(a)).length
    return xf(cyl(r1, r1 if r2 is None else r2, L, seg), align(a, b))


def shell(rx, rz, y0, y1, a0, a1, th, seg=16):
    """Part of an elliptic tube around the Y axis (angles in degrees from +Z towards +X)."""
    bm = bmesh.new()
    grid = {}
    for k, s in enumerate((1.0, 1.0 - th / max(rx, rz))):
        for i in range(seg + 1):
            a = math.radians(a0 + (a1 - a0) * i / seg)
            for j, y in enumerate((y0, y1)):
                grid[k, i, j] = bm.verts.new((rx * s * math.sin(a), y, rz * s * math.cos(a)))
    for i in range(seg):
        bm.faces.new((grid[0, i, 0], grid[0, i + 1, 0], grid[0, i + 1, 1], grid[0, i, 1]))
        bm.faces.new((grid[1, i, 1], grid[1, i + 1, 1], grid[1, i + 1, 0], grid[1, i, 0]))
        for j in (0, 1):
            bm.faces.new((grid[0, i, j], grid[1, i, j], grid[1, i + 1, j], grid[0, i + 1, j]))
    for i in (0, seg):
        bm.faces.new((grid[0, i, 0], grid[0, i, 1], grid[1, i, 1], grid[1, i, 0]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm


def wave(bm, axis, along, amp, k, origin=0.0):
    """Ripple vertices along `axis` by a sine of their `along` coordinate (0=x,1=y,2=z)."""
    for v in bm.verts:
        d = v.co[along] - origin
        v.co[axis] += amp * math.sin(k * d) * min(1.0, abs(d) * 2)
    return bm


def ring(r, w, z=0.0, seg=24, depth=0.02):
    return lathe([(r - depth, z - w / 2), (r, z - w / 2), (r, z + w / 2), (r - depth, z + w / 2)], seg, closed=True)


def wheel(r, w, spokes=10, rim="Wood", hub="WoodDark", tyre="Iron"):
    """A spoked wheel around the X axis, centred on the origin. Returns [(bm, material)]."""
    rot = T(rot=(0, 90, 0))
    out = [(xf(ring(r - 0.012, w, depth=0.06, seg=28), rot), rim),
           (xf(ring(r, w * 1.05, depth=0.016, seg=28), rot), tyre),
           (xf(lathe([(0.03, -w), (0.075, -w * 0.6), (0.085, 0), (0.075, w * 0.6), (0.03, w)], 14), rot), hub)]
    for i in range(spokes):
        a = 360 * i / spokes
        out.append((xf(xf(box(0.03, 0.035, r - 0.1), T((0, 0, (r + 0.02) / 2))), T(rot=(a, 0, 0))), rim))
    return out


# ---------------------------------------------------------------------------------------------
# Model assembly
# ---------------------------------------------------------------------------------------------

class Model:
    def __init__(self, name):
        self.name = name
        self.bones = {}
        self.parts = []

    def bone(self, name, head, tail, parent=None):
        self.bones[name] = (V(head), V(tail), parent)

    def add(self, bm, mat, bone, M=None, smooth=True):
        if M is not None:
            xf(bm, M)
        me = bpy.data.meshes.new(bone)
        bm.to_mesh(me)
        bm.free()
        for p in me.polygons:
            p.use_smooth = smooth
        ob = bpy.data.objects.new(me.name, me)
        bpy.context.scene.collection.objects.link(ob)
        me.materials.append(MATS[mat])
        ob.vertex_groups.new(name=bone).add(list(range(len(me.vertices))), 1.0, "REPLACE")
        self.parts.append(ob)

    def addmany(self, items, bone, M=None, smooth=True):
        for bm, mat in items:
            self.add(bm, mat, bone, M, smooth)

    def build(self):
        scene = bpy.context.scene
        arm = bpy.data.armatures.new(self.name + "_rig")
        ao = bpy.data.objects.new(self.name + "_rig", arm)
        scene.collection.objects.link(ao)
        bpy.context.view_layer.objects.active = ao
        bpy.ops.object.mode_set(mode="EDIT")
        for n, (h, t, _) in self.bones.items():
            eb = arm.edit_bones.new(n)
            eb.head, eb.tail = h, t
        for n, (_, _, p) in self.bones.items():
            if p:
                arm.edit_bones[n].parent = arm.edit_bones[p]
        bpy.ops.object.mode_set(mode="OBJECT")

        for o in scene.objects:
            o.select_set(o in self.parts)
        bpy.context.view_layer.objects.active = self.parts[0]
        bpy.ops.object.join()
        mesh = self.parts[0]
        mesh.name = mesh.data.name = self.name
        missing = {g.name for g in mesh.vertex_groups} - set(self.bones)
        assert not missing, missing
        mesh.parent = ao
        mesh.modifiers.new("Armature", "ARMATURE").object = ao
        ao.animation_data_create()
        for pb in ao.pose.bones:
            pb.rotation_mode = "QUATERNION"
        self.ao, self.mesh = ao, mesh
        return ao


# ---------------------------------------------------------------------------------------------
# Posing. A pose is {bone: {"r": (x, y, z) degrees, "l": (x, y, z), "s": k, "slide": d}}.
# Rotations and offsets are given along world axes, relative to the parent bone, so "rx -30 on a
# thigh" always swings the leg forward, whatever the bone's roll. The miniatures face -Y.
# ---------------------------------------------------------------------------------------------

def P(**bones):
    return {k.replace("__", "."): v for k, v in bones.items()}


def r(x=0, y=0, z=0, **kw):
    d = {"r": (x, y, z)}
    d.update(kw)
    return d


OPS = ("ik", "aim")


def add(*poses):
    out = {}
    for p in poses:
        for b, e in p.items():
            if b in OPS:
                out[b] = out.get(b, []) + list(e)
                continue
            o = out.setdefault(b, {"r": (0, 0, 0), "l": (0, 0, 0), "s": 1.0, "slide": 0.0})
            o["r"] = tuple(a + c for a, c in zip(o["r"], e.get("r", (0, 0, 0))))
            o["l"] = tuple(a + c for a, c in zip(o["l"], e.get("l", (0, 0, 0))))
            o["s"] = o["s"] * e.get("s", 1.0)
            o["slide"] = o["slide"] + e.get("slide", 0.0)
    return out


def ik(upper, lower, target, frame, pole):
    """Two-bone IK: put the end of `lower` on `target`, bending towards `pole`. Points are given in
    the rest pose and follow the `frame` bone (None = the armature)."""
    return {"ik": [(upper, lower, V(target), frame, V(pole))]}


def aim(bone, vec, frame=None, slide=0.0, point=False, reach=None, ref=None, side=None):
    """Point a bone along `vec` (or at the point `vec`), in the rest frame of `frame`, then slide it
    along itself by `slide` (or so that its part `reach` from the head touches the point). `ref` (a
    rest-pose direction on the part) is turned towards `side` to control the roll."""
    return {"aim": [(bone, V(vec), frame, slide, point, reach, ref and V(ref), side and V(side))]}


def smooth(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


class Blend:
    def __init__(self, a, b, u):
        self.a, self.b, self.u = a, b, u


def keyed(t, keys):
    """Blend between key poses [(t, pose), ...] (t in 0..1, first and last should match)."""
    for (t0, p0), (t1, p1) in zip(keys, keys[1:]):
        if t0 <= t <= t1:
            return Blend(p0, p1, smooth((t - t0) / (t1 - t0)) if t1 > t0 else 1.0)
    return keys[-1][1]


def pulse(t, t0, t1):
    """0 outside [t0, t1], rising to 1 and back inside it."""
    if t <= t0 or t >= t1:
        return 0.0
    return math.sin(math.pi * (t - t0) / (t1 - t0))


def _frame(ao, frame):
    if frame is None:
        return Matrix.Identity(4)
    pb = ao.pose.bones[frame]
    return pb.matrix @ pb.bone.matrix_local.inverted()


def _point_bone(ao, pb, direction, head=None):
    """Rotate a posed bone (armature space) by the smallest turn that points it along direction."""
    cur = pb.matrix.copy()
    dcur = (cur.to_3x3() @ Vector((0, 1, 0))).normalized()
    q = dcur.rotation_difference(direction.normalized())
    rot = q.to_matrix() @ cur.to_3x3().normalized()
    pb.matrix = Matrix.Translation(head if head is not None else cur.translation) @ rot.to_4x4()
    bpy.context.view_layer.update()


def apply_pose(ao, pose):
    for pb in ao.pose.bones:
        e = pose.get(pb.name, {})
        R = Euler([math.radians(v) for v in e.get("r", (0, 0, 0))], "XYZ").to_matrix()
        M = pb.bone.matrix_local.to_3x3()
        Mi = M.inverted()
        loc = V(e.get("l", (0, 0, 0)))
        if e.get("slide"):
            loc = loc + R @ ((pb.bone.tail_local - pb.bone.head_local).normalized() * e["slide"])
        s = e.get("s", 1.0)
        pb.rotation_quaternion = (Mi @ R @ M).to_quaternion()
        pb.location = Mi @ loc
        pb.scale = (s, s, s)
    if not any(pose.get(k) for k in OPS):
        return
    bpy.context.view_layer.update()
    for upper, lower, target, frame, pole in pose.get("ik", []):
        F = _frame(ao, frame)
        tw, pw = F @ target, F @ pole
        pu, pl = ao.pose.bones[upper], ao.pose.bones[lower]
        a, b = pu.bone.length, pl.bone.length
        S = pu.head.copy()
        d = min((tw - S).length, (a + b) * 0.999)
        n = (tw - S).normalized()
        x = (a * a - b * b + d * d) / (2 * d)
        h = math.sqrt(max(0.0, a * a - x * x))
        side = (pw - S) - n * (pw - S).dot(n)
        E = S + n * x + side.normalized() * h
        _point_bone(ao, pu, E - S)
        _point_bone(ao, pl, (S + n * d) - pl.head)
    for bone, vec, frame, slide, point, reach, ref, side in pose.get("aim", []):
        F = _frame(ao, frame)
        pb = ao.pose.bones[bone]
        head = pb.head.copy()
        d = (F @ vec - head) if point else (F.to_3x3() @ vec)
        if reach is not None:
            slide = d.length - reach
        d.normalize()
        rest = pb.bone.matrix_local.to_3x3()
        q = (rest @ Vector((0, 1, 0))).rotation_difference(d)
        rot = q.to_matrix() @ rest
        if ref is not None:
            a, b = q @ ref, F.to_3x3() @ side
            a, b = a - d * a.dot(d), b - d * b.dot(d)
            ang = a.angle(b, 0.0)
            if a.cross(b).dot(d) < 0:
                ang = -ang
            rot = Matrix.Rotation(ang, 3, d) @ rot
        pb.matrix = Matrix.Translation(head + d * slide) @ rot.to_4x4()
        bpy.context.view_layer.update()


def resolve(ao, pose, cache=None):
    """Evaluate a pose to local bone channels: {bone: (quaternion, location, scale)}."""
    if isinstance(pose, Blend):
        A, B = resolve(ao, pose.a, cache), resolve(ao, pose.b, cache)
        out = {}
        for k in A:
            qa, la, sa = A[k]
            qb, lb, sb = B[k]
            out[k] = (qa.slerp(qb, pose.u), la.lerp(lb, pose.u), sa.lerp(sb, pose.u))
        return out
    if cache is not None and id(pose) in cache:
        return cache[id(pose)]
    apply_pose(ao, pose)
    out = {pb.name: (pb.rotation_quaternion.copy(), pb.location.copy(), pb.scale.copy()) for pb in ao.pose.bones}
    if cache is not None:
        cache[id(pose)] = out
    return out


def make_action(ao, name, fn, nframes=None, step=2):
    nframes = nframes or LENGTHS[name]
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ad = ao.animation_data
    ad.action, ad.use_nla = None, False
    cache = {}
    frames = [(f, resolve(ao, fn(f / nframes), cache)) for f in range(0, nframes + 1, step)]
    ad.action, ad.use_nla = act, True
    prev = {}
    for f, channels in frames:
        for pb in ao.pose.bones:
            q, loc, s = channels[pb.name]
            q = q.copy()
            if pb.name in prev and prev[pb.name].dot(q) < 0:
                q.negate()
            prev[pb.name] = q
            pb.rotation_quaternion, pb.location, pb.scale = q, loc, s
            pb.keyframe_insert("rotation_quaternion", frame=f)
            pb.keyframe_insert("location", frame=f)
            pb.keyframe_insert("scale", frame=f)
    track = ao.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, act)
    ao.animation_data.action = None
    return act


# ---------------------------------------------------------------------------------------------
# Figures
# ---------------------------------------------------------------------------------------------

HUMAN_MATS = dict(torso="Indigo", sleeve="Indigo", hem="Indigo", thigh="Indigo", shin="Linen", shoe="Hair",
                  sole="Linen", cuff="Linen", belt="Leather", skin="Skin", hair="Hair")
TORSO = [(0.155, 0.06), (0.172, 0.2), (0.19, 0.36), (0.178, 0.46), (0.1, 0.53), (0.0, 0.545)]
TORSO_Y = 0.74


def torso_radius(z):
    for (r0, z0), (r1, z1) in zip(TORSO, TORSO[1:]):
        if z0 <= z <= z1:
            return r0 + (r1 - r0) * (z - z0) / (z1 - z0)
    return TORSO[-1][0]


def humanoid(m, p, pelvis, parent, seated=False, s=1.0, hem_len=0.22, queue=True, **mats):
    """Adds a person's bones (prefixed with p) and body. Returns joint positions."""
    mt = dict(HUMAN_MATS, **mats)
    O = V(pelvis)

    def J(x, y, z):
        return O + V(x, y, z) * s

    j = {"pelvis": O, "chest": J(0, 0, 0.36), "neck": J(0, 0, 0.54), "head": J(0, 0, 0.70)}
    for side, sx in (("L", 1), ("R", -1)):
        j["shoulder." + side] = J(0.2 * sx, 0, 0.46)
        j["elbow." + side] = J(0.235 * sx, 0.01, 0.2)
        j["wrist." + side] = J(0.25 * sx, -0.01, -0.04)
        j["hand." + side] = J(0.253 * sx, -0.012, -0.09)
        j["hip." + side] = J(0.105 * sx, 0, 0)
        if seated:
            j["knee." + side] = J(0.30 * sx, -0.28, -0.26)
            j["ankle." + side] = J(0.28 * sx, -0.2, -0.64)
        else:
            j["knee." + side] = J(0.105 * sx, 0, -0.42)
            j["ankle." + side] = J(0.105 * sx, 0, -0.82)

    m.bone(p + "hips", O, J(0, 0, 0.12), parent)
    m.bone(p + "spine", J(0, 0, 0.12), J(0, 0, 0.48), p + "hips")
    m.bone(p + "head", J(0, 0, 0.54), J(0, 0, 0.86), p + "spine")
    for sd in ("L", "R"):
        m.bone(p + "upperarm." + sd, j["shoulder." + sd], j["elbow." + sd], p + "spine")
        m.bone(p + "forearm." + sd, j["elbow." + sd], j["wrist." + sd], p + "upperarm." + sd)
        m.bone(p + "hand." + sd, j["wrist." + sd], j["hand." + sd] + (j["hand." + sd] - j["wrist." + sd]),
               p + "forearm." + sd)
        m.bone(p + "thigh." + sd, j["hip." + sd], j["knee." + sd], p + "hips")
        m.bone(p + "shin." + sd, j["knee." + sd], j["ankle." + sd], p + "thigh." + sd)

    S = T(O, scale=(s, s, s))
    # torso and jacket hem
    m.add(xf(lathe(TORSO, 22), T(scale=(1, TORSO_Y, 1))), mt["torso"], p + "spine", S)
    m.add(xf(lathe([(0.0, -hem_len), (0.225, -hem_len), (0.2, -0.04), (0.168, 0.12), (0.0, 0.12)], 22),
             T(scale=(1, 0.8, 1))), mt["hem"], p + "hips", S)
    m.add(xf(ring(0.182, 0.05, 0.1, 22, 0.03), T(scale=(1, 0.78, 1))), mt["belt"], p + "hips", S)
    # head
    m.add(tube(J(0, 0, 0.44), J(0, 0, 0.6), 0.055 * s), mt["skin"], p + "head")
    m.add(sphere(0.13, 20, 12), mt["skin"], p + "head", T(J(0, 0, 0.7), scale=(s, s, s * 1.08)))
    m.add(sphere(0.024 * s, 10, 6), mt["skin"], p + "head", T(J(0, -0.13, 0.685)))
    for sx in (1, -1):
        m.add(sphere(0.017 * s, 10, 6), mt["hair"], p + "head", T(J(0.05 * sx, -0.118, 0.72)))
        m.add(sphere(0.03, 10, 6), mt["skin"], p + "head", T(J(0.128 * sx, 0.0, 0.69), scale=(0.5 * s, s, 1.2 * s)))
    if queue:  # the Qing queue: a long braid down the back
        m.add(sphere(0.09, 16, 8), mt["hair"], p + "head", T(J(0, 0.035, 0.74), scale=(1.35 * s, 1.1 * s, s)))
        for i in range(9):
            u = i / 8
            m.add(sphere((0.032 - 0.012 * u) * s, 10, 6), mt["hair"], p + "spine",
                  T(J(0, 0.12 + 0.045 * u, 0.62 - 0.42 * u), scale=(1, 1, 1.3)))
    # arms
    for sd in ("L", "R"):
        sh, el, wr = j["shoulder." + sd], j["elbow." + sd], j["wrist." + sd]
        m.add(sphere(0.074 * s, 16, 10), mt["sleeve"], p + "upperarm." + sd, T(sh))
        m.add(tube(sh, el, 0.066 * s, 0.058 * s), mt["sleeve"], p + "upperarm." + sd)
        m.add(sphere(0.058 * s, 14, 8), mt["sleeve"], p + "forearm." + sd, T(el))
        m.add(tube(el, wr, 0.057 * s, 0.05 * s), mt["sleeve"], p + "forearm." + sd)
        d = (wr - el).normalized()
        # "horse-hoof" cuff, flaring over the hand
        m.add(xf(lathe([(0.045, -0.035), (0.058, -0.035), (0.078, 0.03), (0.06, 0.03)], 16, closed=True),
                 T(scale=(s, s, s))), mt["cuff"], p + "forearm." + sd, align(wr, wr + d))
        m.add(sphere(0.05 * s, 14, 8), mt["skin"], p + "hand." + sd, T(j["hand." + sd], scale=(0.9, 1, 1.1)))
    # legs
    for sd in ("L", "R"):
        hp, kn, an = j["hip." + sd], j["knee." + sd], j["ankle." + sd]
        m.add(tube(hp, kn, 0.082 * s, 0.066 * s), mt["thigh"], p + "thigh." + sd)
        m.add(sphere(0.066 * s, 14, 8), mt["thigh"], p + "shin." + sd, T(kn))
        m.add(tube(kn, an, 0.064 * s, 0.05 * s), mt["shin"], p + "shin." + sd)
        m.add(box(0.1, 0.21, 0.075, 0.025), mt["shoe"], p + "shin." + sd, T(an + V(0, -0.045, -0.035) * s, scale=(s, s, s)))
        m.add(box(0.104, 0.22, 0.026, 0.008), mt["sole"], p + "shin." + sd, T(an + V(0, -0.047, -0.067) * s, scale=(s, s, s)))
    return j


def studs(m, bone, O, s, rows, cols, arc=(0, 360), rfn=torso_radius, ry=TORSO_Y, mat="Gold", size=0.013):
    for z in rows:
        rad = rfn(z) + 0.004
        for i in range(cols):
            a = math.radians(arc[0] + (arc[1] - arc[0]) * (i + 0.5) / cols)
            pos = V(O) + V(rad * math.cos(a), rad * ry * math.sin(a), z) * s
            m.add(sphere(size * s, 8, 5), mat, bone, T(pos))


def qing_helmet(m, bone, top, s=1.0, spike=0.32, plume="Nation", big=False):
    """Iron bowl helmet with a gold band, a tall spike and a tassel. `top` = centre of the bowl rim."""
    S = T(top, scale=(s, s, s))
    m.add(lathe([(0.0, 0.16), (0.07, 0.15), (0.12, 0.11), (0.148, 0.05), (0.152, 0.0), (0.0, 0.0)], 22), "Iron", bone, S)
    m.add(ring(0.158, 0.035, 0.012, 22, 0.02), "Gold", bone, S)
    m.add(lathe([(0.0, -0.01), (0.2 if big else 0.175, -0.012), (0.2 if big else 0.175, 0.0), (0.0, 0.0)], 22), "Gold", bone, S)
    m.add(lathe([(0.0, 0.14), (0.035, 0.15), (0.03, 0.2), (0.012, 0.22), (0.012, 0.16 + spike), (0.0, 0.17 + spike)], 12), "Gold", bone, S)
    m.add(lathe([(0.0, 0.12 + spike * 0.55), (0.045, 0.13 + spike * 0.55), (0.045, 0.14 + spike * 0.55), (0.0, 0.15 + spike * 0.55)], 14), "Gold", bone, S)
    # tassel / plume
    base = 0.16 + spike * 0.62
    m.add(lathe([(0.0, base), (0.05, base + 0.03), (0.065 if big else 0.05, base + 0.1), (0.035, base + 0.2 * (1.6 if big else 1)),
                 (0.0, base + 0.25 * (1.7 if big else 1))], 14), plume, bone, S)
    # neck and ear flaps
    m.add(shell(0.17, 0.12, -0.02, 0.0, -100, 100, 0.03, 16), "Indigo", bone,
          T(top + V(0, 0, 0.0) * s, rot=(-90, 0, 0), scale=(s, s, s)) @ T((0, 0, 0), rot=(0, 0, 180)))


def pennant(m, bone, base, height, length, width, mat="Nation", border="Gold", facing=(0, 0, 0), amp=0.035):
    """A pole with a triangular banner flying towards +Y. Returns the pole top."""
    base = V(base)
    top = base + V(0, 0, height)
    m.add(tube(base, top, 0.018), "WoodDark", bone)
    m.add(sphere(0.035, 12, 6), "Gold", bone, T(top + V(0, 0, 0.03)))
    tri = [(0, 0), (length, -width * 0.18), (0, -width)]
    big = [(-0.01, 0.025), (length + 0.07, -width * 0.18), (-0.01, -width - 0.025)]
    R = T(top, rot=facing) @ T(rot=(0, 0, 90))
    m.add(wave(slab(tri, 0.02), 1, 0, amp, 7), mat, bone, R)
    m.add(wave(slab(big, 0.012), 1, 0, amp, 7), border, bone, R)
    return top


# --- quadrupeds ------------------------------------------------------------------------------

def quadruped(m, p, at, parent, s=1.0, kind="horse"):
    O = V(at)
    mule = kind == "mule"
    coat = "Mule" if mule else "Horse"
    dark = "HorseDark"

    def J(x, y, z):
        return O + V(x, y, z) * s

    m.bone(p + "body", J(0, 0.45, 1.05), J(0, -0.45, 1.05), parent)
    m.bone(p + "neck", J(0, -0.5, 1.2), J(0, -0.78, 1.6), p + "body")
    m.bone(p + "head", J(0, -0.78, 1.6), J(0, -1.08, 1.38), p + "neck")
    m.bone(p + "tail", J(0, 0.62, 1.2), J(0, 0.74, 0.76), p + "body")
    legs = {"FL": (0.15, -0.42), "FR": (-0.15, -0.42), "BL": (0.15, 0.44), "BR": (-0.15, 0.44)}
    for n, (x, y) in legs.items():
        m.bone(p + "leg." + n, J(x, y, 0.95), J(x, y, 0.5), p + "body")
        m.bone(p + "shank." + n, J(x, y, 0.5), J(x, y, 0.04), p + "leg." + n)

    SS = (s, s, s)
    body = p + "body"
    m.add(sphere(1, 24, 14), coat, body, T(J(0, 0, 1.06), scale=V(0.27, 0.6, 0.3) * s))
    m.add(sphere(1, 20, 12), coat, body, T(J(0, -0.4, 1.1), scale=V(0.26, 0.3, 0.3) * s))
    m.add(sphere(1, 20, 12), coat, body, T(J(0, 0.4, 1.1), scale=V(0.27, 0.32, 0.29) * s))
    # neck, mane, head
    m.add(tube(J(0, -0.45, 1.12), J(0, -0.8, 1.62), 0.16 * s, 0.1 * s, 16), coat, p + "neck")
    if mule:
        for i in range(6):
            u = i / 5
            m.add(box(0.03, 0.07, 0.07, 0.01), dark, p + "neck", T(J(0, -0.5 - 0.3 * u, 1.34 + 0.34 * u), rot=(-50, 0, 0)))
    else:
        m.add(xf(tube(J(0, -0.43, 1.34), J(0, -0.76, 1.74), 0.05 * s, 0.035 * s, 10), T()), dark, p + "neck")
        for i in range(5):
            u = i / 4
            m.add(sphere(0.055 * s, 10, 6), dark, p + "neck", T(J(0.03, -0.46 - 0.3 * u, 1.36 + 0.36 * u), scale=(0.6, 1, 1.5)))
    hd = p + "head"
    m.add(tube(J(0, -0.8, 1.64), J(0, -1.1, 1.38), 0.105 * s, 0.075 * s, 16), coat, hd)
    m.add(sphere(0.105 * s, 16, 10), coat, hd, T(J(0, -0.8, 1.64)))
    m.add(sphere(1, 16, 10), dark if not mule else "Linen", hd, T(J(0, -1.12, 1.36), scale=V(0.078, 0.09, 0.08) * s))
    ear_h = 0.2 if mule else 0.1
    for sx in (1, -1):
        m.add(tube(J(0.055 * sx, -0.76, 1.7), J(0.08 * sx, -0.73, 1.7 + ear_h), 0.032 * s, 0.006 * s, 8), coat, hd)
        m.add(sphere(0.02 * s, 10, 6), "Hair", hd, T(J(0.085 * sx, -0.88, 1.6)))
    # tail
    if mule:
        m.add(tube(J(0, 0.62, 1.2), J(0, 0.72, 0.85), 0.025 * s, 0.02 * s, 8), coat, p + "tail")
        m.add(sphere(1, 10, 8), dark, p + "tail", T(J(0, 0.73, 0.78), scale=V(0.05, 0.05, 0.12) * s))
    else:
        m.add(tube(J(0, 0.6, 1.22), J(0, 0.76, 0.74), 0.07 * s, 0.09 * s, 12), dark, p + "tail")
        m.add(sphere(0.09 * s, 12, 8), dark, p + "tail", T(J(0, 0.77, 0.72), scale=(1, 1, 1.4)))
    # legs
    for n, (x, y) in legs.items():
        back = n[0] == "B"
        top, knee, foot = J(x, y, 0.98), J(x, y, 0.5), J(x, y, 0.08)
        m.add(tube(top, knee, (0.13 if back else 0.11) * s, 0.065 * s, 12), coat, p + "leg." + n)
        m.add(sphere(0.066 * s, 12, 8), coat, p + "shank." + n, T(knee))
        m.add(sphere(0.052 * s, 12, 8), coat if mule else dark, p + "shank." + n, T(foot + V(0, 0, 0.04) * s))
        m.add(tube(knee, foot, 0.055 * s, 0.048 * s, 12), coat if mule else (dark if not back else coat), p + "shank." + n)
        m.add(cyl(0.066, 0.055, 0.09, 14), dark, p + "shank." + n, T(J(x, y - 0.01, 0.0), scale=SS))
    return {"back": J(0, 0.0, 1.36), "withers": J(0, -0.4, 1.4)}


def horse_walk(p, t, amp=22):
    """Four-beat walk: hind left, fore left, hind right, fore right."""
    out = {}
    for n, off in (("BL", 0.0), ("FL", 0.25), ("BR", 0.5), ("FR", 0.75)):
        ph = 2 * math.pi * (t + off)
        out[p + "leg." + n] = r(-amp * math.sin(ph))
        out[p + "shank." + n] = r((1 if n[0] == "F" else 0.6) * 38 * max(0.0, math.cos(ph)))
    out[p + "body"] = r(1.5 * math.sin(4 * math.pi * t), 0, 2 * math.sin(2 * math.pi * t),
                        l=(0, 0, 0.02 * math.sin(4 * math.pi * t)))
    out[p + "neck"] = r(-5 * math.sin(4 * math.pi * t + 1))
    out[p + "head"] = r(4 * math.sin(4 * math.pi * t + 1.5))
    out[p + "tail"] = r(0, 10 * math.sin(2 * math.pi * t), 0)
    return out


def horse_idle(p, t):
    w = 2 * math.pi * t
    return {
        p + "body": r(0.8 * math.sin(w), l=(0, 0, 0.006 * math.sin(w))),
        p + "neck": r(-4 + 5 * math.sin(w)),
        p + "head": r(6 * pulse(t, 0.55, 0.85), 0, 0),
        p + "tail": r(0, 16 * math.sin(2 * w) * pulse(t, 0.1, 0.5), 0),
        p + "leg.FR": r(-18 * pulse(t, 0.2, 0.4)),
        p + "shank.FR": r(40 * pulse(t, 0.2, 0.4)),
    }


# ---------------------------------------------------------------------------------------------
# Units
# ---------------------------------------------------------------------------------------------

def humanoid_walk(p, t, stride=26, knee=42, arms=18):
    ph = 2 * math.pi * t
    sn, cs = math.sin(ph), math.cos(ph)
    return {
        p + "hips": r(0, 0, 4 * sn, l=(0, 0, 0.028 * abs(cs) - 0.02)),
        p + "spine": r(3, 0, -7 * sn),
        p + "head": r(0, 0, 3 * sn),
        p + "thigh.L": r(-stride * sn),
        p + "thigh.R": r(stride * sn),
        p + "shin.L": r(4 + knee * max(0.0, cs)),
        p + "shin.R": r(4 + knee * max(0.0, -cs)),
        p + "upperarm.L": r(arms * sn, -6),
        p + "upperarm.R": r(-arms * sn, 6),
        p + "forearm.L": r(-12 - 8 * sn),
        p + "forearm.R": r(-12 + 8 * sn),
    }


def breathe(p, t, k=1.0):
    w = 2 * math.pi * t
    return {p + "spine": r(1.2 * k * math.sin(w)), p + "hips": r(l=(0, 0, 0.004 * k * math.sin(w))),
            p + "upperarm.L": r(0, -1.5 * k * math.sin(w)), p + "upperarm.R": r(0, 1.5 * k * math.sin(w))}


def infantry():
    """Green Standard musketeer: rattan hat, banner-coloured vest with a round badge, matchlock."""
    m = Model("infantry")
    m.bone("root", (0, 0, 0), (0, 0, 0.25))
    j = humanoid(m, "", (0, 0, 0.9), "root", torso="Nation", hem="Indigo", cuff="Linen")
    O = j["pelvis"]
    # round badge (the soldier's "勇" patch) on chest and back
    for y, rot in ((-1, 90), (1, -90)):
        m.add(cyl(0.085, 0.085, 0.012, 24), "Linen", "spine", T(O + V(0, 0.135 * y, 0.3), rot=(rot, 0, 0)))
        m.add(ring(0.062, 0.014, 0, 24, 0.012), "Indigo", "spine", T(O + V(0, 0.142 * y, 0.3), rot=(rot, 0, 0)))
        m.add(box(0.012, 0.012, 0.075), "Indigo", "spine", T(O + V(0, 0.143 * y, 0.3)))
        m.add(box(0.075, 0.012, 0.012), "Indigo", "spine", T(O + V(0, 0.143 * y, 0.3)))
    # trim along the vest's hem and collar
    m.add(xf(ring(0.162, 0.03, 0.075, 22, 0.02), T(scale=(1, 0.75, 1))), "Indigo", "spine", T(O))
    m.add(xf(lathe([(0.075, 0.5), (0.1, 0.5), (0.085, 0.56), (0.065, 0.56)], 18, closed=True), T(scale=(1, 0.95, 1))),
          "Indigo", "spine", T(O))
    # conical rattan hat with a tassel crown
    hat = j["head"] + V(0, 0, 0.075)
    m.add(lathe([(0.0, -0.01), (0.3, 0.0), (0.3, 0.012), (0.2, 0.07), (0.1, 0.13), (0.0, 0.16)], 26), "Rattan", "head", T(hat))
    m.add(ring(0.3, 0.014, 0.006, 26, 0.01), "WoodDark", "head", T(hat))
    m.add(lathe([(0.0, 0.07), (0.16, 0.075), (0.14, 0.115), (0.07, 0.16), (0.0, 0.185)], 20), "Nation", "head", T(hat))
    m.add(sphere(0.028, 12, 8), "Gold", "head", T(hat + V(0, 0, 0.19)))
    # powder gourd and cartridge pouch
    m.add(lathe([(0, 0), (0.04, 0.01), (0.05, 0.05), (0.025, 0.09), (0.035, 0.12), (0.022, 0.15), (0, 0.16)], 14),
          "Wood", "hips", T(O + V(0.2, -0.05, -0.2)))
    m.add(box(0.08, 0.14, 0.1, 0.02), "Leather", "hips", T(O + V(-0.14, 0.1, 0.02)))
    # matchlock musket, held upright at the right side in the rest pose
    ax = V(-0.268, -0.03, 0)
    m.bone("musket", ax + V(0, 0, 0.81), ax + V(0, 0, 0.98), "hand.R")
    m.add(xf(cyl(0.065, 0.038, 0.48, 4), T(rot=(0, 0, 45), scale=(0.55, 1, 1))), "Wood", "musket", T(ax + V(0, 0.01, 0.03)))
    m.add(box(0.036, 0.046, 0.62), "Wood", "musket", T(ax + V(0, 0, 0.8)))
    m.add(tube(ax + V(0, -0.006, 0.48), ax + V(0, -0.006, 1.62), 0.017, 0.016, 12), "Iron", "musket")
    for z in (0.72, 0.95, 1.12):
        m.add(ring(0.028, 0.02, 0, 12, 0.012), "Bronze", "musket", T(ax + V(0, -0.004, z)))
    m.add(box(0.02, 0.05, 0.08, 0.005), "Iron", "musket", T(ax + V(0.03, 0, 0.53)))
    m.add(tube(ax + V(0.03, 0, 0.56), ax + V(0.03, -0.03, 0.63), 0.007), "Iron", "musket")
    m.add(xf(ring(0.04, 0.03, 0, 12, 0.012), T(rot=(0, 90, 0))), "Linen", "musket", T(ax + V(0.035, 0.02, 0.44)))
    muzzle = ax + V(0, -0.006, 1.62)
    muzzle_flash(m, "flash", muzzle, (0, 0, 1), "musket", size=1.5)
    m.build()

    def idle(t):
        w = 2 * math.pi * t
        return add(breathe("", t), {
            "head": r(0, 0, 14 * math.sin(w) * pulse(t, 0.1, 0.9)),
            "upperarm.R": r(-4), "forearm.R": r(-8), "musket": r(4),
            "upperarm.L": r(0, -3), "flash": {"s": 0.0},
        })

    shoulder = {"upperarm.R": r(-10, 4), "forearm.R": r(-95, 0, 20), "hand.R": r(0, 0, 0),
                "musket": r(75, -18, 0, slide=0.55), "flash": {"s": 0.0}}

    def walk(t):
        pose = humanoid_walk("", t)
        pose.pop("upperarm.R"), pose.pop("forearm.R")
        return add(pose, shoulder)

    def aiming(recoil=0.0, flash=0.0):
        back = V(0, recoil, recoil * 0.4)
        return add(P(hips=r(0, 0, -22), spine=r(4, 0, -26), head=r(6, 0, 40), thigh__L=r(-14, -6), shin__L=r(12),
                     thigh__R=r(10, 8), shin__R=r(4), flash={"s": flash}),
                   ik("upperarm.R", "forearm.R", V(-0.1, -0.14, 1.4) + back, None, (-0.6, 0.2, 0.9)),
                   aim("musket", V(0, -1, recoil * 0.6), None, 0.48),
                   ik("upperarm.L", "forearm.L", V(-0.09, -0.5, 1.36) + back, None, (0.5, -0.3, 0.8)))

    def reloading(ram):
        return add(P(spine=r(6, 0, -10), head=r(4, 0, 8), flash={"s": 0.0}),
                   ik("upperarm.L", "forearm.L", (-0.02, -0.34, 1.02), None, (0.6, 0.2, 0.9)),
                   ik("upperarm.R", "forearm.R", (-0.05, -0.36, 1.12), None, (-0.6, 0.2, 0.9)),
                   aim("musket", (0, -0.12, 1), None, 0.0),
                   ik("upperarm.L", "forearm.L", (0.0, -0.4, 1.62 + 0.14 * ram), None, (0.6, 0.2, 0.9)))

    ready, fire, kick = aiming(), aiming(0.05, 1.0), aiming(0.02)
    load0, load1 = reloading(0), reloading(1)
    idle0 = idle(0)

    def combat(t):
        return keyed(t, [(0, idle0), (0.16, ready), (0.3, ready), (0.33, fire), (0.4, kick), (0.54, load0),
                         (0.62, load1), (0.7, load0), (0.76, load1), (0.9, idle0), (1.0, idle0)])

    return m, {"Idle": idle, "Walk": walk, "Combat": combat}


def muzzle_flash(m, bone, at, direction, parent, size=1.0):
    at, d = V(at), V(direction).normalized()
    m.bone(bone, at, at + d * 0.1, parent)
    Q = align(at, at + d)
    S = T(scale=(size, size, size))
    m.add(xf(lathe([(0.0, 0.0), (0.06, 0.03), (0.075, 0.1), (0.04, 0.25), (0.0, 0.34)], 12), S), "Flash", bone, Q)
    for (x, y, z, rad) in ((0.07, 0.05, 0.18, 0.08), (-0.08, -0.02, 0.22, 0.09), (0.0, 0.08, 0.3, 0.1), (0.02, -0.07, 0.4, 0.085)):
        m.add(sphere(rad * size, 12, 8), "Smoke", bone, Q @ T(V(x, y, z) * size))


def cavalry():
    """Manchu bannerman horse archer: banner-coloured studded coat, back banner, composite bow."""
    m = Model("cavalry")
    m.bone("root", (0, 0, 0), (0, 0, 0.3))
    quadruped(m, "", (0, 0, 0), "root")
    # saddle cloth, saddle, stirrups
    m.add(shell(0.3, 0.33, -0.3, 0.42, -78, 78, 0.02, 20), "Nation", "body", T((0, 0, 1.06)))
    for a in (-78, 78):
        m.add(shell(0.302, 0.332, -0.31, 0.43, a - 3 if a > 0 else a, a + 3 if a < 0 else a, 0.015, 2), "Gold", "body",
              T((0, 0, 1.06)))
    m.add(box(0.3, 0.46, 0.08, 0.03), "Leather", "body", T((0, 0.04, 1.39)))
    m.add(box(0.26, 0.06, 0.12, 0.025), "Leather", "body", T((0, -0.2, 1.44)))
    m.add(box(0.26, 0.06, 0.1, 0.025), "Leather", "body", T((0, 0.28, 1.44)))
    for sx in (1, -1):
        m.add(tube((0.2 * sx, 0.02, 1.38), (0.27 * sx, -0.14, 0.86), 0.008), "Leather", "body")
        m.add(xf(ring(0.04, 0.02, 0, 12, 0.012), T(rot=(0, 90, 0))), "Iron", "body", T((0.27 * sx, -0.14, 0.83)))
    j = humanoid(m, "r_", (0, 0.06, 1.48), "body", seated=True, torso="Nation", hem="Nation",
                 shin="Hair", thigh="Indigo", cuff="Indigo")
    O = j["pelvis"]
    studs(m, "r_spine", O, 1.0, (0.12, 0.2, 0.28, 0.36), 16)
    m.add(ring(0.165, 0.02, 0.0, 22, 0.012), "Gold", "r_hips", T(O + V(0, 0, -0.2), scale=(1.36, 1.1, 1)))
    qing_helmet(m, "r_head", j["head"] + V(0, 0, 0.055), spike=0.22)
    # quiver on the right hip
    q = O + V(-0.24, 0.12, -0.02)
    m.add(box(0.07, 0.16, 0.36, 0.03), "Leather", "r_hips", T(q, rot=(-20, 0, 0)))
    m.add(box(0.075, 0.165, 0.05, 0.01), "Gold", "r_hips", T(q + V(0, -0.06, 0.16), rot=(-20, 0, 0)))
    for i, (x, y) in enumerate(((0.0, -0.03), (0.015, 0.02), (-0.015, 0.0), (0.0, 0.05))):
        tip = q + V(x, y - 0.12, 0.3)
        m.add(tube(q + V(x, y - 0.06, 0.15), tip, 0.006), "Wood", "r_hips")
        m.add(box(0.008, 0.05, 0.07), "Linen", "r_hips", T(tip + V(0, 0.01, -0.02), rot=(-20, 0, 0)))
    # back banner of the Eight Banners
    m.bone("r_banner", O + V(0, 0.17, 0.3), O + V(0, 0.17, 0.6), "r_spine")
    m.add(box(0.1, 0.04, 0.22, 0.015), "Leather", "r_banner", T(O + V(0, 0.16, 0.3)))
    pennant(m, "r_banner", O + V(0, 0.18, 0.18), 1.5, 0.62, 0.42)
    # composite bow in the left hand, arrow in the right
    h = j["hand.L"]
    m.bone("r_bow", h, h + V(0, 0, 0.2), "r_hand.L")
    pts = []
    for i in range(13):
        z = -0.6 + 1.2 * i / 12
        u = abs(z) / 0.6
        pts.append(h + V(0, -0.13 * (1 - u * u) + (0.09 * ((u - 0.75) / 0.25) ** 2 if u > 0.75 else 0), z))
    for a, b in zip(pts, pts[1:]):
        mid = abs((a.z + b.z) / 2 - h.z) / 0.6
        m.add(tube(a, b, 0.022 - 0.01 * mid, 0.022 - 0.01 * mid, 8), "Leather" if mid < 0.75 else "Gold", "r_bow")
        m.add(sphere(0.022 - 0.01 * mid, 8, 5), "Leather" if mid < 0.75 else "Gold", "r_bow", T(b))
    m.add(tube(pts[1], pts[-2], 0.004, 0.004, 6), "Linen", "r_bow")
    m.add(box(0.05, 0.05, 0.12, 0.015), "Nation", "r_bow", T(h + V(0, -0.13, 0)))
    ha = j["hand.R"]
    m.bone("r_arrow", ha, ha + V(0, -0.1, 0), "r_hand.R")
    m.add(tube(ha + V(0, 0.08, 0), ha + V(0, -0.72, 0), 0.007, 0.007, 6), "Wood", "r_arrow")
    m.add(tube(ha + V(0, -0.72, 0), ha + V(0, -0.8, 0), 0.018, 0.0, 8), "Iron", "r_arrow")
    for rot in (0, 120, 240):
        m.add(box(0.004, 0.09, 0.03), "Linen", "r_arrow", T(ha + V(0, 0.04, 0), rot=(0, rot, 0)) @ T((0, 0, 0.015)))
    m.build()

    seat = P(r_thigh__L=r(0), r_upperarm__L=r(-35, 10), r_forearm__L=r(-40), r_bow=r(0, 0, 0),
             r_upperarm__R=r(-35, -10), r_forearm__R=r(-45, 0, 0), r_arrow={"s": 0.0})

    def idle(t):
        w = 2 * math.pi * t
        return add(horse_idle("", t), seat, breathe("r_", t),
                   {"r_head": r(0, 0, -18 * pulse(t, 0.15, 0.6)), "r_banner": r(0, 3 * math.sin(w), 3 * math.sin(w))})

    def walk(t):
        w = 2 * math.pi * t
        return add(horse_walk("", t), seat,
                   {"r_hips": r(3 * math.sin(2 * w), l=(0, 0, 0.015 * math.sin(2 * w - 0.8))),
                    "r_spine": r(-2 * math.sin(2 * w - 1)), "r_banner": r(0, 4 * math.sin(w), 5 * math.sin(2 * w))})

    rest = add(horse_idle("", 0), seat)
    def drawing(pull, arrow):
        bow_hand, string_hand = V(0.66, -0.22, 2.0), V(0.02 + 0.2 * (1 - pull), 0.04 - 0.06 * (1 - pull), 2.0)
        shot = (bow_hand - string_hand).normalized()
        return add(P(body=r(-4), neck=r(-10), r_spine=r(-4, 0, 50), r_head=r(0, 0, 30), r_banner=r(0, -6, 0),
                     r_arrow={"s": arrow}),
                   ik("r_upperarm.L", "r_forearm.L", bow_hand, None, (0.4, 0.3, 1.4)),
                   ik("r_upperarm.R", "r_forearm.R", string_hand, None, (-0.3, 0.6, 2.0)),
                   aim("r_bow", (0, 0, 1), None, 0.0, ref=(0, -1, 0), side=shot),
                   aim("r_arrow", bow_hand, None, 0.0, point=True, ref=(0, 0, 1), side=(0, 0, 1)))

    draw, loose = drawing(1.0, 1.0), drawing(0.3, 0.0)
    rear = add(P(body=r(-14, l=(0, 0, 0.05)), neck=r(-20), head=r(15), leg__FL=r(-50), shank__FL=r(70),
                 leg__FR=r(-35), shank__FR=r(80), leg__BL=r(12), leg__BR=r(14), tail=r(-15)), seat,
               P(r_spine=r(-10), r_upperarm__L=r(-60, -20), r_upperarm__R=r(-20, -60)))
    rear["r_arrow"]["s"] = 0.0

    def combat(t):
        return keyed(t, [(0, rest), (0.2, draw), (0.31, draw), (0.34, loose), (0.46, loose),
                         (0.62, rear), (0.72, rear), (0.9, rest), (1, rest)])

    return m, {"Idle": idle, "Walk": walk, "Combat": combat}


def artillery():
    """Bronze cannon on a lacquered field carriage, served by a gunner with a linstock."""
    m = Model("artillery")
    m.bone("root", (0, 0, 0), (0, 0, 0.25))
    m.bone("carriage", (0, 0, 0.45), (0, 0.4, 0.45), "root")
    m.bone("barrel", (0, 0.05, 0.86), (0, -0.25, 0.86), "carriage")
    for sd, sx in (("L", 1), ("R", -1)):
        m.bone("wheel." + sd, (0.44 * sx, 0, 0.45), (0.6 * sx, 0, 0.45), "carriage")
        m.addmany(wheel(0.45, 0.07, 12, rim="Wood", hub="Nation"), "wheel." + sd, T((0.44 * sx, 0, 0.45)))
    # carriage cheeks (the trail rests on the ground behind the gun)
    cheek = [(-0.5, 0.48), (-0.5, 0.78), (0.05, 0.82), (0.35, 0.72), (1.35, 0.14), (1.35, 0.0), (1.12, 0.0), (0.25, 0.46)]
    for sx in (1, -1):
        m.add(slab(cheek, 0.07), "Nation", "carriage", T((0.17 * sx, 0, 0), rot=(0, 0, 90)))
        for y, z in ((-0.4, 0.7), (0.0, 0.74), (0.35, 0.64), (0.8, 0.4), (1.2, 0.12)):
            m.add(sphere(0.018, 8, 5), "Iron", "carriage", T((0.21 * sx, y, z)))
        m.add(box(0.075, 0.08, 0.05), "Iron", "carriage", T((0.17 * sx, 0.05, 0.82)))
    m.add(box(1.02, 0.12, 0.1, 0.02), "WoodDark", "carriage", T((0, 0, 0.45)))
    for y, z in ((-0.35, 0.6), (0.6, 0.36), (1.25, 0.08)):
        m.add(box(0.34, 0.1, 0.08, 0.015), "WoodDark", "carriage", T((0, y, z)))
    m.add(xf(ring(0.06, 0.04, 0, 14, 0.02), T(rot=(0, 90, 0))), "Iron", "carriage", T((0, 1.3, 0.2)))
    # bronze barrel: breech at +Y, muzzle at -Y
    B = T((0, 0.62, 0.86), rot=(90, 0, 0))
    prof = [(0.0, -0.13), (0.045, -0.12), (0.035, -0.07), (0.12, -0.04), (0.16, 0.0), (0.16, 0.1), (0.175, 0.1),
            (0.175, 0.16), (0.15, 0.16), (0.135, 0.7), (0.15, 0.7), (0.15, 0.76), (0.13, 0.76), (0.11, 1.35),
            (0.125, 1.4), (0.145, 1.52), (0.145, 1.6), (0.07, 1.6), (0.065, 1.35), (0.0, 1.35)]
    m.add(lathe(prof, 24), "Bronze", "barrel", B)
    for z in (0.13, 0.73, 1.56):
        m.add(ring(0.163 if z < 1 else 0.15, 0.03, z, 24, 0.02), "Gold", "barrel", B)
    m.add(tube((-0.23, 0.07, 0.86), (0.23, 0.07, 0.86), 0.045, 0.045, 12), "Bronze", "barrel")
    m.add(box(0.05, 0.05, 0.03), "Bronze", "barrel", T((0, 0.5, 1.01)))  # vent
    # dolphins (lifting handles) shaped like little dragons
    for sx in (1, -1):
        m.add(tube((0.05 * sx, 0.2, 1.0), (0.05 * sx, -0.05, 1.02), 0.02, 0.016, 8), "Gold", "barrel")
        m.add(sphere(0.03, 10, 6), "Gold", "barrel", T((0.05 * sx, -0.07, 1.02)))
    muzzle_flash(m, "flash", (0, -0.99, 0.86), (0, -1, 0), "barrel", size=2.4)
    # regimental pennant on the trail
    m.bone("flag", (0.3, 0.95, 0.25), (0.3, 0.95, 0.6), "carriage")
    pennant(m, "flag", (0.3, 0.95, 0.25), 1.35, 0.55, 0.4, facing=(0, 0, 0))
    m.add(tube((0.18, 0.95, 0.3), (0.3, 0.95, 0.3), 0.012), "Iron", "flag")
    # rammer and shot pile
    m.add(tube((-0.28, -0.3, 0.05), (-0.34, 1.2, 0.05), 0.018), "Wood", "root")
    m.add(cyl(0.06, 0.06, 0.1, 14), "Linen", "root", T((-0.34, -0.36, 0.05), rot=(90, 0, 0)))
    for (x, y, z) in ((0.45, 0.75, 0.06), (0.57, 0.75, 0.06), (0.51, 0.86, 0.06), (0.51, 0.79, 0.16)):
        m.add(sphere(0.065, 12, 8), "Iron", "root", T((x, y, z)))
    # gunner: stripped to a linen shirt, banner-coloured sash and head wrap
    j = humanoid(m, "g_", (-0.82, 0.3, 0.9), "root", torso="Linen", sleeve="Linen", cuff="Nation", hem="Indigo")
    O = j["pelvis"]
    m.add(tube(O + V(0.17, -0.12, 0.47), O + V(-0.17, -0.1, 0.05), 0.04), "Nation", "g_spine")
    m.add(tube(O + V(0.17, 0.12, 0.47), O + V(-0.17, 0.1, 0.05), 0.04), "Nation", "g_spine")
    m.add(xf(ring(0.137, 0.06, 0.0, 22, 0.03), T(scale=(1, 1, 1))), "Nation", "g_head", T(j["head"] + V(0, 0, 0.05), rot=(-8, 0, 0)))
    m.add(sphere(0.05, 12, 8), "Nation", "g_head", T(j["head"] + V(0, 0.14, 0.06)))
    m.add(tube(j["head"] + V(0, 0.15, 0.04), j["head"] + V(0.02, 0.22, -0.12), 0.025, 0.012), "Nation", "g_head")
    ax = j["hand.R"] + V(-0.015, -0.02, 0)
    m.bone("g_linstock", ax, ax + V(0, 0, 0.2), "g_hand.R")
    m.add(tube(ax + V(0, 0, -0.45), ax + V(0, 0, 0.62), 0.016), "Wood", "g_linstock")
    m.add(tube(ax + V(0, 0, 0.62), ax + V(0.04, 0, 0.72), 0.008), "Iron", "g_linstock")
    m.add(tube(ax + V(0, 0, 0.62), ax + V(-0.04, 0, 0.72), 0.008), "Iron", "g_linstock")
    m.add(sphere(0.02, 8, 6), "Flash", "g_linstock", T(ax + V(0.04, 0, 0.74)))
    m.build()

    def idle(t):
        w = 2 * math.pi * t
        return add(breathe("g_", t), {"g_head": r(0, 0, 20 * pulse(t, 0.2, 0.7)), "g_linstock": r(4),
                                      "g_upperarm.R": r(-4), "g_forearm.R": r(-8), "flash": {"s": 0.0},
                                      "flag": r(0, 0, 4 * math.sin(w))})

    def walk(t):
        w = 2 * math.pi * t
        pose = humanoid_walk("g_", t, stride=24)
        pose["g_upperarm.L"] = r(-55, -10)
        pose["g_forearm.L"] = r(-20)
        return add(pose, {"wheel.L": r(360 * t * 0.999), "wheel.R": r(360 * t * 0.999),
                          "carriage": r(1.2 * math.sin(2 * w), l=(0, 0, 0.012 * abs(math.sin(2 * w)))),
                          "g_upperarm.R": r(-8), "g_forearm.R": r(-8), "g_linstock": r(8),
                          "flash": {"s": 0.0}, "flag": r(0, 0, 6 * math.sin(w))})

    rest = idle(0)
    reach = add(P(g_hips=r(0, 0, 68, l=(0.12, 0.05, -0.04)), g_spine=r(22), g_head=r(-8), g_thigh__L=r(-30),
                  g_shin__L=r(30), g_thigh__R=r(15), g_upperarm__L=r(-20, -20)), {"flash": {"s": 0.0}},
                ik("g_upperarm.R", "g_forearm.R", (-0.5, 0.42, 1.3), None, (-1.0, 0.8, 0.9)),
                aim("g_linstock", (0.0, 0.5, 1.04), None, point=True, reach=0.74))
    lean_away = add(P(g_hips=r(0, 0, 50, l=(0.02, 0.1, 0)), g_spine=r(-8, 0, 0), g_head=r(0, 0, -20),
                      g_upperarm__R=r(-20, 8), g_upperarm__L=r(-50, -20), g_forearm__L=r(-60), g_linstock=r(20)),
                    {"flash": {"s": 0.0}})
    fire = add(lean_away, P(barrel=r(-6, l=(0, 0.24, 0)), carriage=r(-3, l=(0, 0.08, 0.02))))
    fire["flash"]["s"] = 1.0
    settle = add(lean_away, P(barrel=r(-2, l=(0, 0.06, 0)), carriage=r(0, l=(0, 0.1, 0))))
    settle["flash"]["s"] = 0.0

    def combat(t):
        return keyed(t, [(0, rest), (0.12, reach), (0.22, reach), (0.3, lean_away), (0.34, fire), (0.45, settle),
                         (0.8, rest), (1, rest)])

    return m, {"Idle": idle, "Walk": walk, "Combat": combat}


def supply():
    """Peking cart: two big wheels, a vaulted banner-coloured canopy and a mule in the shafts."""
    m = Model("supply")
    m.bone("root", (0, 0, 0), (0, 0, 0.25))
    m.bone("cart", (0, 0.15, 0.62), (0, 0.55, 0.62), "root")
    R = 0.55
    for sd, sx in (("L", 1), ("R", -1)):
        m.bone("wheel." + sd, (0.6 * sx, 0.15, R), (0.75 * sx, 0.15, R), "cart")
        m.addmany(wheel(R, 0.08, 14, rim="Wood", hub="WoodDark"), "wheel." + sd, T((0.6 * sx, 0.15, R)))
    # body, floor and rails
    m.add(box(0.92, 1.45, 0.1, 0.02), "WoodDark", "cart", T((0, 0.15, 0.66)))
    m.add(box(1.24, 0.1, 0.08, 0.02), "WoodDark", "cart", T((0, 0.15, 0.58)))
    for sx in (1, -1):
        m.add(box(0.06, 1.45, 0.14, 0.015), "Wood", "cart", T((0.44 * sx, 0.15, 0.76)))
        # shafts to the mule
        m.add(tube((0.36 * sx, 0.7, 0.66), (0.33 * sx, -1.55, 0.98), 0.03, 0.026, 10), "Wood", "cart")
        m.add(tube((0.33 * sx, -1.55, 0.98), (0.33 * sx, -2.1, 1.02), 0.026, 0.02, 10), "Wood", "cart")
    # vaulted canopy with lacquered ribs and a cloth front curtain
    C = T((0, 0, 0.8))
    m.add(shell(0.47, 0.62, -0.5, 0.72, -90, 90, 0.03, 20), "Nation", "cart", C)
    for y in (-0.52, 0.1, 0.72):
        m.add(shell(0.49, 0.64, y - 0.025, y + 0.025, -92, 92, 0.03, 20), "WoodDark", "cart", C)
    m.add(shell(0.475, 0.625, -0.505, -0.49, -60, 60, 0.6, 12), "Indigo", "cart", C)
    for sx in (1, -1):
        m.add(box(0.02, 0.26, 0.2, 0.02), "Indigo", "cart", T((0.475 * sx, 0.1, 1.08)))
        m.add(box(0.025, 0.2, 0.14, 0.01), "Linen", "cart", T((0.48 * sx, 0.1, 1.08)))
    # cargo at the back: rice sacks and a wine jar
    for (x, y, z, rot) in ((0.2, 0.72, 0.84, 10), (-0.18, 0.74, 0.84, -12), (0.0, 0.78, 1.02, 3)):
        m.add(sphere(1, 14, 10), "Linen", "cart", T((x, y, z), rot=(0, rot, 0), scale=(0.2, 0.16, 0.13)))
        m.add(sphere(0.035, 8, 5), "Linen", "cart", T((x, y + 0.03, z + 0.13)))
    m.add(lathe([(0, 0), (0.08, 0.0), (0.12, 0.08), (0.11, 0.2), (0.05, 0.26), (0.055, 0.3), (0, 0.3)], 16), "Ceramic",
          "cart", T((0.3, 0.95, 0.7)))
    m.add(lathe([(0.05, 0.28), (0.06, 0.3), (0.06, 0.33), (0, 0.34)], 12), "Nation", "cart", T((0.3, 0.95, 0.7)))
    m.add(xf(lathe([(0, 0), (0.06, 0.0), (0.06, 0.02), (0, 0.02)], 3), T(scale=(1.4, 1, 1))), "Nation", "cart",
          T((0.0, 0.83, 1.18), rot=(90, 0, 0)))
    # lantern hanging at the front
    m.bone("lantern", (0.26, -0.72, 1.42), (0.26, -0.72, 1.2), "cart")
    m.add(tube((0.15, -0.45, 1.3), (0.26, -0.76, 1.45), 0.012), "WoodDark", "cart")
    m.add(tube((0.26, -0.72, 1.44), (0.26, -0.72, 1.33), 0.004), "Hair", "lantern")
    m.add(lathe([(0, 0.0), (0.05, 0.0), (0.085, 0.04), (0.09, 0.09), (0.05, 0.13), (0, 0.13)], 16), "Nation", "lantern",
          T((0.26, -0.72, 1.18)))
    for z in (1.18, 1.31):
        m.add(cyl(0.05, 0.05, 0.02, 12), "Gold", "lantern", T((0.26, -0.72, z - 0.005)))
    m.add(tube((0.26, -0.72, 1.18), (0.26, -0.72, 1.1), 0.012, 0.0), "Nation", "lantern")
    # mule, with a padded collar
    quadruped(m, "m_", (0, -1.95, 0), "root", s=0.85, kind="mule")
    m.add(xf(ring(0.2, 0.08, 0, 18, 0.06), T(scale=(1, 1.1, 1))), "Nation", "m_neck", T((0, -2.4, 1.1), rot=(-50, 0, 0)))
    m.add(shell(0.24, 0.27, -0.2, 0.2, -65, 65, 0.02, 14), "Leather", "m_body", T((0, -1.95, 0.9)))
    for sx in (1, -1):
        m.add(sphere(0.035, 10, 6), "Gold", "m_neck", T((0.19 * sx, -2.4, 1.12)))
    # driver on the front of the cart, in a wide bamboo hat
    j = humanoid(m, "d_", (-0.26, -0.5, 0.86), "cart", seated=True, s=0.95, torso="Indigo", hem="Indigo", thigh="Linen",
                 shin="Linen", cuff="Linen")
    hat = j["head"] + V(0, 0, 0.06)
    m.add(lathe([(0, -0.005), (0.36, 0.0), (0.36, 0.01), (0.08, 0.11), (0.0, 0.13)], 26), "Rattan", "d_head", T(hat))
    m.add(ring(0.36, 0.012, 0.005, 26, 0.012), "WoodDark", "d_head", T(hat))
    m.add(sphere(0.03, 10, 6), "Nation", "d_head", T(hat + V(0, 0, 0.13)))
    hw = j["hand.R"]
    m.bone("d_whip", hw, hw + V(0, -0.15, 0.1), "d_hand.R")
    m.add(tube(hw + V(0, 0.08, -0.05), hw + V(0, -0.45, 0.35), 0.012, 0.008, 8), "Wood", "d_whip")
    pts = [hw + V(0, -0.45 - 0.08 * i, 0.35 + 0.04 * i - 0.025 * i * i) for i in range(6)]
    for a, b in zip(pts, pts[1:]):
        m.add(tube(a, b, 0.006, 0.005, 6), "Leather", "d_whip")
    m.add(box(0.05, 0.05, 0.06), "Nation", "d_whip", T(pts[-1]))
    m.build()

    seat = P(d_upperarm__L=r(-30, -8), d_forearm__L=r(-40), d_upperarm__R=r(-35, 8), d_forearm__R=r(-35),
             d_whip=r(0, 0, 0), d_thigh__L=r(-10), d_shin__L=r(-5), d_thigh__R=r(-10), d_shin__R=r(-5))

    def idle(t):
        w = 2 * math.pi * t
        return add(horse_idle("m_", t), seat, breathe("d_", t),
                   {"lantern": r(3 * math.sin(w), 0, 0), "d_head": r(10 * pulse(t, 0.45, 0.8), 0, 12 * pulse(t, 0.05, 0.4)),
                    "d_shin.L": r(12 * math.sin(2 * w)), "d_shin.R": r(-12 * math.sin(2 * w))})

    def walk(t):
        w = 2 * math.pi * t
        return add(horse_walk("m_", t, amp=20), seat,
                   {"wheel.L": r(360 * t * 0.999 * 0.62), "wheel.R": r(360 * t * 0.999 * 0.62),
                    "cart": r(1.0 * math.sin(2 * w), 0, 0, l=(0, 0, 0.012 * abs(math.sin(2 * w)))),
                    "lantern": r(10 * math.sin(2 * w + 1), 0, 4 * math.sin(w)),
                    "d_hips": r(0, 3 * math.sin(2 * w), 0), "d_head": r(4 * math.sin(2 * w))})

    rest = idle(0)
    buck = add(P(m_body=r(10, l=(0, 0, 0.04)), m_neck=r(25), m_head=r(20), m_leg__BL=r(35), m_shank__BL=r(-20),
                 m_leg__BR=r(40), m_shank__BR=r(-25), m_tail=r(-30), lantern=r(-18)), seat)
    whip_up = add(seat, P(d_spine=r(-8, 0, -10), d_upperarm__R=r(-150, 20, 0), d_forearm__R=r(-20), d_whip=r(-20),
                          d_head=r(-6), lantern=r(8)))
    whip_down = add(seat, P(d_spine=r(12, 0, 5), d_upperarm__R=r(-60, 10), d_forearm__R=r(-20), d_whip=r(40),
                            lantern=r(12)))
    brace = add(buck, P(d_spine=r(-14), d_upperarm__L=r(-60), d_upperarm__R=r(-60)))

    def combat(t):
        return keyed(t, [(0, rest), (0.15, whip_up), (0.25, whip_down), (0.35, whip_up), (0.45, whip_down),
                         (0.62, brace), (0.72, brace), (0.9, rest), (1, rest)])

    return m, {"Idle": idle, "Walk": walk, "Combat": combat}


def general():
    """Armoured general: studded banner-coloured armour, plumed spike helmet, four back flags, sabre."""
    m = Model("general")
    s = 1.12
    m.bone("root", (0, 0, 0), (0, 0, 0.25))
    j = humanoid(m, "", (0, 0, 0.9 * s), "root", s=s, torso="Nation", hem="Nation", sleeve="Indigo", cuff="Gold",
                 thigh="Indigo", shin="Hair")
    O = j["pelvis"]
    studs(m, "spine", O, s, (0.1, 0.17, 0.24, 0.31, 0.38), 18)
    m.add(xf(ring(0.19, 0.03, 0.36, 24, 0.02), T(scale=(1, TORSO_Y, 1))), "Gold", "spine", T(O, scale=(s, s, s)))
    # round mirror plate (hu xin jing) on the chest
    m.add(cyl(0.07, 0.065, 0.02, 24), "Gold", "spine", T(O + V(0, -0.14, 0.3) * s, rot=(90, 0, 0), scale=(s, s, s)))
    m.add(cyl(0.05, 0.05, 0.022, 24), "Iron", "spine", T(O + V(0, -0.141, 0.3) * s, rot=(90, 0, 0), scale=(s, s, s)))
    # pauldrons
    for sd, sx in (("L", 1), ("R", -1)):
        sh = j["shoulder." + sd]
        m.add(sphere(1, 18, 10), "Nation", "upperarm." + sd, T(sh + V(0.02 * sx, 0, 0.0), rot=(0, -25 * sx, 0), scale=V(0.1, 0.11, 0.07) * s))
        m.add(xf(ring(1.0, 0.1, 0, 18, 0.1), T(scale=(0.105, 0.115, 0.1))), "Gold", "upperarm." + sd,
              T(sh + V(0.02 * sx, 0, -0.01), rot=(0, -25 * sx, 0), scale=(s, s, s)))
    # armoured skirt: two side panels and a front apron, all studded
    for sx in (1, -1):
        pts = [(-0.11, 0.08), (0.11, 0.08), (0.14, -0.55), (-0.14, -0.55)]
        pan = T(O + V(0.19 * sx, 0, 0) * s, rot=(0, 0, 90), scale=(s, s, s)) @ T(rot=(-8 * sx, 0, 0))
        m.add(slab(pts, 0.03), "Nation", "hips", pan)
        m.add(slab([(-0.145, -0.5), (0.145, -0.5), (0.15, -0.57), (-0.15, -0.57)], 0.04), "Gold", "hips", pan)
        for zz in (-0.1, -0.25, -0.4):
            for xx in (-0.07, 0.0, 0.07):
                m.add(sphere(0.012, 8, 5), "Gold", "hips", pan @ T((xx * (1 - zz * 0.3), -0.02 * sx, zz)))
    m.add(slab([(-0.1, 0.05), (0.1, 0.05), (0.12, -0.3), (-0.12, -0.3)], 0.03), "Nation", "hips",
          T(O + V(0, -0.155, 0) * s, rot=(8, 0, 0), scale=(s, s, s)))
    m.add(slab([(-0.125, -0.27), (0.125, -0.27), (0.13, -0.32), (-0.13, -0.32)], 0.04), "Gold", "hips",
          T(O + V(0, -0.155, 0) * s, rot=(8, 0, 0), scale=(s, s, s)))
    m.add(xf(ring(0.19, 0.05, 0.1, 22, 0.02), T(scale=(1, 0.8, 1))), "Gold", "hips", T(O, scale=(s, s, s)))
    # face: moustache and beard
    hd = j["head"]
    for sx in (1, -1):
        m.add(tube(hd + V(0.012 * sx, -0.13, -0.035) * s, hd + V(0.075 * sx, -0.115, -0.08) * s, 0.013 * s, 0.004 * s, 8),
              "Hair", "head")
    m.add(tube(hd + V(0, -0.12, -0.085) * s, hd + V(0, -0.12, -0.2) * s, 0.03 * s, 0.006 * s, 10), "Hair", "head")
    qing_helmet(m, "head", hd + V(0, 0, 0.06) * s, s=s, spike=0.4, big=True)
    # four back flags (kao qi)
    m.bone("flags", O + V(0, 0.18, 0.4) * s, O + V(0, 0.18, 0.7) * s, "spine")
    m.add(box(0.2, 0.05, 0.16, 0.02), "Leather", "flags", T(O + V(0, 0.17, 0.36) * s))
    for i, (a, b) in enumerate(((-26, -8), (-10, 8), (10, -8), (26, 8))):
        base = O + V(0, 0.2, 0.3) * s
        tilt = T(base, rot=(0, a, 0)) @ T(rot=(b * 0.6 + 12, 0, 0))
        pole_top = tilt @ V(0, 0, 1.0)
        m.add(tube(base, pole_top, 0.012), "WoodDark", "flags")
        m.add(lathe([(0, 0), (0.03, 0.03), (0.0, 0.1)], 10), "Gold", "flags", T(pole_top) @ Matrix(tilt.to_3x3()).to_4x4())
        tri = [(0.0, -0.05), (0.26 * (1 if a > 0 else -1), -0.08), (0.0, -0.6)]
        brd = [(0.0, -0.03), (0.3 * (1 if a > 0 else -1), -0.065), (0.0, -0.63)]
        F = tilt @ T((0, 0, 1.0))
        m.add(wave(slab(tri, 0.016), 1, 2, 0.02, 9), "Nation", "flags", F)
        m.add(wave(slab(brd, 0.01), 1, 2, 0.02, 9), "Gold", "flags", F)
    # sabre (dao) in the right hand, blade pointing down
    h = j["hand.R"]
    m.bone("sword", h, h + V(0, 0, -0.15), "hand.R")
    m.add(tube(h + V(0, 0, 0.1), h + V(0, 0, -0.06), 0.018), "Leather", "sword")
    m.add(sphere(0.025, 10, 6), "Gold", "sword", T(h + V(0, 0, 0.11)))
    m.add(cyl(0.05, 0.05, 0.015, 16), "Gold", "sword", T(h + V(0, 0, -0.075)))
    blade = []
    for i in range(7):
        u = i / 6
        blade.append((0.01 - 0.028 * u * u, -0.09 - 0.72 * u))
    pts = [(x - 0.018, z) for x, z in blade] + [(x + 0.018 + 0.012 * (i / 6), z) for i, (x, z) in reversed(list(enumerate(blade)))]
    pts[len(blade) - 1] = (pts[len(blade) - 1][0] + 0.02, pts[len(blade) - 1][1] - 0.04)
    m.add(slab(pts, 0.01), "Iron", "sword", T(h, rot=(0, 0, 90)))
    m.build()

    base = P(upperarm__L=r(0, -32, 0), forearm__L=r(-10, 0, -95), hand__L=r(0), upperarm__R=r(-6), forearm__R=r(-12),
             sword=r(-8))

    def idle(t):
        w = 2 * math.pi * t
        return add(base, breathe("", t), {"head": r(-4 * pulse(t, 0.3, 0.7), 0, 18 * math.sin(w) * pulse(t, 0.05, 0.95)),
                                          "flags": r(2 * math.sin(w), 3 * math.sin(w + 1))})

    def walk(t):
        w = 2 * math.pi * t
        pose = humanoid_walk("", t, stride=24, knee=36, arms=0)
        for k in ("upperarm.L", "forearm.L", "upperarm.R", "forearm.R"):
            pose.pop(k)
        return add(pose, base, P(upperarm__R=r(-20, 0, 0), forearm__R=r(-70, 0, 0), sword=r(-120, 0, 0),
                                 flags=r(4 * math.sin(2 * w), 5 * math.sin(w))), {"spine": r(-2)})

    rest = idle(0)
    raise_ = add(P(upperarm__L=r(0, -32), forearm__L=r(-10, 0, -95)),
                 P(spine=r(-10, 0, -10), head=r(-10), upperarm__R=r(-160, 20), forearm__R=r(-20), sword=r(-160),
                   thigh__L=r(-20), shin__L=r(20), thigh__R=r(10), flags=r(-6)))
    point = add(P(upperarm__L=r(-10, -20), forearm__L=r(-20)),
                P(spine=r(12, 0, 15), hips=r(0, 0, 10), head=r(-5, 0, -10), upperarm__R=r(-95, 0, 10),
                  forearm__R=r(-5), sword=r(-90), thigh__L=r(-35), shin__L=r(30), thigh__R=r(20), shin__R=r(10), flags=r(6)))
    slash = add(point, P(spine=r(8, 0, -30), upperarm__R=r(-60, 40, -30), sword=r(-80, 0, 40)))

    def combat(t):
        return keyed(t, [(0, rest), (0.2, raise_), (0.32, raise_), (0.42, point), (0.55, point), (0.65, slash),
                         (0.72, point), (0.9, rest), (1, rest)])

    return m, {"Idle": idle, "Walk": walk, "Combat": combat}


UNITS = {"infantry": infantry, "cavalry": cavalry, "artillery": artillery, "supply": supply, "general": general}


# ---------------------------------------------------------------------------------------------
# Export and preview
# ---------------------------------------------------------------------------------------------

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = FPS
    make_materials()


def preview(name, ao, mesh, frames):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x = sc.render.resolution_y = 420
    sc.render.film_transparent = True
    sc.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    world.color = (0.45, 0.43, 0.4)
    sc.world = world
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = Euler((math.radians(40), 0, math.radians(-30)))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "ORTHO"
    sc.collection.objects.link(cam)
    sc.camera = cam
    bb = [mesh.matrix_world @ V(c) for c in mesh.bound_box]
    lo = V(min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb))
    hi = V(max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb))
    ctr = (lo + hi) / 2
    size = max((hi - lo).length * 0.85, 2.6)
    cam.data.ortho_scale = size
    d = V(0.75, -1.0, 0.8).normalized()
    cam.location = ctr + d * 10
    cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    nation = MATS["Nation"].node_tree.nodes["Principled BSDF"].inputs["Base Color"]
    colors = ["#a8362a", "#2f4f7a", "#3f6146", "#6d3b62", "#c89a2a", "#a8362a"]
    out = []
    for i, (action, t) in enumerate(frames):
        nation.default_value = srgb(colors[i % len(colors)])
        ao.animation_data.action = bpy.data.actions[action]
        sc.frame_set(int(round(t * LENGTHS[action])))
        path = os.path.join(PREVIEW_DIR, f"{name}_{i}.png")
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        out.append(path)
    nation.default_value = srgb(PALETTE["Nation"][0])
    ao.animation_data.action = None


PREVIEW_FRAMES = [("Idle", 0.0), ("Walk", 0.25), ("Walk", 0.75), ("Combat", 0.25), ("Combat", 0.34), ("Combat", 0.62)]
if os.environ.get("KRIEG_FRAMES"):  # e.g. "Combat:0.6,Walk:0.5"
    PREVIEW_FRAMES = [(a, float(b)) for a, b in (x.split(":") for x in os.environ["KRIEG_FRAMES"].split(","))]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, fn in UNITS.items():
        if ONLY and name not in ONLY:
            continue
        reset()
        m, actions = fn()
        for act, f in actions.items():
            make_action(m.ao, act, f)
        tris = sum(len(p.vertices) - 2 for p in m.mesh.data.polygons)
        print(f"{name}: {len(m.bones)} bones, {tris} triangles")
        for o in bpy.context.scene.objects:
            o.select_set(True)
        bpy.ops.export_scene.gltf(filepath=os.path.join(OUT_DIR, name + ".glb"), export_format="GLB",
                                  export_animations=True, export_animation_mode="ACTIONS", export_extras=True,
                                  export_yup=True, export_apply=False)
        if PREVIEW_DIR:
            os.makedirs(PREVIEW_DIR, exist_ok=True)
            preview(name, m.ao, m.mesh, PREVIEW_FRAMES)


if __name__ == "__main__":  # also imported as a library by the other theme builds
    main()
