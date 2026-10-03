"""
Before Effects <-> Blender bridge (run inside Blender, in the background).

    blender -b --factory-startup -P be_blender.py -- build  <exchange.json>
    blender -b <file.blend>      -P be_blender.py -- render <exchange.json>

build:  makes a .blend from Before Effects' exchange file: the show camera (so the render lines up
        with the canvas exactly), the building as holdout obstacles owned by Before Effects (played
        back, never simulated), and the effect owned by Blender (smoke, fire, liquid or cloth) with
        its simulation domain. Paths in the .blend are relative, so the folder can move.
render: bakes the simulation and renders transparent PNG frames.

Progress goes to stdout as  BE_PROGRESS <stage> <done> <total>  and problems as  BE_ERROR <message>.
Coordinates: Before Effects (x right, y up, z toward the audience) -> Blender (x, -z, y).
"""
import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector


def say(*parts):
    print(" ".join(str(p) for p in parts), flush=True)


def to_blender(p):
    return (p[0], -p[2], p[1])


def make_mesh(name, mesh, uv=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([to_blender(v) for v in mesh["verts"]], [], [tuple(t) for t in mesh["tris"]])
    me.update()
    if uv and mesh.get("uvs"):
        layer = me.uv_layers.new(name="Photo")
        uvs = mesh["uvs"]
        for poly in me.polygons:
            for li in poly.loop_indices:
                u, v = uvs[me.loops[li].vertex_index]
                layer.data[li].uv = (u, 1.0 - v)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def set_engine(scene):
    for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = engine
            return engine
        except TypeError:
            continue
    scene.render.engine = "CYCLES"
    return "CYCLES"


def with_selected(objs, active, fn):
    view = bpy.context.view_layer
    for o in view.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    view.objects.active = active
    with bpy.context.temp_override(selected_objects=list(objs), selected_editable_objects=list(objs), active_object=active, object=active):
        return fn()


def make_domain(box, gas):
    me = bpy.data.meshes.new("BE Domain")
    v = [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1), (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    me.from_pydata(v, [], f)
    me.update()
    ob = bpy.data.objects.new("BE Domain", me)
    bpy.context.scene.collection.objects.link(ob)
    place_domain(ob, box)
    mod = ob.modifiers.new("Fluid", "FLUID")
    mod.fluid_type = "DOMAIN"
    mod.domain_settings.domain_type = "GAS" if gas else "LIQUID"
    return ob, mod.domain_settings


def volume_material(name, colour_rgb, fire):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type != "OUTPUT_MATERIAL":
            nt.nodes.remove(n)
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    vol = nt.nodes.new("ShaderNodeVolumePrincipled")
    vol.inputs["Color"].default_value = (*colour_rgb, 1)
    vol.inputs["Density"].default_value = 4.0 if fire else 20.0
    if fire:
        # Flames glow by how much is burning (the simulation's "flame" grid), dark red to yellow-white.
        # Driven directly rather than through blackbody temperature, which EEVEE barely shows.
        attr = nt.nodes.new("ShaderNodeAttribute")
        attr.attribute_name = "flame"
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        cr = ramp.color_ramp
        cr.elements[0].position, cr.elements[0].color = 0.0, (0, 0, 0, 1)
        cr.elements[1].position, cr.elements[1].color = 1.0, (1.0, 0.85, 0.5, 1)
        cr.elements.new(0.25).color = (0.8, 0.12, 0.01, 1)
        cr.elements.new(0.55).color = (1.0, 0.45, 0.05, 1)
        strength = nt.nodes.new("ShaderNodeMath")
        strength.operation = "MULTIPLY"
        strength.inputs[1].default_value = 25.0
        nt.links.new(attr.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], vol.inputs["Emission Color"])
        nt.links.new(attr.outputs["Fac"], strength.inputs[0])
        nt.links.new(strength.outputs["Value"], vol.inputs["Emission Strength"])
    else:
        # A little glow of its own so it reads on a dark house, where the projector is the only light.
        vol.inputs["Emission Color"].default_value = (*colour_rgb, 1)
        vol.inputs["Emission Strength"].default_value = 0.25
    nt.links.new(vol.outputs["Volume"], out.inputs["Volume"])
    return mat


def add_flow(ob, flow_type):
    mod = ob.modifiers.new("Fluid", "FLUID")
    mod.fluid_type = "FLOW"
    fs = mod.flow_settings
    fs.flow_type = flow_type
    fs.flow_behavior = "INFLOW"
    fs.flow_source = "MESH"
    ob.hide_render = True  # the source itself isn't drawn
    return fs


def fcurves(idblock):
    """The animation curves of a data-block (layered actions in Blender 4.4+, plain before)."""
    ad = idblock.animation_data
    action = ad.action if ad else None
    if not action:
        return []
    try:
        from bpy_extras import anim_utils

        bag = anim_utils.action_get_channelbag_for_slot(action, ad.action_slot)
        if bag:
            return list(bag.fcurves)
    except (ImportError, AttributeError):
        pass
    return list(getattr(action, "fcurves", []))


def flicker(fs, ob, frames, blob, contrast):
    """Emit through moving noise, so the source breaks into licks and puffs instead of its outline.
    `blob` is the noise's size in metres (the texture is mapped to the object's bounds)."""
    tex = bpy.data.textures.new("BE Flicker", "CLOUDS")
    tex.noise_scale = min(0.6, blob / max(0.05, max(ob.dimensions)))
    tex.noise_depth = 2
    tex.contrast = contrast
    fs.use_texture = True
    fs.noise_texture = tex
    fs.texture_map_type = "AUTO"
    fs.texture_size = 1.0
    fs.texture_offset = 0.0
    fs.keyframe_insert("texture_offset", frame=1)
    fs.texture_offset = frames / 30.0
    fs.keyframe_insert("texture_offset", frame=frames)
    for fc in fcurves(fs.id_data):
        if "texture_offset" in fc.data_path:
            for k in fc.keyframe_points:
                k.interpolation = "LINEAR"


def colour(params, key, default):
    value = params.get(key)
    if isinstance(value, str) and value.startswith("#") and len(value) == 7:
        return tuple(int(value[i : i + 2], 16) / 255 for i in (1, 3, 5))
    return default


def build(x):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0  # no .blend1 backups beside the file
    scene = bpy.context.scene
    scene.render.fps = int(round(x["fps"]))
    scene.frame_start = 1
    scene.frame_end = int(x["frames"])
    scene.render.resolution_x = int(x["render"]["width"])
    scene.render.resolution_y = int(x["render"]["height"])
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    engine = set_engine(scene)
    say("BE_INFO engine", engine)

    # The show camera.
    cam_data = bpy.data.cameras.new("BE Show Camera")
    cam_data.sensor_fit = "VERTICAL"
    cam_data.angle_y = math.radians(x["camera"]["fovYDegrees"])
    cam_data.clip_start = 0.05
    cam_data.clip_end = 500
    cam = bpy.data.objects.new("BE Show Camera", cam_data)
    scene.collection.objects.link(cam)
    eye = Vector(to_blender(x["camera"]["eye"]))
    target = Vector(to_blender(x["camera"]["target"]))
    cam.location = eye
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = (target - eye).to_track_quat("-Z", "Y")
    scene.camera = cam

    # Light: the sun from above in front, and a soft sky.
    sun = bpy.data.objects.new("BE Sun", bpy.data.lights.new("BE Sun", "SUN"))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-25))
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.new("BE World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.4, 0.45, 0.55, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
    scene.world = world

    kind = x["kind"]
    params = x.get("params", {})
    obstacles, emitters, cloth = [], [], None
    for o in x["objects"]:
        ob = make_mesh(o["name"], o["mesh"])
        ob["be_owner"] = o["owner"]
        ob["be_role"] = o["role"]
        if o["role"] in ("obstacle", "ground"):
            ob.is_holdout = True  # hides what's behind it, isn't drawn: the real house is there
            obstacles.append(ob)
            if o.get("motion"):
                # Played back from Before Effects (e.g. prepared physics): keyframes, never simulated here.
                ob.rotation_mode = "QUATERNION"
                for f, m in enumerate(o["motion"], start=1):
                    ob.location = to_blender(m[:3])
                    q = m[3:7]
                    ob.rotation_quaternion = (q[3], q[0], -q[2], q[1])
                    ob.keyframe_insert("location", frame=f)
                    ob.keyframe_insert("rotation_quaternion", frame=f)
        elif o["role"] == "emitter":
            emitters.append(ob)
        elif o["role"] == "cloth":
            cloth = ob

    cache = bpy.path.relpath(x["output"]["cache"]) if bpy.data.filepath else x["output"]["cache"]
    if kind in ("smoke", "fire"):
        domain, ds = make_domain(x["domain"], gas=True)
        ds.resolution_max = int(x["domain"]["resolution"])
        ds.cache_directory = x["output"]["cache"]
        ds.cache_type = "ALL"
        ds.cache_frame_start = 1
        ds.cache_frame_end = int(x["frames"])
        ds.vorticity = float(params.get("swirl", 0.5))
        ds.beta = 1.6  # heat makes it rise
        if kind == "fire":
            ds.flame_vorticity = 0.5
            ds.burning_rate = 0.5  # fuel lasts longer: taller flames
            ds.flame_smoke = 0.1  # dark smoke doesn't project (it's no light): keep a little
        # Smoke thins out as it rises instead of covering the house.
        ds.use_dissolve_smoke = True
        ds.dissolve_speed = int(params.get("linger", 25 if kind == "fire" else 80))
        smoke_rgb = colour(params, "color", (0.22, 0.2, 0.2) if kind == "fire" else (0.75, 0.75, 0.78))
        domain.data.materials.append(volume_material("BE Smoke", smoke_rgb, kind == "fire"))
        for e in emitters:
            fs = add_flow(e, "SMOKE" if kind == "smoke" else "BOTH")
            fs.smoke_color = smoke_rgb
            fs.density = float(params.get("density", 4.0))
            fs.temperature = 2.5
            fs.use_initial_velocity = True
            fs.velocity_coord = (0.0, -1.2, 0.8)  # billows out toward the audience, then rises
            if kind == "fire":
                fs.fuel_amount = float(params.get("fuel", 1.2))
            fs.surface_distance = 0.3  # emits from a shell around the area, so small areas still smoke
            if kind == "fire":
                flicker(fs, e, int(x["frames"]), 0.5, 1.8)
                # The fire catches and grows over the first second.
                fuel = fs.fuel_amount
                fs.fuel_amount = fuel * 0.15
                fs.keyframe_insert("fuel_amount", frame=1)
                fs.fuel_amount = fuel
                fs.keyframe_insert("fuel_amount", frame=min(int(x["frames"]), round(x["fps"])))
            else:
                flicker(fs, e, int(x["frames"]), 1.2, 1.0)
        for ob in obstacles:
            mod = ob.modifiers.new("Fluid", "FLUID")
            mod.fluid_type = "EFFECTOR"
            mod.effector_settings.effector_type = "COLLISION"
    elif kind == "liquid":
        domain, ds = make_domain(x["domain"], gas=False)
        ds.resolution_max = int(x["domain"]["resolution"])
        cell = max(domain.dimensions) / ds.resolution_max
        # Open toward the audience, the sides and the top: water runs off instead of piling up
        # against walls that aren't there. Closed below (the ground) and behind (the house).
        ds.use_collision_border_front = False
        ds.use_collision_border_left = False
        ds.use_collision_border_right = False
        ds.use_collision_border_top = False
        ds.cache_directory = x["output"]["cache"]
        ds.cache_type = "ALL"
        ds.cache_frame_start = 1
        ds.cache_frame_end = int(x["frames"])
        ds.use_mesh = True
        for e in emitters:
            fs = add_flow(e, "LIQUID")
            # The area's slab is thinner than one cell: treat it as a surface and fill a shell around it.
            fs.use_plane_init = True
            fs.surface_distance = 1.5 * cell
            fs.use_initial_velocity = True
            fs.velocity_coord = (0.0, -float(params.get("push", 1.5)), 0.0)  # out toward the audience
            # A burst: water pours for the first part, then falls and spreads.
            stop = max(2, round(int(x["frames"]) * float(params.get("pourFor", 0.25))))
            fs.use_inflow = True
            fs.keyframe_insert("use_inflow", frame=stop - 1)
            fs.use_inflow = False
            fs.keyframe_insert("use_inflow", frame=stop)
        for ob in obstacles:
            mod = ob.modifiers.new("Fluid", "FLUID")
            mod.fluid_type = "EFFECTOR"
            mod.effector_settings.effector_type = "COLLISION"
        water = bpy.data.materials.new("BE Water")
        water.use_nodes = True
        bsdf = water.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            # Opaque and a little self-lit: on a projected house there's nothing behind it to refract.
            rgb = colour(params, "color", (0.16, 0.42, 0.85))
            bsdf.inputs["Base Color"].default_value = (*rgb, 1)
            bsdf.inputs["Roughness"].default_value = 0.08
            bsdf.inputs["Coat Weight"].default_value = 1.0
            bsdf.inputs["Emission Color"].default_value = (*rgb, 1)
            bsdf.inputs["Emission Strength"].default_value = 0.35
        domain.data.materials.append(water)
    elif kind == "cloth":
        pin = next((o.get("pin") for o in x["objects"] if o["role"] == "cloth"), None)
        if pin:
            # The held edge follows a handle (keyframed by Before Effects); the rest is simulated.
            group = cloth.vertex_groups.new(name="BE Pin")
            group.add(list(pin["verts"]), 1.0, "REPLACE")
            handle = bpy.data.objects.new("BE Cloth Handle", None)
            scene.collection.objects.link(handle)
            for f, dx, dy, dz in pin["keys"]:
                handle.location = to_blender((dx, dy, dz))
                handle.keyframe_insert("location", frame=int(f))
            hook = cloth.modifiers.new("Hook", "HOOK")
            hook.object = handle
            hook.vertex_group = "BE Pin"
            hook.falloff_type = "NONE"
            # Letting go: the held vertices' pin weight drops to 0 at their release frame (the cloth
            # reads pin weights every frame), one weight-mix modifier per release frame.
            by_frame = {}
            for v, f in zip(pin["verts"], pin.get("release") or []):
                by_frame.setdefault(int(f), []).append(v)
            for f, vs in sorted(by_frame.items()):
                mask = cloth.vertex_groups.new(name=f"BE Release {f}")
                mask.add(vs, 1.0, "REPLACE")
                mix = cloth.modifiers.new(f"Release {f}", "VERTEX_WEIGHT_MIX")
                mix.vertex_group_a = "BE Pin"
                mix.mask_vertex_group = mask.name
                mix.default_weight_b = 0.0
                mix.mix_mode = "SET"
                mix.mix_set = "A"
                mix.mask_constant = 0.0
                mix.keyframe_insert("mask_constant", frame=max(1, f - 1))
                mix.mask_constant = 1.0
                mix.keyframe_insert("mask_constant", frame=f)
        mod = cloth.modifiers.new("Cloth", "CLOTH")
        if pin:
            mod.settings.vertex_group_mass = "BE Pin"
        mod.settings.quality = 8
        mod.settings.mass = 0.3
        mod.settings.air_damping = 0.5
        mod.collision_settings.use_self_collision = False
        mod.point_cache.frame_start = 1
        mod.point_cache.frame_end = int(x["frames"])
        for ob in obstacles:
            c = ob.modifiers.new("Collision", "COLLISION")
            c.settings.thickness_outer = 0.02
        sheet = bpy.data.materials.new("BE Sheet")
        sheet.use_nodes = True
        bsdf = sheet.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (*colour(params, "color", (0.92, 0.92, 0.9)), 1)
            bsdf.inputs["Roughness"].default_value = 0.8
        cloth.data.materials.append(sheet)
        sub = cloth.modifiers.new("Smooth", "SUBSURF")
        sub.levels = 1
        sub.render_levels = 1
        # Hook (moves the held edge), then cloth, then smoothing.
        bpy.context.view_layer.objects.active = cloth
        with bpy.context.temp_override(object=cloth, active_object=cloth):
            bpy.ops.object.modifier_move_to_index(modifier="Cloth", index=len(cloth.modifiers) - 2)
    else:
        raise ValueError(f"Unknown effect: {kind}")

    os.makedirs(os.path.dirname(x["output"]["blend"]), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=x["output"]["blend"])
    bpy.ops.file.make_paths_relative()
    bpy.ops.wm.save_mainfile()
    say("BE_DONE build", x["output"]["blend"])


def place_domain(domain, box):
    lo = Vector(to_blender(box["min"]))
    hi = Vector(to_blender(box["max"]))
    a = Vector((min(lo.x, hi.x), min(lo.y, hi.y), min(lo.z, hi.z)))
    b = Vector((max(lo.x, hi.x), max(lo.y, hi.y), max(lo.z, hi.z)))
    # The domain object made by the quick set-up is a 2 m cube centred on its origin.
    domain.location = (a + b) / 2
    domain.rotation_euler = (0, 0, 0)
    domain.scale = (b - a) / 2
    domain.is_holdout = False


def render(x):
    scene = bpy.context.scene
    frames = int(x["frames"])
    # A linked .blend keeps its own first frame; effects start at 1.
    first = scene.frame_start if x.get("linked") else 1
    scene.frame_start = first
    scene.frame_end = first + frames - 1
    if x.get("scale"):
        scene.render.resolution_percentage = max(10, min(100, round(float(x["scale"]) * 100)))
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    os.makedirs(x["output"]["frames"], exist_ok=True)
    scene.render.filepath = os.path.join(x["output"]["frames"], "f_####")

    # Bake what Blender simulates (fluids, cloth) before rendering.
    domains = [o for o in scene.objects if o.modifiers.get("Fluid") and o.modifiers["Fluid"].fluid_type == "DOMAIN"]
    for d in domains:
        ds = d.modifiers["Fluid"].domain_settings
        ds.cache_directory = x["output"]["cache"]
        ds.cache_frame_end = frames
        state = {"n": 0}

        def on_frame(sc, *_):
            state["n"] += 1
            say("BE_PROGRESS bake", min(state["n"], frames), frames)

        bpy.app.handlers.frame_change_post.append(on_frame)
        say("BE_PROGRESS bake", 0, frames)
        with_selected([d], d, lambda: bpy.ops.fluid.bake_all())
        bpy.app.handlers.frame_change_post.remove(on_frame)
    if any(m.type == "CLOTH" for o in scene.objects for m in o.modifiers):
        say("BE_PROGRESS bake", 0, frames)
        for o in scene.objects:
            for m in o.modifiers:
                if m.type == "CLOTH":
                    m.point_cache.frame_end = frames
        bpy.ops.ptcache.bake_all(bake=True)
        say("BE_PROGRESS bake", frames, frames)

    done = {"n": 0}

    def after(sc, *_):
        done["n"] += 1
        say("BE_PROGRESS render", done["n"], frames)

    bpy.app.handlers.render_post.append(after)
    say("BE_PROGRESS render", 0, frames)
    bpy.ops.render.render(animation=True)
    if first != 1:
        # Number the frames from 1 for the video.
        for i in range(frames):
            src = os.path.join(x["output"]["frames"], f"f_{first + i:04d}.png")
            if os.path.exists(src):
                os.replace(src, os.path.join(x["output"]["frames"], f"f_{1 + i:04d}.png"))
    say("BE_DONE render", x["output"]["frames"])


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(argv) < 2:
        say("BE_ERROR usage: -- build|render <exchange.json>")
        sys.exit(2)
    mode, path = argv[0], argv[1]
    with open(path, encoding="utf-8") as f:
        x = json.load(f)
    try:
        if mode == "build":
            build(x)
        elif mode == "render":
            render(x)
        else:
            raise ValueError(f"Unknown mode: {mode}")
    except Exception as e:  # report and fail
        say("BE_ERROR", str(e).replace("\n", " "))
        traceback.print_exc()
        sys.exit(1)


main()
