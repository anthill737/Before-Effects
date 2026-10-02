/*
 * Before Effects — export an After Effects project for import.
 *
 * Run inside After Effects (any version from CC 2018): File › Scripts › Run Script File…, choose
 * this file. It saves "<project name>.beforeeffects.json" next to your .aep (or asks where to save
 * an unsaved project). In Before Effects choose "Open After Effects project…" and pick that file.
 *
 * Why use this instead of opening the .aep directly? Inside After Effects every value is read by
 * After Effects itself (text, masks, keyframes, effects, media paths), so the import is as
 * faithful as it can be. Opening the .aep directly works without After Effects but some details
 * may not be readable.
 *
 * Nothing in your project is changed. Plain ExtendScript (ES3): no JSON object, no Array.map.
 * The output follows After Effects' scripting object model (see packages/core/src/ae-json.ts).
 */
(function BeforeEffectsExport(thisObj) {
    var VERSION = "1";
    var notes = [];

    // ---- tiny JSON writer (ExtendScript has no JSON object in older versions) ----
    function q(s) {
        s = String(s);
        var out = "\"";
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i), code = s.charCodeAt(i);
            if (c === "\"") out += "\\\"";
            else if (c === "\\") out += "\\\\";
            else if (c === "\n") out += "\\n";
            else if (c === "\r") out += "\\r";
            else if (c === "\t") out += "\\t";
            else if (code < 32) out += "\\u" + ("0000" + code.toString(16)).slice(-4);
            else out += c;
        }
        return out + "\"";
    }
    function json(v) {
        if (v === null || v === undefined) return "null";
        var t = typeof v;
        if (t === "number") return isFinite(v) ? String(v) : "null";
        if (t === "boolean") return v ? "true" : "false";
        if (t === "string") return q(v);
        if (v instanceof Array) {
            var parts = [];
            for (var i = 0; i < v.length; i++) parts.push(json(v[i]));
            return "[" + parts.join(",") + "]";
        }
        var fields = [];
        for (var k in v) {
            if (!v.hasOwnProperty(k)) continue;
            if (v[k] === undefined) continue;
            fields.push(q(k) + ":" + json(v[k]));
        }
        return "{" + fields.join(",") + "}";
    }

    function get(obj, name) {
        try { return obj[name]; } catch (e) { return undefined; }
    }
    function arr(v) {
        if (v === undefined || v === null) return v;
        if (typeof v === "number") return v;
        var out = [];
        for (var i = 0; i < v.length; i++) out.push(v[i]);
        return out;
    }

    // ---- values ----
    function shapeJson(s) {
        var o = { closed: !!s.closed, vertices: [], inTangents: [], outTangents: [] };
        for (var i = 0; i < s.vertices.length; i++) {
            o.vertices.push(arr(s.vertices[i]));
            o.inTangents.push(arr(s.inTangents[i]));
            o.outTangents.push(arr(s.outTangents[i]));
        }
        return o;
    }
    function textJson(d) {
        var o = { text: String(get(d, "text") || "") };
        var keys = ["font", "fontFamily", "fontStyle", "fontSize", "applyFill", "applyStroke", "strokeWidth", "justification", "tracking", "leading", "fauxBold", "fauxItalic", "allCaps", "boxText"];
        for (var i = 0; i < keys.length; i++) {
            var v = get(d, keys[i]);
            if (v !== undefined && typeof v !== "function") o[keys[i]] = (typeof v === "object" && v !== null) ? String(v) : v;
        }
        if (get(d, "applyFill")) o.fillColor = arr(get(d, "fillColor"));
        if (get(d, "applyStroke")) o.strokeColor = arr(get(d, "strokeColor"));
        if (get(d, "boxText")) o.boxTextSize = arr(get(d, "boxTextSize"));
        return o;
    }
    function valueJson(p, v) {
        var vt = p.propertyValueType;
        if (vt === PropertyValueType.SHAPE) return shapeJson(v);
        if (vt === PropertyValueType.TEXT_DOCUMENT) return textJson(v);
        if (vt === PropertyValueType.NO_VALUE || vt === PropertyValueType.CUSTOM_VALUE || vt === PropertyValueType.MARKER) return undefined;
        return arr(v);
    }
    function easeJson(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) out.push({ speed: list[i].speed, influence: list[i].influence });
        return out;
    }

    // ---- properties ----
    function propJson(p) {
        var o = { matchName: p.matchName, name: p.name };
        var pt = p.propertyType;
        o.propertyType = pt === PropertyType.PROPERTY ? "Property" : pt === PropertyType.INDEXED_GROUP ? "IndexedGroup" : "NamedGroup";
        if (get(p, "canSetEnabled")) o.enabled = p.enabled;
        if (p.matchName === "ADBE Mask Atom") {
            o.maskMode = get(p, "maskMode");
            o.inverted = get(p, "inverted");
        }
        if (pt === PropertyType.PROPERTY) {
            o.propertyValueType = p.propertyValueType;
            if (p.propertyValueType !== PropertyValueType.NO_VALUE) {
                try { o.value = valueJson(p, p.value); } catch (e) { }
            }
            if (get(p, "isSeparationLeader")) o.dimensionsSeparated = !!get(p, "dimensionsSeparated");
            if (get(p, "isSeparationFollower")) o.isSeparationFollower = true;
            if (get(p, "canSetExpression") && p.expression) {
                o.expression = p.expression;
                o.expressionEnabled = p.expressionEnabled;
            }
            if (p.numKeys > 0 && p.propertyValueType !== PropertyValueType.MARKER) {
                var keys = [];
                for (var k = 1; k <= p.numKeys; k++) {
                    var kf = { time: p.keyTime(k) };
                    try { kf.value = valueJson(p, p.keyValue(k)); } catch (e1) { }
                    try {
                        kf.inInterpolationType = p.keyInInterpolationType(k);
                        kf.outInterpolationType = p.keyOutInterpolationType(k);
                    } catch (e2) { }
                    try {
                        kf.inTemporalEase = easeJson(p.keyInTemporalEase(k));
                        kf.outTemporalEase = easeJson(p.keyOutTemporalEase(k));
                        kf.temporalContinuous = p.keyTemporalContinuous(k);
                        kf.temporalAutoBezier = p.keyTemporalAutoBezier(k);
                    } catch (e3) { }
                    if (get(p, "isSpatial")) {
                        try {
                            kf.inSpatialTangent = arr(p.keyInSpatialTangent(k));
                            kf.outSpatialTangent = arr(p.keyOutSpatialTangent(k));
                            kf.spatialContinuous = p.keySpatialContinuous(k);
                            kf.spatialAutoBezier = p.keySpatialAutoBezier(k);
                            kf.roving = p.keyRoving(k);
                        } catch (e4) { }
                    }
                    keys.push(kf);
                }
                o.keyframes = keys;
            }
        } else {
            var kids = [];
            for (var i = 1; i <= p.numProperties; i++) {
                try { kids.push(propJson(p.property(i))); } catch (e5) { notes.push("A property under \"" + p.name + "\" couldn't be read."); }
            }
            o.properties = kids;
        }
        return o;
    }

    function markersJson(markerProp) {
        var out = [];
        if (!markerProp) return out;
        for (var i = 1; i <= markerProp.numKeys; i++) {
            var m = markerProp.keyValue(i);
            out.push({ time: markerProp.keyTime(i), duration: get(m, "duration"), comment: get(m, "comment"), label: get(m, "label") });
        }
        return out;
    }

    // ---- layers ----
    function layerJson(l) {
        var o = { index: l.index, name: l.name, matchName: l.matchName };
        o.layerType = l instanceof CameraLayer ? "CameraLayer" : l instanceof LightLayer ? "LightLayer" : l instanceof TextLayer ? "TextLayer" : l instanceof ShapeLayer ? "ShapeLayer" : l instanceof AVLayer ? "AVLayer" : "Layer";
        var src = get(l, "source");
        o.sourceId = src ? src.id : null;
        var keys = ["startTime", "inPoint", "outPoint", "stretch", "enabled", "solo", "locked", "shy", "audioEnabled", "blendingMode", "threeDLayer", "adjustmentLayer", "nullLayer", "guideLayer", "trackMatteType", "timeRemapEnabled", "motionBlur", "collapseTransformation", "frameBlending", "label", "comment", "lightType"];
        for (var i = 0; i < keys.length; i++) {
            var v = get(l, keys[i]);
            if (v !== undefined && typeof v !== "function" && typeof v !== "object") o[keys[i]] = v;
        }
        var parent = get(l, "parent");
        o.parentIndex = parent ? parent.index : null;
        var matte = get(l, "trackMatteLayer");
        if (matte) o.trackMatteLayerIndex = matte.index;
        try { o.markers = markersJson(l.property("ADBE Marker")); } catch (e) { }
        var props = [];
        for (var j = 1; j <= l.numProperties; j++) {
            var p = l.property(j);
            if (p.matchName === "ADBE Marker") continue;
            try { props.push(propJson(p)); } catch (e2) { notes.push("Some properties of layer \"" + l.name + "\" couldn't be read."); }
        }
        o.properties = props;
        return o;
    }

    // ---- items ----
    function itemJson(it) {
        var o = { id: it.id, name: it.name, comment: it.comment, label: it.label };
        if (it.parentFolder && it.parentFolder !== app.project.rootFolder) o.parentFolderId = it.parentFolder.id;
        if (it instanceof FolderItem) {
            o.itemType = "FolderItem";
        } else if (it instanceof CompItem) {
            o.itemType = "CompItem";
            var ck = ["width", "height", "frameRate", "frameDuration", "duration", "pixelAspect", "workAreaStart", "workAreaDuration", "displayStartTime", "motionBlur", "frameBlending", "renderer"];
            for (var i = 0; i < ck.length; i++) { var v = get(it, ck[i]); if (v !== undefined) o[ck[i]] = v; }
            o.bgColor = arr(it.bgColor);
            try { o.markers = markersJson(it.markerProperty); } catch (e) { }
            var layers = [];
            for (var j = 1; j <= it.numLayers; j++) {
                try { layers.push(layerJson(it.layer(j))); } catch (e2) { notes.push("Layer " + j + " of \"" + it.name + "\" couldn't be read."); }
            }
            o.layers = layers;
        } else if (it instanceof FootageItem) {
            o.itemType = "FootageItem";
            var fk = ["width", "height", "duration", "frameRate", "pixelAspect", "hasAudio", "hasVideo", "footageMissing"];
            for (var f = 0; f < fk.length; f++) { var fv = get(it, fk[f]); if (fv !== undefined) o[fk[f]] = fv; }
            var ms = it.mainSource;
            var s = { isStill: get(ms, "isStill"), hasAlpha: get(ms, "hasAlpha"), loop: get(ms, "loop") };
            if (ms instanceof SolidSource) { s.sourceType = "SolidSource"; s.color = arr(ms.color); }
            else if (ms instanceof FileSource) { s.sourceType = "FileSource"; s.file = ms.file ? ms.file.fsName : (get(ms, "missingFootagePath") || null); }
            else { s.sourceType = "PlaceholderSource"; }
            o.mainSource = s;
        }
        return o;
    }

    // ---- run ----
    if (!app.project) { alert("Open a project first."); return; }
    var items = [];
    var comps = 0, layerCount = 0;
    app.beginSuppressDialogs();
    try {
        for (var n = 1; n <= app.project.numItems; n++) {
            var it = app.project.item(n);
            var o = itemJson(it);
            items.push(o);
            if (o.itemType === "CompItem") { comps++; layerCount += o.layers.length; }
        }
    } finally {
        app.endSuppressDialogs(false);
    }
    var projectName = app.project.file ? app.project.file.name : "Untitled Project.aep";
    var data = { projectName: projectName, bitsPerChannel: app.project.bitsPerChannel, exporter: { name: "Before Effects exporter", version: VERSION, aeVersion: app.version }, notes: notes, items: items };

    var out;
    if (app.project.file) out = new File(app.project.file.parent.fsName + "/" + projectName.replace(/\.aepx?$/i, "") + ".beforeeffects.json");
    else out = File.saveDialog("Save the export for Before Effects", "Before Effects export:*.json");
    if (!out) return;
    out.encoding = "UTF-8";
    out.lineFeed = "Unix";
    if (!out.open("w")) { alert("Couldn't write " + out.fsName + ". Choose another folder."); return; }
    out.write(json(data));
    out.close();
    alert("Exported " + comps + " composition(s) and " + layerCount + " layer(s) to:\n" + out.fsName + "\n\nIn Before Effects, choose “Open After Effects project…” and pick this file." + (notes.length ? "\n\n" + notes.length + " item(s) couldn't be read; they're listed in the import report." : ""));
})(this);
