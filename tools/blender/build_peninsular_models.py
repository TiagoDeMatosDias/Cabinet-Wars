"""Builds the Peninsular War army miniatures (Spain and Portugal, c. 1801-1808) as animated glTF files.

Run with Blender 4.4 or later (tested with 5.2):

    blender -b --factory-startup --python tools/blender/build_peninsular_models.py -- [out_dir] [names...] [--preview dir]

The miniatures are deliberately low poly: few segments, flat shading, no textures. They reuse the
armature, posing and export machinery of build_army_models.py (same bone names, same three looping
actions Idle, Walk and Combat), and paint the coat of every figure with the material "Nation" so
it takes the owning nation's color. See themes/peninsular-war/models/README.md.
"""

import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_army_models as K  # noqa: E402
from build_army_models import (P, V, T, Model, add, aim, align, box, cyl, ik, keyed, lathe, pulse, r,  # noqa: E402
                               slab, sphere, tube, xf, breathe, humanoid_walk, horse_walk, horse_idle)

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
PREVIEW_DIR = None
if "--preview" in ARGV:
    i = ARGV.index("--preview")
    PREVIEW_DIR = os.path.abspath(ARGV[i + 1])
    del ARGV[i:i + 2]
OUT_DIR = os.path.abspath(ARGV[0] if ARGV else os.path.join(HERE, "../../themes/peninsular-war/models"))
ONLY = ARGV[1:]

# name: (sRGB hex, roughness, metallic, emission strength)
K.PALETTE = {
    "Nation": ("#b8322a", 0.7, 0.0, 0.0),
    "White": ("#e9e3d2", 0.85, 0.0, 0.0),
    "Black": ("#23201f", 0.6, 0.0, 0.0),
    "Skin": ("#d9a883", 0.7, 0.0, 0.0),
    "Hair": ("#3b2a1f", 0.8, 0.0, 0.0),
    "Leather": ("#6b4428", 0.75, 0.0, 0.0),
    "Blanket": ("#8c8a80", 0.9, 0.0, 0.0),
    "Wood": ("#8a5a34", 0.8, 0.0, 0.0),
    "WoodDark": ("#4d3322", 0.85, 0.0, 0.0),
    "Iron": ("#4b4f57", 0.45, 1.0, 0.0),
    "Steel": ("#aab0b8", 0.3, 1.0, 0.0),
    "Brass": ("#c29a47", 0.35, 1.0, 0.0),
    "Gold": ("#dbb24a", 0.3, 1.0, 0.0),
    "Red": ("#9e2620", 0.7, 0.0, 0.0),
    "Horse": ("#6e4226", 0.75, 0.0, 0.0),
    "HorseDark": ("#2a211c", 0.75, 0.0, 0.0),
    "Ox": ("#a9814f", 0.85, 0.0, 0.0),
    "Horn": ("#e4d8b8", 0.5, 0.0, 0.0),
    "Canvas": ("#d9ceb0", 0.9, 0.0, 0.0),
    "Flash": ("#ffb040", 0.5, 0.0, 8.0),
    "Smoke": ("#ddd8cc", 1.0, 0.0, 0.0),
}

SEG = 6  # segments of limbs and poles


def facet(m, bm, mat, bone, M=None):
    """Adds a flat-shaded part: the faceted look of the whole set."""
    m.add(bm, mat, bone, M, smooth=False)


def strap(a, b, w, t=0.014):
    """A flat band from a to b, its width lying across the direction of travel."""
    a, b = V(a), V(b)
    L = (b - a).length
    return xf(box(w, t, L), align(a, b) @ T((0, 0, L / 2)))


def ball(rad, seg=8, rings=5):
    return sphere(rad, seg, rings)


# ---------------------------------------------------------------------------------------------
# Figures. Joints and bone names match build_army_models.humanoid / quadruped, so the shared
# walk and breathing cycles apply unchanged.
# ---------------------------------------------------------------------------------------------

TORSO = [(0.15, 0.04), (0.17, 0.2), (0.19, 0.36), (0.175, 0.46), (0.09, 0.53), (0.0, 0.54)]
TORSO_Y = 0.74


def soldier(m, p, pelvis, parent, seated=False, s=1.0, coat="Nation", facing="White", legs="White", boots="Black",
            tails=0.36, boot_top=-0.36, plastron=None, buttons="Brass"):
    """A Napoleonic soldier: short-waisted coat with tails, breeches and gaiters or boots."""
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
    sp, hp = p + "spine", p + "hips"
    # coat body with a row of buttons (or a plastron) and a stand-up collar
    facet(m, xf(lathe(TORSO, 8), T(rot=(0, 0, 22.5), scale=(1, TORSO_Y, 1))), coat, sp, S)
    facet(m, xf(lathe([(0.0, -0.06), (0.2, -0.06), (0.18, 0.1), (0.0, 0.1)], 8), T(rot=(0, 0, 22.5), scale=(1, 0.8, 1))),
          coat, hp, S)
    if plastron:
        facet(m, box(0.2, 0.03, 0.3), plastron, sp, S @ T((0, -0.132, 0.3)))
    for z in (0.14, 0.24, 0.34, 0.44) if buttons else ():
        facet(m, box(0.03, 0.02, 0.03), buttons, sp, S @ T((0, -0.128 - 0.012 * (z > 0.3), z)))
    facet(m, lathe([(0.07, 0.49), (0.1, 0.49), (0.085, 0.58), (0.06, 0.58)], 8, closed=True), facing, sp, S)
    if tails:
        # the coat tails hang behind (+Y), with turnbacks showing the facing colour
        facet(m, slab([(-0.15, 0.06), (0.15, 0.06), (0.1, -tails), (0.0, -tails + 0.05), (-0.1, -tails)], 0.03), coat,
              hp, S @ T((0, 0.14, 0)))
        facet(m, slab([(-0.07, 0.0), (0.07, 0.0), (0.03, -tails + 0.08), (-0.03, -tails + 0.08)], 0.01), facing, hp,
              S @ T((0, 0.16, 0)))
    # head: a faceted ball, nose, and short hair at the back
    facet(m, tube(J(0, 0, 0.46), J(0, 0, 0.6), 0.055 * s, seg=SEG), "Skin", p + "head")
    facet(m, ball(0.12 * s, 8, 6), "Skin", p + "head", T(J(0, 0, 0.7), scale=(1, 1, 1.1)))
    facet(m, box(0.03, 0.05, 0.05), "Skin", p + "head", T(J(0, -0.12, 0.68), scale=(s, s, s)))
    facet(m, ball(0.115 * s, 8, 4), "Hair", p + "head", T(J(0, 0.03, 0.72), scale=(1.05, 1, 0.95)))
    # arms: coat sleeves with cuffs, simple block hands
    for sd in ("L", "R"):
        sh, el, wr = j["shoulder." + sd], j["elbow." + sd], j["wrist." + sd]
        facet(m, ball(0.07 * s, 6, 4), coat, p + "upperarm." + sd, T(sh))
        facet(m, tube(sh, el, 0.064 * s, 0.056 * s, SEG), coat, p + "upperarm." + sd)
        facet(m, tube(el, wr, 0.056 * s, 0.05 * s, SEG), coat, p + "forearm." + sd)
        d = (wr - el).normalized()
        facet(m, tube(wr - d * 0.07 * s, wr, 0.058 * s, 0.058 * s, SEG), facing, p + "forearm." + sd)
        facet(m, box(0.06, 0.08, 0.1), "Skin", p + "hand." + sd, T(j["hand." + sd], scale=(s, s, s)))
    # legs: breeches, then gaiters or riding boots up to boot_top
    for sd in ("L", "R"):
        hp_, kn, an = j["hip." + sd], j["knee." + sd], j["ankle." + sd]
        facet(m, tube(hp_, kn, 0.08 * s, 0.064 * s, SEG), legs, p + "thigh." + sd)
        facet(m, tube(kn, an, 0.062 * s, 0.05 * s, SEG), legs if boot_top < -0.5 else boots, p + "shin." + sd)
        if boot_top >= -0.42:
            facet(m, tube(kn + V(0, 0, 0.05 * s), kn - V(0, 0, 0.03 * s), 0.075 * s, 0.07 * s, SEG), boots,
                  p + "shin." + sd)
        facet(m, box(0.1, 0.22, 0.08), "Black", p + "shin." + sd, T(an + V(0, -0.045, -0.04) * s, scale=(s, s, s)))
    return j


def crossbelts(m, bone, O, s=1.0, mat="White", back=True):
    """White belts crossing on the chest (and back): cartridge box and bayonet/sabre belts."""
    for y in (-1, 1) if back else (-1,):
        yy = 0.148 * y
        facet(m, strap(O + V(0.13, yy, 0.46) * s, O + V(-0.15, yy * 0.95, 0.04) * s, 0.05 * s), mat, bone)
        facet(m, strap(O + V(-0.13, yy * 1.03, 0.46) * s, O + V(0.15, yy * 0.98, 0.04) * s, 0.05 * s), mat, bone)
    facet(m, box(0.05, 0.02, 0.06), "Brass", bone, T(O + V(0, -0.16, 0.25) * s, scale=(s, s, s)))


def shako(m, bone, top, s=1.0, plume="Red"):
    """Stovepipe shako with a peak, brass plate, cockade and a short plume."""
    S = T(top, scale=(s, s, s))
    facet(m, cyl(0.12, 0.135, 0.22, 8), "Black", bone, S @ T(rot=(0, 0, 22.5)))
    facet(m, slab([(-0.1, 0.0), (0.1, 0.0), (0.08, -0.07), (-0.08, -0.07)], 0.015), "Black", bone,
          S @ T((0, -0.1, 0.01), rot=(-80, 0, 0)))
    facet(m, slab([(-0.05, 0.0), (0.05, 0.0), (0.06, 0.08), (0.0, 0.11), (-0.06, 0.08)], 0.01), "Brass", bone,
          S @ T((0, -0.132, 0.06), rot=(0, 0, 0)) @ T(rot=(0, 0, 0)))
    facet(m, cyl(0.03, 0.03, 0.012, 8), "Red", bone, S @ T((0, -0.13, 0.19), rot=(90, 0, 0)))
    facet(m, cyl(0.03, 0.012, 0.16, 6), plume, bone, S @ T((0, -0.1, 0.21)))


def bicorne(m, bone, top, s=1.0, trim=None, plume=None):
    """Bicorne worn athwart ('en bataille'): a crescent across the head, cockade on the left."""
    S = T(top, scale=(s, s, s))
    arc = [(0.3 * math.cos(math.radians(a)), 0.02 + 0.2 * math.sin(math.radians(a)) ** 1.4) for a in range(0, 181, 20)]
    pts = [(x, z) for x, z in arc] + [(-0.26, -0.01), (0.0, 0.03), (0.26, -0.01)]
    facet(m, slab(pts, 0.1), "Black", bone, S @ T((0, 0, 0.0)))
    facet(m, cyl(0.12, 0.125, 0.07, 8), "Black", bone, S @ T((0, 0, -0.02)))
    facet(m, cyl(0.045, 0.045, 0.012, 8), "Red", bone, S @ T((0.12, -0.055, 0.1), rot=(90, 0, 0)))
    facet(m, box(0.02, 0.012, 0.1), "Gold", bone, S @ T((0.12, -0.062, 0.1)))
    if trim:
        for (x0, z0), (x1, z1) in zip(arc, arc[1:]):
            facet(m, tube((x0, 0, z0 + 0.01), (x1, 0, z1 + 0.01), 0.022, seg=5), trim, bone, S)
    if plume:
        facet(m, tube((0.12, 0, 0.12), (0.17, 0.02, 0.36), 0.035, 0.012, 5), plume, bone, S)


def musket(m, bone, parent, ax, bayonet=True):
    """Flintlock musket held upright at the right side in the rest pose; muzzle at ax + 1.62 z."""
    m.bone(bone, ax + V(0, 0, 0.81), ax + V(0, 0, 0.98), parent)
    facet(m, xf(cyl(0.06, 0.035, 0.46, 4), T(rot=(0, 0, 45), scale=(0.55, 1, 1))), "Wood", bone, T(ax + V(0, 0.01, 0.03)))
    facet(m, box(0.034, 0.044, 0.66), "Wood", bone, T(ax + V(0, 0, 0.8)))
    facet(m, tube(ax + V(0, -0.006, 0.5), ax + V(0, -0.006, 1.62), 0.016, seg=5), "Iron", bone)
    facet(m, box(0.02, 0.05, 0.07), "Iron", bone, T(ax + V(0.03, 0, 0.54)))
    facet(m, strap(ax + V(0, 0.03, 0.3), ax + V(0, 0.03, 1.1), 0.02, 0.01), "White", bone)
    if bayonet:
        facet(m, tube(ax + V(0.03, -0.006, 1.56), ax + V(0.03, -0.006, 1.98), 0.009, 0.002, 4), "Steel", bone)
    return ax + V(0, -0.006, 1.62)


def muzzle_flash(m, bone, at, direction, parent, size=1.0):
    at, d = V(at), V(direction).normalized()
    m.bone(bone, at, at + d * 0.1, parent)
    Q = align(at, at + d)
    S = T(scale=(size, size, size))
    facet(m, xf(lathe([(0.0, 0.0), (0.06, 0.03), (0.075, 0.1), (0.04, 0.25), (0.0, 0.34)], 6), S), "Flash", bone, Q)
    for (x, y, z, rad) in ((0.07, 0.05, 0.18, 0.08), (-0.08, -0.02, 0.22, 0.09), (0.0, 0.08, 0.3, 0.1)):
        facet(m, ball(rad * size, 6, 4), "Smoke", bone, Q @ T(V(x, y, z) * size))


def sabre(m, bone, parent, h, length=0.8, curve=0.05, guard="Brass"):
    """A slightly curved sabre in the hand at h, blade pointing down (-Z) in the rest pose."""
    m.bone(bone, h, h + V(0, 0, -0.15), parent)
    facet(m, tube(h + V(0, 0, 0.08), h + V(0, 0, -0.05), 0.016, seg=5), "Leather", bone)
    facet(m, box(0.02, 0.1, 0.02), guard, bone, T(h + V(0, 0, -0.06)))
    facet(m, strap(h + V(0, 0.045, -0.05), h + V(0, 0.045, 0.08), 0.015, 0.01), guard, bone)
    blade = [(curve * (i / 5) ** 2, -0.07 - length * i / 5) for i in range(6)]
    pts = [(x - 0.016, z) for x, z in blade] + [(blade[-1][0] + 0.004, blade[-1][1] - 0.05)] + \
          [(x + 0.016, z) for x, z in reversed(blade)]
    facet(m, slab(pts, 0.008), "Steel", bone, T(h, rot=(0, 0, 90)))


def wheel(r, w, spokes=8, rim="Wood", hub="WoodDark", tyre="Iron", seg=12):
    """A spoked wheel around the X axis, centred on the origin. Returns [(bm, material)]."""
    rot = T(rot=(0, 90, 0))
    out = [(xf(K.ring(r - 0.01, w, depth=0.06, seg=seg), rot), rim),
           (xf(K.ring(r, w * 1.05, depth=0.015, seg=seg), rot), tyre),
           (xf(cyl(0.08, 0.06, w * 2, 6), T((-w, 0, 0), rot=(0, 90, 0))), hub)]
    for i in range(spokes):
        a = 360 * i / spokes
        out.append((xf(xf(box(0.03, 0.035, r - 0.08), T((0, 0, (r + 0.02) / 2))), T(rot=(a, 0, 0))), rim))
    return out


def solid_wheel(r, w):
    """The Iberian ox cart's solid wheel: planks with two moon-shaped openings, fixed to the axle."""
    rot = T(rot=(0, 90, 0))
    out = [(xf(cyl(r, r, w, 12), T((-w / 2, 0, 0), rot=(0, 90, 0)) @ T(rot=(0, 0, 15))), "Wood"),
           (xf(K.ring(r + 0.01, w * 1.1, depth=0.02, seg=12), rot), "Iron"),
           (xf(box(w * 1.3, 0.1, r * 1.9), T()), "WoodDark"),
           (xf(cyl(0.09, 0.09, w * 1.8, 6), T((-w * 0.9, 0, 0), rot=(0, 90, 0))), "WoodDark")]
    return out


def quadruped(m, p, at, parent, s=1.0, kind="horse"):
    """Low-poly horse or ox with the bones of build_army_models.quadruped."""
    O = V(at)
    ox = kind == "ox"
    coat = "Ox" if ox else "Horse"
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

    body = p + "body"
    w = 0.33 if ox else 0.26
    facet(m, ball(1, 8, 6), coat, body, T(J(0, 0, 1.06), scale=V(w, 0.64, 0.31 if ox else 0.28) * s))
    facet(m, ball(1, 8, 5), coat, body, T(J(0, -0.4, 1.1), scale=V(w, 0.3, 0.32) * s))
    if ox:  # hump and dewlap
        facet(m, ball(1, 6, 4), coat, body, T(J(0, -0.38, 1.36), scale=V(0.2, 0.22, 0.12) * s))
        facet(m, slab([(0, 0), (0.3, 0.12), (0.34, -0.1), (0.05, -0.25)], 0.06), coat, p + "neck",
              T(J(0, -0.72, 1.0), rot=(0, 0, 90)) @ T(scale=(s, s, s)))
    # neck and head
    nk = p + "neck"
    if ox:
        facet(m, tube(J(0, -0.5, 1.1), J(0, -0.84, 1.3), 0.2 * s, 0.14 * s, 6), coat, nk)
    else:
        facet(m, tube(J(0, -0.45, 1.12), J(0, -0.8, 1.62), 0.15 * s, 0.09 * s, 6), coat, nk)
        facet(m, slab([(0, 0), (0.42, 0.45), (0.46, 0.35), (0.04, -0.1)], 0.05), dark, nk,
              T(J(0, -0.42, 1.28), rot=(0, 0, 90)) @ T(rot=(0, 0, 0)) @ T(scale=(s, s, s)) @ T(rot=(0, 0, 0)))
    hd = p + "head"
    if ox:
        facet(m, tube(J(0, -0.84, 1.35), J(0, -1.12, 1.12), 0.12 * s, 0.1 * s, 6), coat, hd)
        facet(m, ball(1, 6, 4), "Horn", hd, T(J(0, -1.14, 1.1), scale=V(0.1, 0.08, 0.08) * s))
        for sx in (1, -1):  # lyre-shaped horns
            a, b, c = J(0.08 * sx, -0.86, 1.46), J(0.3 * sx, -0.86, 1.56), J(0.34 * sx, -0.9, 1.78)
            facet(m, tube(a, b, 0.04 * s, 0.03 * s, 5), "Horn", hd)
            facet(m, tube(b, c, 0.03 * s, 0.008 * s, 5), "Horn", hd)
            facet(m, box(0.12, 0.03, 0.06), coat, hd, T(J(0.15 * sx, -0.9, 1.34), scale=(s, s, s)))
    else:
        facet(m, tube(J(0, -0.8, 1.64), J(0, -1.1, 1.38), 0.1 * s, 0.07 * s, 6), coat, hd)
        facet(m, ball(1, 6, 4), dark, hd, T(J(0, -1.11, 1.37), scale=V(0.075, 0.08, 0.075) * s))
        for sx in (1, -1):
            facet(m, tube(J(0.05 * sx, -0.76, 1.7), J(0.07 * sx, -0.73, 1.82), 0.03 * s, 0.004 * s, 4), coat, hd)
    # tail
    if ox:
        facet(m, tube(J(0, 0.62, 1.25), J(0, 0.7, 0.72), 0.025 * s, 0.02 * s, 4), coat, p + "tail")
        facet(m, ball(1, 5, 4), dark, p + "tail", T(J(0, 0.7, 0.68), scale=V(0.05, 0.05, 0.1) * s))
    else:
        facet(m, tube(J(0, 0.6, 1.22), J(0, 0.78, 0.7), 0.07 * s, 0.1 * s, 5), dark, p + "tail")
    # legs
    for n, (x, y) in legs.items():
        back = n[0] == "B"
        top, knee, foot = J(x, y, 0.98), J(x, y, 0.5), J(x, y, 0.08)
        facet(m, tube(top, knee, (0.14 if back else 0.12) * s * (1.15 if ox else 1), 0.06 * s, 5), coat, p + "leg." + n)
        facet(m, tube(knee, foot, 0.055 * s * (1.15 if ox else 1), 0.05 * s, 5), coat if ox or back else dark,
              p + "shank." + n)
        facet(m, cyl(0.065, 0.055, 0.09, 6), dark, p + "shank." + n, T(J(x, y - 0.01, 0.0), scale=(s, s, s)))
    return {"back": J(0, 0.0, 1.36), "withers": J(0, -0.4, 1.4)}


def fire_poses(prefix=""):
    """Musket drill shared by the infantry: present, fire, recoil, and ram the charge home."""
    def aiming(recoil=0.0, flash=0.0):
        back = V(0, recoil, recoil * 0.4)
        return add(P(hips=r(0, 0, -22), spine=r(4, 0, -26), head=r(6, 0, 40), thigh__L=r(-14, -6), shin__L=r(12),
                     thigh__R=r(10, 8), shin__R=r(4), flash={"s": flash}),
                   ik("upperarm.R", "forearm.R", V(-0.1, -0.14, 1.4) + back, None, (-0.6, 0.2, 0.9)),
                   aim("musket", V(0, -1, recoil * 0.6), None, 0.48),
                   ik("upperarm.L", "forearm.L", V(-0.09, -0.5, 1.36) + back, None, (0.5, -0.3, 0.8)))

    def reloading(ram):
        return add(P(spine=r(6, 0, -10), head=r(4, 0, 8), flash={"s": 0.0}),
                   ik("upperarm.R", "forearm.R", (-0.05, -0.36, 1.12), None, (-0.6, 0.2, 0.9)),
                   aim("musket", (0, -0.12, 1), None, 0.0),
                   ik("upperarm.L", "forearm.L", (0.0, -0.4, 1.62 + 0.14 * ram), None, (0.6, 0.2, 0.9)))

    return aiming, reloading


# ---------------------------------------------------------------------------------------------
# Units
# ---------------------------------------------------------------------------------------------

def infantry():
    """Line fusilier: shako, coat with white plastron and crossbelts, knapsack, musket and bayonet."""
    m = Model("infantry")
    m.bone("root", (0, 0, 0), (0, 0, 0.25))
    j = soldier(m, "", (0, 0, 0.9), "root", boot_top=-0.36)
    O = j["pelvis"]
    crossbelts(m, "spine", O)
    shako(m, "head", j["head"] + V(0, 0, 0.06))
    # knapsack with a rolled grey blanket, cartridge box on the right hip
    facet(m, box(0.3, 0.12, 0.3), "Leather", "spine", T(O + V(0, 0.2, 0.3)))
    facet(m, cyl(0.055, 0.055, 0.34, 6), "Blanket", "spine", T(O + V(-0.17, 0.2, 0.5), rot=(0, 90, 0)))
    facet(m, box(0.16, 0.08, 0.11), "Black", "hips", T(O + V(-0.12, 0.15, 0.04)))
    facet(m, box(0.05, 0.03, 0.2), "Black", "hips", T(O + V(0.16, 0.08, -0.06), rot=(0, 0, 8)))
    muzzle = musket(m, "musket", "hand.R", V(-0.268, -0.03, 0))
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
                "musket": r(75, -18, 0, slide=0.3), "flash": {"s": 0.0}}

    def walk(t):
        pose = humanoid_walk("", t)
        pose.pop("upperarm.R"), pose.pop("forearm.R")
        return add(pose, shoulder)

    aiming, reloading = fire_poses()
    ready, fire, kick = aiming(), aiming(0.05, 1.0), aiming(0.02)
    load0, load1 = reloading(0), reloading(1)
    # charge bayonets: musket levelled at the hip, lunge
    lunge = add(P(hips=r(0, 0, -20, l=(0, -0.08, -0.04)), spine=r(14, 0, -20), head=r(-6, 0, 20), thigh__L=r(-40),
                  shin__L=r(40), thigh__R=r(25), shin__R=r(10), flash={"s": 0.0}),
                ik("upperarm.R", "forearm.R", V(-0.14, 0.02, 1.0), None, (-0.6, 0.4, 0.9)),
                aim("musket", V(0, -1, 0.12), None, 0.3),
                ik("upperarm.L", "forearm.L", V(-0.12, -0.42, 1.08), None, (0.5, -0.3, 0.8)))
    idle0 = idle(0)

    def combat(t):
        return keyed(t, [(0, idle0), (0.12, ready), (0.24, ready), (0.27, fire), (0.33, kick), (0.45, load0),
                         (0.52, load1), (0.58, load0), (0.7, lunge), (0.78, lunge), (0.9, idle0), (1.0, idle0)])

    return m, {"Idle": idle, "Walk": walk, "Combat": combat}


def cavalry():
    """Dragoon: crested brass helmet, coat and shabraque in the nation's colour, drawn sabre."""
    m = Model("cavalry")
    m.bone("root", (0, 0, 0), (0, 0, 0.3))
    quadruped(m, "", (0, 0, 0), "root")
    # shabraque with a white border, saddle, stirrups, rolled cloak
    cloth = [(-0.34, 0.0), (0.4, 0.0), (0.4, -0.36), (-0.14, -0.42), (-0.34, -0.3)]
    for sx in (1, -1):
        for mat, grow, off in (("White", 0.035, 0.0), ("Nation", 0.0, 0.012)):
            pts = [(x + grow * (1 if x > 0 else -1), z - grow * (z < 0)) for x, z in cloth]
            facet(m, slab(pts, 0.02), mat, "body", T(((0.29 + off) * sx, 0.05, 1.34), rot=(0, 7 * sx, 90)))
    facet(m, box(0.6, 0.76, 0.03), "Nation", "body", T((0, 0.05, 1.35)))
    facet(m, box(0.3, 0.44, 0.08), "Leather", "body", T((0, 0.04, 1.38)))
    facet(m, cyl(0.07, 0.07, 0.5, 6), "Blanket", "body", T((-0.25, 0.3, 1.46), rot=(0, 90, 0)))
    for sx in (1, -1):
        facet(m, strap((0.2 * sx, 0.02, 1.36), (0.28 * sx, -0.14, 0.86), 0.02, 0.01), "Leather", "body")
        facet(m, box(0.05, 0.08, 0.02), "Iron", "body", T((0.28 * sx, -0.14, 0.84)))
    facet(m, strap((0.12, -0.9, 1.52), (0.16, -0.35, 1.5), 0.02, 0.01), "Leather", "body")
    j = soldier(m, "r_", (0, 0.06, 1.5), "body", seated=True, boots="Black", legs="White", tails=0.28, boot_top=-0.3)
    O = j["pelvis"]
    crossbelts(m, "r_spine", O, back=False)
    # dragoon helmet: brass skull, black turban, crest and horsehair mane
    top = j["head"] + V(0, 0, 0.05)
    facet(m, lathe([(0.0, 0.16), (0.1, 0.13), (0.135, 0.06), (0.14, 0.0), (0.0, 0.0)], 8), "Brass", "r_head", T(top))
    facet(m, K.ring(0.145, 0.06, 0.03, 8, 0.03), "Black", "r_head", T(top))
    facet(m, slab([(-0.09, 0.0), (0.09, 0.0), (0.07, -0.06), (-0.07, -0.06)], 0.012), "Black", "r_head",
          T(top + V(0, -0.13, 0.0), rot=(-80, 0, 0)))
    facet(m, slab([(-0.16, 0.14), (0.0, 0.2), (0.14, 0.2), (0.16, 0.12), (0.0, 0.14)], 0.04), "Brass", "r_head",
          T(top, rot=(0, 0, 90)))
    for a, b, rad in (((0, 0.14, 0.2), (0, 0.24, 0.02), 0.04), ((0, 0.24, 0.02), (0, 0.26, -0.24), 0.035)):
        facet(m, tube(top + V(*a), top + V(*b), rad, rad * 0.7, 5), "Black", "r_head")
    sabre(m, "r_sabre", "r_hand.R", j["hand.R"], length=0.82, curve=0.06)
    m.build()

    seat = P(r_upperarm__L=r(-35, 10), r_forearm__L=r(-40), r_upperarm__R=r(-30, -8), r_forearm__R=r(-60),
             r_sabre=r(-35))

    def idle(t):
        return add(horse_idle("", t), seat, breathe("r_", t), {"r_head": r(0, 0, -18 * pulse(t, 0.15, 0.6))})

    def walk(t):
        w = 2 * math.pi * t
        return add(horse_walk("", t), seat,
                   {"r_hips": r(3 * math.sin(2 * w), l=(0, 0, 0.015 * math.sin(2 * w - 0.8))),
                    "r_spine": r(-2 * math.sin(2 * w - 1))})

    rest = add(horse_idle("", 0), seat)
    raised = add(P(neck=r(-6), r_spine=r(-8, 0, 10), r_head=r(-6), r_upperarm__L=r(-35, 10), r_forearm__L=r(-40),
                   r_upperarm__R=r(-165, 25), r_forearm__R=r(-15), r_sabre=r(-150)))
    rear = add(P(body=r(-16, l=(0, 0, 0.06)), neck=r(-22), head=r(15), leg__FL=r(-55), shank__FL=r(75),
                 leg__FR=r(-40), shank__FR=r(85), leg__BL=r(14), leg__BR=r(16), tail=r(-15)), raised,
               P(r_spine=r(-6)))
    point = add(P(body=r(2), r_spine=r(18, 0, 8), r_head=r(-8), r_upperarm__L=r(-35, 10), r_forearm__L=r(-40),
                  r_upperarm__R=r(-95, 0, 8), r_forearm__R=r(-5), r_sabre=r(-90)), horse_walk("", 0.3, amp=30))
    slash = add(point, P(r_spine=r(10, 0, -30), r_upperarm__R=r(-60, 40, -30), r_sabre=r(-70, 0, 50)))

    def combat(t):
        return keyed(t, [(0, rest), (0.15, raised), (0.3, rear), (0.42, rear), (0.55, point), (0.62, point),
                         (0.7, slash), (0.78, point), (0.92, rest), (1, rest)])

    return m, {"Idle": idle, "Walk": walk, "Combat": combat}


def artillery():
    """Bronze field gun on a painted carriage, served by a gunner in a bicorne with a linstock."""
    m = Model("artillery")
    m.bone("root", (0, 0, 0), (0, 0, 0.25))
    m.bone("carriage", (0, 0, 0.5), (0, 0.4, 0.5), "root")
    m.bone("barrel", (0, 0.05, 0.9), (0, -0.25, 0.9), "carriage")
    for sd, sx in (("L", 1), ("R", -1)):
        m.bone("wheel." + sd, (0.44 * sx, 0, 0.5), (0.6 * sx, 0, 0.5), "carriage")
        for bm, mat in wheel(0.5, 0.07, 8):
            facet(m, bm, mat, "wheel." + sd, T((0.44 * sx, 0, 0.5)))
    # carriage cheeks painted in the nation's colour, trail resting on the ground behind
    cheek = [(-0.5, 0.52), (-0.5, 0.82), (0.05, 0.86), (0.35, 0.76), (1.4, 0.16), (1.4, 0.0), (1.15, 0.0), (0.25, 0.5)]
    for sx in (1, -1):
        facet(m, slab(cheek, 0.07), "Nation", "carriage", T((0.17 * sx, 0, 0), rot=(0, 0, 90)))
        facet(m, box(0.075, 0.08, 0.05), "Iron", "carriage", T((0.17 * sx, 0.05, 0.86)))
    facet(m, box(1.02, 0.12, 0.1), "WoodDark", "carriage", T((0, 0, 0.5)))
    for y, z in ((-0.35, 0.64), (0.6, 0.4), (1.25, 0.1)):
        facet(m, box(0.34, 0.1, 0.08), "Nation", "carriage", T((0, y, z)))
    facet(m, box(0.24, 0.3, 0.14), "WoodDark", "carriage", T((0, 0.72, 0.4), rot=(-30, 0, 0)))  # ammunition chest
    # bronze barrel: breech at +Y, muzzle at -Y
    B = T((0, 0.62, 0.9), rot=(90, 0, 0))
    prof = [(0.0, -0.12), (0.04, -0.11), (0.035, -0.07), (0.13, -0.03), (0.16, 0.0), (0.16, 0.14), (0.14, 0.16),
            (0.13, 0.72), (0.145, 0.74), (0.12, 0.76), (0.1, 1.38), (0.13, 1.44), (0.13, 1.56), (0.06, 1.56),
            (0.0, 1.4)]
    facet(m, lathe(prof, 8), "Brass", "barrel", B)
    facet(m, tube((-0.23, 0.07, 0.9), (0.23, 0.07, 0.9), 0.045, seg=6), "Brass", "barrel")
    for sx in (1, -1):  # dolphins
        facet(m, tube((0.05 * sx, 0.2, 1.04), (0.05 * sx, -0.05, 1.06), 0.02, 0.016, 4), "Brass", "barrel")
    muzzle_flash(m, "flash", (0, -0.95, 0.9), (0, -1, 0), "barrel", size=2.4)
    # rammer and a pyramid of shot
    facet(m, tube((-0.3, -0.3, 0.05), (-0.36, 1.2, 0.05), 0.018, seg=5), "Wood", "root")
    facet(m, cyl(0.06, 0.06, 0.1, 6), "Blanket", "root", T((-0.36, -0.36, 0.05), rot=(90, 0, 0)))
    for (x, y, z) in ((0.5, 0.75, 0.06), (0.62, 0.75, 0.06), (0.56, 0.86, 0.06), (0.56, 0.79, 0.16)):
        facet(m, ball(0.065, 6, 4), "Iron", "root", T((x, y, z)))
    # gunner in a bicorne
    j = soldier(m, "g_", (-0.85, 0.3, 0.9), "root", boot_top=-0.36)
    crossbelts(m, "g_spine", j["pelvis"])
    bicorne(m, "g_head", j["head"] + V(0, 0, 0.1))
    ax = j["hand.R"] + V(-0.015, -0.02, 0)
    m.bone("g_linstock", ax, ax + V(0, 0, 0.2), "g_hand.R")
    facet(m, tube(ax + V(0, 0, -0.45), ax + V(0, 0, 0.62), 0.016, seg=5), "Wood", "g_linstock")
    facet(m, tube(ax + V(0, 0, 0.62), ax + V(0.04, 0, 0.72), 0.008, seg=4), "Iron", "g_linstock")
    facet(m, tube(ax + V(0, 0, 0.62), ax + V(-0.04, 0, 0.72), 0.008, seg=4), "Iron", "g_linstock")
    facet(m, ball(0.022, 5, 3), "Flash", "g_linstock", T(ax + V(0.04, 0, 0.74)))
    m.build()

    def idle(t):
        return add(breathe("g_", t), {"g_head": r(0, 0, 20 * pulse(t, 0.2, 0.7)), "g_linstock": r(4),
                                      "g_upperarm.R": r(-4), "g_forearm.R": r(-8), "flash": {"s": 0.0}})

    def walk(t):
        w = 2 * math.pi * t
        pose = humanoid_walk("g_", t, stride=24)
        pose["g_upperarm.L"] = r(-55, -10)
        pose["g_forearm.L"] = r(-20)
        return add(pose, {"wheel.L": r(360 * t * 0.999), "wheel.R": r(360 * t * 0.999),
                          "carriage": r(1.2 * math.sin(2 * w), l=(0, 0, 0.012 * abs(math.sin(2 * w)))),
                          "g_upperarm.R": r(-8), "g_forearm.R": r(-8), "g_linstock": r(8), "flash": {"s": 0.0}})

    rest = idle(0)
    reach = add(P(g_hips=r(0, 0, 68, l=(0.12, 0.05, -0.04)), g_spine=r(22), g_head=r(-8), g_thigh__L=r(-30),
                  g_shin__L=r(30), g_thigh__R=r(15), g_upperarm__L=r(-20, -20)), {"flash": {"s": 0.0}},
                ik("g_upperarm.R", "g_forearm.R", (-0.5, 0.42, 1.34), None, (-1.0, 0.8, 0.9)),
                aim("g_linstock", (0.0, 0.5, 1.08), None, point=True, reach=0.74))
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
    """Iberian ox cart: solid wheels that turn with the axle, a canvas tilt over barrels and sacks,
    a yoke of oxen and a carter walking at their head with a goad."""
    m = Model("supply")
    m.bone("root", (0, 0, 0), (0, 0, 0.25))
    m.bone("cart", (0, 0.4, 0.6), (0, 0.8, 0.6), "root")
    R = 0.46
    m.bone("axle", (0.5, 0.45, R), (0.7, 0.45, R), "cart")
    for sx in (1, -1):
        for bm, mat in solid_wheel(R, 0.08):
            facet(m, bm, mat, "axle", T((0.52 * sx, 0.45, R)))
    facet(m, tube((-0.6, 0.45, R), (0.6, 0.45, R), 0.05, seg=6), "WoodDark", "axle")
    # bed painted in the nation's colour, stakes, and the tilt
    facet(m, box(0.9, 1.6, 0.08), "WoodDark", "cart", T((0, 0.45, 0.62)))
    for sx in (1, -1):
        facet(m, box(0.05, 1.6, 0.22), "Nation", "cart", T((0.45 * sx, 0.45, 0.76)))
        for y in (-0.25, 0.2, 0.65, 1.1):
            facet(m, box(0.04, 0.04, 0.34), "Wood", "cart", T((0.45 * sx, y, 0.82)))
    tilt = K.shell(0.46, 0.5, -0.1, 1.05, -90, 90, 0.02, 6)
    facet(m, tilt, "Canvas", "cart", T((0, 0, 0.9)))
    for y in (-0.1, 0.48, 1.05):
        facet(m, K.shell(0.47, 0.51, y - 0.02, y + 0.02, -92, 92, 0.02, 6), "Nation", "cart", T((0, 0, 0.9)))
    # cargo at the open back: a barrel and sacks
    facet(m, cyl(0.13, 0.13, 0.36, 8), "Wood", "cart", T((0.16, 1.18, 0.82), rot=(0, 90, 0)) @ T((0, 0, -0.18)))
    facet(m, ball(1, 6, 4), "Canvas", "cart", T((-0.18, 1.14, 0.8), scale=(0.17, 0.14, 0.12)))
    # pole and yoke
    facet(m, tube((0, -0.3, 0.62), (0, -1.95, 0.98), 0.04, 0.035, 5), "Wood", "cart")
    facet(m, box(1.3, 0.1, 0.1), "WoodDark", "cart", T((0, -1.95, 1.18)))
    for sx in (1, -1):
        facet(m, box(0.04, 0.04, 0.3), "Wood", "cart", T((0.36 * sx + 0.12, -1.95, 1.04)))
        facet(m, box(0.04, 0.04, 0.3), "Wood", "cart", T((0.36 * sx - 0.12, -1.95, 1.04)))
    # two oxen under the yoke
    for p, sx in (("a_", 1), ("b_", -1)):
        quadruped(m, p, (0.36 * sx, -1.45, 0), "root", s=0.82, kind="ox")
    # the carter, in a coat of the nation's colour and a broad-brimmed hat
    j = soldier(m, "d_", (0.95, -1.9, 0.86), "root", s=0.95, facing="Nation", legs="Leather", boots="Leather",
                tails=0.0, boot_top=-0.6)
    hat = j["head"] + V(0, 0, 0.07)
    facet(m, cyl(0.3, 0.3, 0.02, 10), "Black", "d_head", T(hat))
    facet(m, cyl(0.12, 0.11, 0.12, 8), "Black", "d_head", T(hat))
    hw = j["hand.R"]
    m.bone("d_goad", hw, hw + V(0, -0.15, 0.1), "d_hand.R")
    facet(m, tube(hw + V(0, 0.3, -0.35), hw + V(0, -0.5, 0.9), 0.014, 0.01, 4), "Wood", "d_goad")
    m.build()

    base = P(d_upperarm__R=r(-20, 8), d_forearm__R=r(-40), d_goad=r(0))

    def idle(t):
        w = 2 * math.pi * t
        return add(horse_idle("a_", t), horse_idle("b_", (t + 0.5) % 1), breathe("d_", t), base,
                   {"d_head": r(8 * pulse(t, 0.45, 0.8), 0, 16 * pulse(t, 0.05, 0.4)), "d_upperarm.L": r(2 * math.sin(w))})

    def walk(t):
        w = 2 * math.pi * t
        pose = humanoid_walk("d_", t, stride=24)
        pose.pop("d_upperarm.R"), pose.pop("d_forearm.R")
        return add(horse_walk("a_", t, amp=16), horse_walk("b_", (t + 0.5) % 1, amp=16), pose, base,
                   {"axle": r(360 * t * 0.999 * 0.62),
                    "cart": r(1.0 * math.sin(2 * w), 0, 0, l=(0, 0, 0.012 * abs(math.sin(2 * w))))})

    rest = idle(0)
    goad_up = add(base, P(d_spine=r(-6, 0, 20), d_upperarm__R=r(-150, 10), d_forearm__R=r(-20), d_goad=r(-20),
                          d_head=r(-6, 0, 20)))
    goad_down = add(base, P(d_spine=r(12, 0, 20), d_upperarm__R=r(-70, 20), d_forearm__R=r(-10), d_goad=r(30),
                            d_head=r(4, 0, 20)))
    toss = add(*({p + "neck": r(-20), p + "head": r(25), p + "body": r(-6)} for p in ("a_", "b_")), base,
               P(d_hips=r(0, 0, 0, l=(0.1, 0.05, 0)), d_spine=r(-14), d_upperarm__L=r(-60), d_upperarm__R=r(-60)))

    def combat(t):
        return keyed(t, [(0, rest), (0.15, goad_up), (0.25, goad_down), (0.35, goad_up), (0.45, goad_down),
                         (0.6, toss), (0.72, toss), (0.9, rest), (1, rest)])

    return m, {"Idle": idle, "Walk": walk, "Combat": combat}


def general():
    """General officer: plumed bicorne, gold epaulettes and collar, crimson sash, riding boots,
    a sabre in the right hand and a telescope in the left."""
    m = Model("general")
    s = 1.1
    m.bone("root", (0, 0, 0), (0, 0, 0.25))
    j = soldier(m, "", (0, 0, 0.9 * s), "root", s=s, facing="Red", legs="White", boots="Black", tails=0.5,
                boot_top=-0.3, plastron="Red", buttons="Gold")
    O = j["pelvis"]
    bicorne(m, "head", j["head"] + V(0, 0, 0.1 * s), s=1.15, trim="White", plume="White")
    for sd, sx in (("L", 1), ("R", -1)):  # epaulettes
        sh = j["shoulder." + sd]
        facet(m, xf(cyl(0.085, 0.1, 0.03, 8), T(scale=(1, 0.8, 1))), "Gold", "spine", T(sh + V(0, 0, 0.04)))
        for i in range(5):
            a = math.radians(-60 + 30 * i)
            facet(m, tube(sh + V(0.09 * math.sin(a) * sx + 0.04 * sx, 0.09 * math.cos(a), 0.04),
                          sh + V(0.1 * math.sin(a) * sx + 0.06 * sx, 0.1 * math.cos(a), -0.06), 0.012, seg=4),
                  "Gold", "spine")
    # sash with hanging tassels, and the aiguillette on the right shoulder
    facet(m, K.ring(0.2 * s, 0.07, 0.08 * s, 8, 0.02), "Red", "hips", T(O, scale=(1, 0.8, 1)))
    for dx in (-0.03, 0.03):
        facet(m, tube(O + V(0.17 + dx, -0.06, 0.06) * s, O + V(0.19 + dx, -0.08, -0.2) * s, 0.02, 0.03, 4), "Gold",
              "hips")
    facet(m, strap(O + V(-0.17, -0.12, 0.46) * s, O + V(-0.06, -0.16, 0.26) * s, 0.02, 0.01), "Gold", "spine")
    sabre(m, "sword", "hand.R", j["hand.R"], length=0.82, curve=0.03, guard="Gold")
    # telescope, held low in the left hand
    hl = j["hand.L"]
    m.bone("scope", hl, hl + V(0, -0.15, 0), "hand.L")
    facet(m, tube(hl + V(0, 0.12, 0), hl + V(0, -0.1, 0), 0.03, 0.03, 6), "Brass", "scope")
    facet(m, tube(hl + V(0, -0.1, 0), hl + V(0, -0.3, 0), 0.024, 0.024, 6), "Brass", "scope")
    facet(m, tube(hl + V(0, 0.12, 0), hl + V(0, 0.2, 0), 0.036, 0.036, 6), "Black", "scope")
    m.build()

    base = P(upperarm__L=r(-14, -6), forearm__L=r(-60), scope=r(0), upperarm__R=r(-6), forearm__R=r(-12), sword=r(-8))
    look = add(P(spine=r(-4), head=r(-8, 0, -10), scope=r(0, 0, 0)),
               ik("upperarm.L", "forearm.L", V(0.03, -0.32, 1.62) * 1.0 + V(0, 0, 0.12), None, (0.8, -0.2, 1.0)),
               aim("scope", V(-0.04, -1, 0.12), None, 0.0),
               P(upperarm__R=r(-6), forearm__R=r(-12), sword=r(-8)))

    def idle(t):
        rest = add(base, breathe("", t), {"head": r(0, 0, 14 * math.sin(2 * math.pi * t) * pulse(t, 0.05, 0.4))})
        return keyed(t, [(0, rest), (0.4, rest), (0.55, look), (0.8, look), (0.95, rest), (1, rest)])

    def walk(t):
        pose = humanoid_walk("", t, stride=24, knee=36, arms=0)
        for k in ("upperarm.L", "forearm.L", "upperarm.R", "forearm.R"):
            pose.pop(k)
        return add(pose, base, P(upperarm__R=r(-20, 0, 0), forearm__R=r(-70, 0, 0), sword=r(-120, 0, 0)),
                   {"spine": r(-2)})

    rest = add(base, breathe("", 0))
    raise_ = add(P(upperarm__L=r(-14, -6), forearm__L=r(-60)),
                 P(spine=r(-10, 0, -10), head=r(-10), upperarm__R=r(-160, 20), forearm__R=r(-20), sword=r(-160),
                   thigh__L=r(-20), shin__L=r(20), thigh__R=r(10)))
    point = add(P(upperarm__L=r(-10, -20), forearm__L=r(-20)),
                P(spine=r(12, 0, 15), hips=r(0, 0, 10), head=r(-5, 0, -10), upperarm__R=r(-95, 0, 10),
                  forearm__R=r(-5), sword=r(-90), thigh__L=r(-35), shin__L=r(30), thigh__R=r(20), shin__R=r(10)))
    slash = add(point, P(spine=r(8, 0, -30), upperarm__R=r(-60, 40, -30), sword=r(-80, 0, 40)))

    def combat(t):
        return keyed(t, [(0, rest), (0.2, raise_), (0.32, raise_), (0.42, point), (0.55, point), (0.65, slash),
                         (0.72, point), (0.9, rest), (1, rest)])

    return m, {"Idle": idle, "Walk": walk, "Combat": combat}


UNITS = {"infantry": infantry, "cavalry": cavalry, "artillery": artillery, "supply": supply, "general": general}


def main():
    import bpy
    os.makedirs(OUT_DIR, exist_ok=True)
    K.PREVIEW_DIR = PREVIEW_DIR
    for name, fn in UNITS.items():
        if ONLY and name not in ONLY:
            continue
        K.reset()
        m, actions = fn()
        for act, f in actions.items():
            K.make_action(m.ao, act, f)
        tris = sum(len(p.vertices) - 2 for p in m.mesh.data.polygons)
        print(f"{name}: {len(m.bones)} bones, {tris} triangles")
        for o in bpy.context.scene.objects:
            o.select_set(True)
        bpy.ops.export_scene.gltf(filepath=os.path.join(OUT_DIR, name + ".glb"), export_format="GLB",
                                  export_animations=True, export_animation_mode="ACTIONS", export_extras=True,
                                  export_yup=True, export_apply=False)
        if PREVIEW_DIR:
            os.makedirs(PREVIEW_DIR, exist_ok=True)
            K.preview(name, m.ao, m.mesh, K.PREVIEW_FRAMES)


if __name__ == "__main__":
    main()
