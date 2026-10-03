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
from mathutils import Matrix, Vector


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
    obstacles, emitters, cloth, debris, backdrops = [], [], None, [], []
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
        elif o["role"] == "debris":
            debris.append((ob, o))
        elif o["role"] == "backdrop":
            backdrops.append(ob)

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
        ds.dissolve_speed = max(1, round(float(params.get("linger", 0.8 if kind == "fire" else 2.7)) * float(x["fps"])))
        smoke_rgb = colour(params, "color", (0.22, 0.2, 0.2) if kind == "fire" else (0.75, 0.75, 0.78))  # #383333 / #bfbfc7
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
            stop = max(2, min(int(x["frames"]), round(float(params.get("pourFor", 1.0)) * float(x["fps"]))))
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
    elif kind == "shatter":
        build_shatter(scene, x, params, obstacles, debris, backdrops)
    else:
        raise ValueError(f"Unknown effect: {kind}")

    os.makedirs(os.path.dirname(x["output"]["blend"]), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=x["output"]["blend"])
    bpy.ops.file.make_paths_relative()
    bpy.ops.wm.save_mainfile()
    say("BE_DONE build", x["output"]["blend"])


def photo_material(path):
    """The building photo on the pieces, partly self-lit so it reads like the projected picture."""
    mat = bpy.data.materials.new("BE Photo")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if path and os.path.exists(path):
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(path, check_existing=True)
        uv = nt.nodes.new("ShaderNodeUVMap")
        uv.uv_map = "Photo"
        nt.links.new(uv.outputs["UV"], tex.inputs["Vector"])
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    else:
        bsdf.inputs["Base Color"].default_value = (0.8, 0.8, 0.82, 1)
        bsdf.inputs["Emission Color"].default_value = (0.8, 0.8, 0.82, 1)
    bsdf.inputs["Emission Strength"].default_value = 0.6
    bsdf.inputs["Roughness"].default_value = 0.85
    return mat


def with_object(ob, fn):
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
        return fn()


def build_shatter(scene, x, params, obstacles, debris, backdrops):
    """Rigid-body pieces (Bullet): held in place, then each lets go at its frame with a push and spin
    (a short keyframed move hands Bullet the velocity), landing on the house and the ground."""
    frames = int(x["frames"])
    fps = float(x["fps"])
    with_object(obstacles[0] if obstacles else debris[0][0], lambda: bpy.ops.rigidbody.world_add())
    rbw = scene.rigidbody_world
    rbw.point_cache.frame_start = 1
    rbw.point_cache.frame_end = frames
    rbw.substeps_per_frame = 10
    rbw.solver_iterations = 20
    friction = float(params.get("friction", 0.7))
    bounce = float(params.get("bounce", 0.15))
    for ob in obstacles:
        with_object(ob, lambda: bpy.ops.rigidbody.object_add(type="PASSIVE"))
        ob.rigid_body.collision_shape = "MESH"
        ob.rigid_body.friction = friction
        ob.rigid_body.restitution = bounce
        if ob.animation_data:
            ob.rigid_body.kinematic = True  # played back from Before Effects
    mat = photo_material(x.get("photo"))
    dark = bpy.data.materials.new("BE Hole")
    dark.use_nodes = True
    dark.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0, 0, 0, 1)
    dark.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 1.0
    for ob in backdrops:
        ob.data.materials.append(dark)
    for ob, o in debris:
        # Turn about its own middle.
        me = ob.data
        c = sum((v.co for v in me.vertices), Vector()) / max(1, len(me.vertices))
        me.transform(Matrix.Translation(-c))
        ob.location = c
        me.materials.append(mat)
        with_object(ob, lambda: bpy.ops.rigidbody.object_add(type="ACTIVE"))
        rb = ob.rigid_body
        rb.collision_shape = "CONVEX_HULL"
        dims = ob.dimensions
        rb.mass = max(0.05, dims.x * dims.y * dims.z * 600)
        rb.friction = friction
        rb.restitution = bounce
        rb.collision_margin = 0.002
        rel = o.get("release") or {"frame": 1, "velocity": [0, 0, 0], "spin": [0, 0, 0]}
        f = max(3, int(rel["frame"]))
        v = Vector(to_blender(rel["velocity"]))
        w = Vector(to_blender(rel["spin"]))
        dt = 1.0 / fps
        # Held (animated) until its frame; the last two keyed frames move it at its push and spin,
        # so Bullet carries that motion on when it's let go.
        rb.kinematic = True
        rb.keyframe_insert("kinematic", frame=f)
        rb.kinematic = False
        rb.keyframe_insert("kinematic", frame=f + 1)
        start = ob.location.copy()
        ob.rotation_mode = "XYZ"
        for k, fr in ((0, 1), (0, f - 2), (1, f - 1), (2, f)):
            ob.location = start + v * (k * dt)
            ob.rotation_euler = (w.x * k * dt, w.y * k * dt, w.z * k * dt)
            ob.keyframe_insert("location", frame=fr)
            ob.keyframe_insert("rotation_euler", frame=fr)
        for fc in fcurves(ob):
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"


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
    if scene.camera is None:
        # A linked file whose camera isn't the active one: use its first camera.
        cams = [o for o in scene.objects if o.type == "CAMERA"]
        if not cams:
            raise ValueError("This Blender file has no camera to render from. Add one in Blender, or bring it in as editable 3D instead (no camera needed).")
        scene.camera = cams[0]
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
    if scene.rigidbody_world:
        say("BE_PROGRESS bake", 0, frames)
        scene.rigidbody_world.point_cache.frame_end = frames
        bpy.ops.ptcache.bake_all(bake=True)
        say("BE_PROGRESS bake", frames, frames)
    elif any(m.type == "CLOTH" for o in scene.objects for m in o.modifiers):
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


SIMULATIONS = {"FLUID": "fluid simulation", "CLOTH": "cloth simulation", "SOFT_BODY": "soft body", "DYNAMIC_PAINT": "dynamic paint", "OCEAN": "ocean"}


def classify(ob):
    """How one object comes across as editable data, honestly: editable, approximated,
    video-only (only in the rendered video) or skipped."""
    mods = [m.type for m in getattr(ob, "modifiers", [])]
    sims = [SIMULATIONS[m] for m in mods if m in SIMULATIONS]
    animated = bool(ob.animation_data and ob.animation_data.action)
    notes = []
    if animated:
        notes.append("animated (baked to keyframes)")
    if ob.type == "MESH":
        fluid = next((m for m in getattr(ob, "modifiers", []) if m.type == "FLUID"), None)
        if fluid and fluid.fluid_type == "DOMAIN":
            return "video-only", "a fluid/smoke domain: volumes and liquids can't be carried as editable data"
        if fluid:
            return "approximated", "comes across as a plain mesh; its role in the fluid simulation stays in the video"
        if sims:
            return "approximated", f"the shape comes across at rest; the {', '.join(sims)} motion stays in the video"
        if len(ob.particle_systems):
            notes.append("its particles stay in the video")
            return "approximated", "; ".join(notes)
        if ob.data.shape_keys:
            notes.append("shape keys")
        if any(m == "ARMATURE" for m in mods):
            notes.append("bones")
        if mods:
            notes.append("modifiers applied")
        shading = []
        for slot in ob.material_slots:
            m = slot.material
            if not m:
                continue
            nodes = [n.type for n in m.node_tree.nodes] if m.use_nodes and m.node_tree else []
            if nodes and "BSDF_PRINCIPLED" not in nodes:
                shading.append(m.name)
        if shading:
            notes.append("shading simplified to a standard material: " + ", ".join(shading))
            return "approximated", "; ".join(notes)
        return "editable", "; ".join(notes)
    if ob.type == "LIGHT":
        if ob.data.type == "AREA":
            return "skipped", "area lights can't be carried; use a point, spot or sun light"
        return "editable", "light (brightness converted to physical units)" + (", animated" if animated else "")
    if ob.type == "CAMERA":
        return "skipped", "kept in the file: the show camera is Before Effects' (it lines up with the building)"
    if ob.type in ("CURVE", "FONT", "SURFACE", "META", "CURVES"):
        return "approximated", "converted to a mesh"
    if ob.type == "VOLUME":
        return "video-only", "a volume"
    if ob.type == "EMPTY":
        return "editable", "a group: its transform and animation"
    if ob.type in ("GPENCIL", "GREASEPENCIL"):
        return "skipped", "Grease Pencil drawings"
    if ob.type == "ARMATURE":
        return "editable", "bones driving their meshes"
    return "skipped", f"a {ob.type.lower()} object"


def glb_summary(path):
    """What the exported file actually holds (read back from its JSON chunk)."""
    import struct

    with open(path, "rb") as f:
        data = f.read()
    length = struct.unpack_from("<I", data, 12)[0]
    j = json.loads(data[20 : 20 + length])
    lights = j.get("extensions", {}).get("KHR_lights_punctual", {}).get("lights", [])
    return {
        "nodes": [n.get("name", "") for n in j.get("nodes", [])],
        "meshes": len(j.get("meshes", [])),
        "materials": len(j.get("materials", [])),
        "animations": len(j.get("animations", [])),
        "lights": len(lights),
        "bytes": len(data),
    }


def export_model(x):
    """A linked .blend as editable data for Before Effects: a GLB (meshes, materials, lights, animation
    baked over the effect's frames, Y up, metres, toward the audience +Z) and a report per object."""
    scene = bpy.context.scene
    frames = int(x["frames"])
    first = scene.frame_start
    scene.frame_end = first + frames - 1
    out = x["output"]["model"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    report = []
    for ob in scene.objects:
        status, note = classify(ob)
        report.append({"name": ob.name, "type": ob.type, "status": status, "note": note})
    say("BE_PROGRESS export", 0, 1)
    # Only what carries over: a smoke domain, an area light or a camera mustn't arrive as stray boxes.
    keep = {r["name"] for r in report if r["status"] in ("editable", "approximated")}
    for ob in scene.objects:
        try:
            ob.select_set(ob.name in keep)
        except RuntimeError:
            pass  # hidden in the view layer: the exporter skips it anyway
    want = {
        "use_selection": True,
        "filepath": out,
        "export_format": "GLB",
        "export_apply": True,
        "export_animations": True,
        "export_force_sampling": True,
        "export_frame_range": True,
        "export_lights": True,
        "export_cameras": False,
        "export_yup": True,
    }
    # Only options this Blender's exporter has (names change between versions).
    have = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in have or k == "filepath"})
    summary = glb_summary(out)
    exported = set(summary["nodes"])
    for r in report:
        if r["status"] in ("editable", "approximated") and r["name"] not in exported:
            r["status"], r["note"] = "skipped", (r["note"] + "; " if r["note"] else "") + "the exporter left it out"
    with open(x["output"]["report"], "w", encoding="utf-8") as f:
        json.dump({"objects": report, "file": summary, "frames": frames, "fps": x["fps"], "firstFrame": first}, f, indent=1)
    say("BE_PROGRESS export", 1, 1)
    say("BE_DONE export", out)


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
        elif mode == "export":
            export_model(x)
        else:
            raise ValueError(f"Unknown mode: {mode}")
    except Exception as e:  # report and fail
        say("BE_ERROR", str(e).replace("\n", " "))
        traceback.print_exc()
        sys.exit(1)


main()
