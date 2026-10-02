"""Dump mask/shape paths and text documents from a sample corpus with py_aep.

After Effects' own JSON exports mostly omit path and text values, so these are
checked against py_aep (MIT, (c) 2023 Fortiche production,
https://github.com/forticheprod/py-aep) instead. The output feeds
`packages/aep/test/compare.ts --oracle <file>`.

    python packages/aep/test/oracle/dump_py_aep.py <corpusDir> <out.json> [--keyframes]

With --keyframes it also dumps every numeric keyframe (time, value,
interpolation, temporal ease, spatial tangents) of every file, to check
keyframe semantics on far more keys than After Effects' exports contain.
"""

from __future__ import annotations

import json
import os
import sys
import warnings

import py_aep
from py_aep.enums import PropertyValueType
from py_aep.models.properties.property import Property
from py_aep.models.properties.property_group import PropertyGroup

warnings.simplefilter("ignore")


def shape(s):
    if s is None:
        return None
    return {
        "closed": bool(s.closed),
        "vertices": [list(map(float, v)) for v in s.vertices],
        "inTangents": [list(map(float, v)) for v in s.in_tangents],
        "outTangents": [list(map(float, v)) for v in s.out_tangents],
    }


def text(d):
    if d is None:
        return None
    out = {"text": d.text.replace("\n", "\r")}

    def put(key, fn):
        try:
            v = fn()
        except Exception:  # noqa: BLE001 - optional attribute
            return
        if v is not None:
            out[key] = v

    put("font", lambda: d.font)
    put("fontSize", lambda: d.font_size)
    put("applyFill", lambda: d.apply_fill)
    put("fillColor", lambda: list(d.fill_color) if d.fill_color is not None else None)
    put("applyStroke", lambda: d.apply_stroke)
    put("strokeColor", lambda: list(d.stroke_color) if d.stroke_color is not None else None)
    put("strokeWidth", lambda: d.stroke_width)
    put("justification", lambda: int(d.justification) if d.justification is not None else None)
    put("tracking", lambda: d.tracking)
    put("leading", lambda: d.leading)
    put("fauxBold", lambda: d.faux_bold)
    put("fauxItalic", lambda: d.faux_italic)
    put("allCaps", lambda: d.all_caps)
    put("boxText", lambda: d.box_text)
    put("boxTextSize", lambda: list(d.box_text_size) if d.box_text_size else None)
    return out


def num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, (list, tuple)) and all(isinstance(x, (int, float)) for x in v):
        return [float(x) for x in v]
    return None


def numeric_keys(p):
    keys = []
    for k in p.keyframes:
        value = num(k.value)
        if value is None:
            return None
        entry = {
            "time": k.time,
            "value": value,
            "inInterpolationType": int(k.in_interpolation_type),
            "outInterpolationType": int(k.out_interpolation_type),
            "inTemporalEase": [{"speed": e.speed, "influence": e.influence} for e in k.in_temporal_ease],
            "outTemporalEase": [{"speed": e.speed, "influence": e.influence} for e in k.out_temporal_ease],
        }
        tin, tout = k.in_spatial_tangent, k.out_spatial_tangent
        if tin is not None and tout is not None:
            entry["inSpatialTangent"] = [float(x) for x in tin]
            entry["outSpatialTangent"] = [float(x) for x in tout]
        keys.append(entry)
    return keys


KEYFRAMES = False


def walk(props, path, comp_id, layer_index, out):
    seen = {}
    for p in props:
        n = seen.get(p.match_name, 0) + 1
        seen[p.match_name] = n
        here = path + [f"{p.match_name}#{n}"]
        if isinstance(p, PropertyGroup):
            walk(p.properties, here, comp_id, layer_index, out)
            continue
        if not isinstance(p, Property):
            continue
        pvt = p.property_value_type
        if KEYFRAMES and p.keyframes and pvt not in (PropertyValueType.SHAPE, PropertyValueType.TEXT_DOCUMENT, PropertyValueType.MARKER):
            keys = numeric_keys(p)
            if keys:
                out.append({"comp": comp_id, "layer": layer_index, "path": here, "kind": "keys", "keyframes": keys})
            continue
        if pvt == PropertyValueType.SHAPE:
            kind, conv = "shape", shape
        elif pvt == PropertyValueType.TEXT_DOCUMENT:
            kind, conv = "text", text
        else:
            continue
        entry = {"comp": comp_id, "layer": layer_index, "path": here, "kind": kind}
        if p.keyframes:
            entry["keyframes"] = [conv(k.value) for k in p.keyframes]
        else:
            v = conv(p.value)
            if v is None:
                continue
            entry["value"] = v
        out.append(entry)


def main():
    global KEYFRAMES
    corpus, out_path = sys.argv[1], sys.argv[2]
    KEYFRAMES = "--keyframes" in sys.argv[3:]
    result = {}
    for root, _dirs, files in os.walk(corpus):
        for name in sorted(files):
            if not name.lower().endswith(".aep"):
                continue
            path = os.path.join(root, name)
            with open(path, "rb") as fh:
                data = fh.read()
            if not KEYFRAMES and b"om-s" not in data and b"btds" not in data:
                continue
            rel = os.path.relpath(path, corpus).replace(os.sep, "/")
            try:
                app = py_aep.parse(path)
            except Exception as e:  # noqa: BLE001
                print("py_aep failed:", rel, e, file=sys.stderr)
                continue
            entries = []
            for comp in app.project.compositions:
                for i, layer in enumerate(comp.layers, 1):
                    try:
                        walk(layer.properties, [], comp.id, i, entries)
                    except Exception as e:  # noqa: BLE001
                        print("walk failed:", rel, comp.name, i, e, file=sys.stderr)
            if entries:
                result[rel] = entries
                print(rel, len(entries), file=sys.stderr)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh)


if __name__ == "__main__":
    main()
