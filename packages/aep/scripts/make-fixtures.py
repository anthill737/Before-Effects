"""Copy a subset of py_aep's sample corpus into packages/aep/test/fixtures.

The .aep files are copied unchanged. Their After Effects ground-truth JSON
(exported by ExtendScript, see py_aep's scripts/jsx/export_project_json.jsx) is
trimmed to the fields the reader's contract covers, and Layer Styles' default
children are dropped, to keep the fixtures small.

    python packages/aep/scripts/make-fixtures.py <py_aep samples dir>

Samples from py_aep (MIT, (c) 2023 Fortiche production, https://github.com/forticheprod/py-aep).
"""

from __future__ import annotations

import json
import os
import shutil
import sys

FIXTURES = [
    "versions/ae2018/complete",
    "versions/ae2022/complete",
    "versions/ae2023/complete",
    "versions/ae2024/complete",
    "versions/ae2025/complete",
    "versions/ae2026/complete",
    "models/layer/layer_timing",
    "models/layer/inPoint",
    "models/layer/outPoint_clamp",
    "models/layer/outPoint_no_clamp",
    "models/layer/trackMatteType",
    "models/layer/blendingMode",
    "models/layer/layer_switches",
    "models/layer/type",
    "models/layer/lightType",
    "models/layer/orientation_with_keyframes",
    "models/property/keyframe_BEZIER",
    "models/property/keyframe_HOLD",
    "models/property/keyframe_LINEAR",
    "models/property/keyframe_separated_dimensions",
    "models/property/keyframe_roving",
    "models/property/keyframe_temporal_auto_bezier",
    "models/property/keyframe_spatial_auto_bezier",
    "models/property/keyframe_bezier_ease_2D_position",
    "models/property/keyframe_misc",
    "models/property/expression",
    "models/property/effects",
    "models/property/2_gaussian",
    "models/property/mask",
    "models/property/mask_subtract",
    "models/property/shape_basic",
    "models/property/transform_separated",
    "models/property/property_scale",
    "models/composition/frameRate",
    "models/composition/workArea",
    "models/composition/displayStart",
    "models/composition/bgColor_custom",
    "models/composition/pixelAspect",
    "models/composition/dropFrame",
    "models/text/box_overflow",
    "models/text/text_ranges",
    "models/footage/footage_misc",
    "models/footage/conformFrameRate",
    "models/marker/comp_marker",
    "models/marker/layer_marker",
    "models/folder/folder",
]

ITEM = ["id", "name", "itemType", "parentFolderId", "label", "comment"]
FOOTAGE = ["width", "height", "duration", "frameRate", "pixelAspect", "hasAudio", "hasVideo", "footageMissing"]
SOURCE = ["sourceType", "color", "filePath", "isStill", "hasAlpha", "loop"]
COMP = ["width", "height", "frameRate", "frameDuration", "duration", "pixelAspect", "bgColor", "workAreaStart", "workAreaDuration", "displayStartTime", "motionBlur", "frameBlending", "renderer"]
MARKER = ["time", "duration", "comment", "label"]
LAYER = [
    "index", "name", "layerType", "matchName", "sourceId", "startTime", "inPoint", "outPoint", "stretch", "enabled",
    "solo", "locked", "shy", "audioEnabled", "blendingMode", "threeDLayer", "adjustmentLayer", "nullLayer", "guideLayer",
    "parentIndex", "trackMatteType", "timeRemapEnabled", "motionBlur", "collapseTransformation", "frameBlending", "label",
    "comment", "lightType",
]
PROP = ["matchName", "name", "propertyType", "propertyValueType", "value", "expression", "expressionEnabled", "maskMode", "inverted"]
KEY = [
    "time", "value", "inInterpolationType", "outInterpolationType", "inTemporalEase", "outTemporalEase", "inSpatialTangent",
    "outSpatialTangent", "spatialAutoBezier", "spatialContinuous", "roving", "temporalAutoBezier", "temporalContinuous",
]
SHAPE = ["closed", "vertices", "inTangents", "outTangents"]
TEXT = ["text", "font", "fontSize", "applyFill", "fillColor", "applyStroke", "strokeColor", "strokeWidth", "justification", "tracking", "leading", "fauxBold", "fauxItalic", "allCaps", "boxText", "boxTextSize"]


def pick(d, keys):
    return {k: d[k] for k in keys if k in d}


def prop(p, in_styles=False):
    out = pick(p, PROP)
    is_group = p.get("propertyType") == "PropertyGroup" or "properties" in p
    if is_group:
        out["enabled"] = p.get("enabled", True)
        children = p.get("properties", [])
        if in_styles or p.get("matchName") == "ADBE Layer Styles":
            children = []
        out["properties"] = [prop(c) for c in children]
        return out
    if p.get("matchName") == "ADBE Position" and "dimensionsSeparated" in p:
        out["dimensionsSeparated"] = p["dimensionsSeparated"]
    if p.get("isSeparationFollower"):
        out["isSeparationFollower"] = True
    if "shapeValue" in p:
        out["shapeValue"] = pick(p["shapeValue"], SHAPE)
    if "textDocument" in p:
        out["textDocument"] = pick(p["textDocument"], TEXT)
    if p.get("keyframes"):
        keys = []
        for k in p["keyframes"]:
            kk = pick(k, KEY)
            if p.get("propertyValueType") == 6420 and isinstance(k.get("value"), dict):
                kk["value"] = pick(k["value"], MARKER)
            elif isinstance(k.get("value"), dict):
                kk["value"] = pick(k["value"], SHAPE)
            keys.append(kk)
        out["keyframes"] = keys
    return out


def layer(L):
    out = pick(L, LAYER)
    out["properties"] = [prop(p) for p in L.get("properties", [])]
    return out


def item(it):
    out = pick(it, ITEM)
    if it.get("itemType") == "FootageItem":
        out.update(pick(it, FOOTAGE))
        if it.get("mainSource"):
            out["mainSource"] = pick(it["mainSource"], SOURCE)
    if it.get("itemType") == "CompItem":
        out.update(pick(it, COMP))
        out["markers"] = [pick(m, MARKER) for m in it.get("markers", [])]
        out["layers"] = [layer(L) for L in it.get("layers", [])]
    return out


def main():
    samples = sys.argv[1]
    dest = os.path.join(os.path.dirname(__file__), "..", "test", "fixtures")
    total = 0
    for rel in FIXTURES:
        src = os.path.join(samples, rel)
        os.makedirs(os.path.dirname(os.path.join(dest, rel)), exist_ok=True)
        shutil.copyfile(src + ".aep", os.path.join(dest, rel + ".aep"))
        total += os.path.getsize(src + ".aep")
        if os.path.exists(src + ".json"):
            with open(src + ".json", encoding="utf-8") as fh:
                gt = json.load(fh)
            trimmed = {"bitsPerChannel": gt.get("bitsPerChannel"), "items": [item(i) for i in gt["items"]]}
            out = os.path.join(dest, rel + ".json")
            with open(out, "w", encoding="utf-8", newline="\n") as fh:
                json.dump(trimmed, fh, separators=(",", ":"), ensure_ascii=False)
            total += os.path.getsize(out)
    print(f"{len(FIXTURES)} fixtures, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
