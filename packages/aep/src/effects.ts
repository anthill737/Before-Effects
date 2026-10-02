/**
 * Effect parameter definitions (`LIST:parT` > `pard`), the serialised form of the AE plug-in
 * SDK's PF_ParamDef. After Effects only stores an effect parameter's value when it differs from
 * the default, so the definitions supply the rest.
 *
 * File-format knowledge from py_aep (MIT, © 2023 Fortiche production, https://github.com/forticheprod/py-aep)
 * and aftereffects-aep-parser (MIT, © 2020 Boltframe).
 */

import { Bin } from "./bin.ts";
import { type Chunk, find, findList } from "./riff.ts";

/** PF_ParamType values. */
export const CT = {
  LAYER: 0,
  INTEGER: 1,
  SCALAR: 2,
  ANGLE: 3,
  BOOLEAN: 4,
  COLOR: 5,
  TWO_D: 6,
  ENUM: 7,
  PAINT_GROUP: 9,
  SLIDER: 10,
  CURVE: 11,
  MASK: 12,
  GROUP: 13,
  GROUP_END: 14,
  BUTTON: 15,
  THREE_D: 18,
} as const;

export interface ParamDef {
  readonly matchName: string;
  readonly name: string;
  readonly controlType: number;
  /** The parameter's value when the instance stores none (ExtendScript units; points still need the layer size). */
  readonly value?: number | number[];
  /** Points: value is in 0–512 "layer units" and needs scaling by the layer size. */
  readonly pointUnits?: boolean;
  readonly options?: readonly string[];
}

/** Values ExtendScript reports that the pard does not predict (from py_aep's override table). */
const PROPERTY_DEFAULTS: Readonly<Record<string, number>> = {
  "ADBE Lumetri-0130": 27,
  "ADBE Playgnd-0253": 0,
  "ADBE Playgnd-0501": 0,
  "/fm_quality": 1,
};

function readPard(bin: Bin, matchName: string, pard: Chunk, pdnm: string | undefined): ParamDef {
  const ct = bin.cu8(pard, 15);
  let name = bin.cstr(pard, 16, 32);
  let value: number | number[] | undefined;
  let pointUnits = false;
  let options: string[] | undefined;
  const has = (n: number) => bin.has(pard, n);
  switch (ct) {
    case CT.INTEGER: {
      const def = has(144) ? bin.cs32(pard, 140) : undefined;
      value = def;
      break;
    }
    case CT.SCALAR:
      value = has(144) ? bin.cs32(pard, 140) / 65536 : bin.cs32(pard, 56) / 65536;
      break;
    case CT.ANGLE:
      value = bin.cs32(pard, 56) / 65536;
      break;
    case CT.BOOLEAN:
      value = bin.cu8(pard, 60);
      break;
    case CT.COLOR: {
      const o = pard.start + 56;
      value = [bin.u8(o + 1) / 255, bin.u8(o + 2) / 255, bin.u8(o + 3) / 255, bin.u8(o) / 255];
      break;
    }
    case CT.TWO_D:
      value = [bin.cs32(pard, 56) / 128, bin.cs32(pard, 60) / 128];
      pointUnits = true;
      break;
    case CT.THREE_D:
      value = [bin.cf64(pard, 56) * 512, bin.cf64(pard, 64) * 512, bin.cf64(pard, 72) * 512];
      pointUnits = true;
      break;
    case CT.ENUM: {
      const last = bin.cu32(pard, 56);
      value = last !== 0 ? last : bin.cs32(pard, 64) + 1;
      break;
    }
    case CT.SLIDER:
      value = bin.cf64(pard, 56);
      break;
    case CT.LAYER:
    case CT.MASK:
      value = 0;
      break;
    default:
      value = undefined;
  }
  if (pdnm !== undefined) {
    if (ct === CT.ENUM) options = pdnm.split("|");
    else if (pdnm) name = pdnm;
  }
  const override = PROPERTY_DEFAULTS[matchName];
  if (override !== undefined && (value === undefined || ct === CT.INTEGER)) value = override;
  return { matchName, name, controlType: ct, ...(value !== undefined ? { value } : {}), ...(pointUnits ? { pointUnits } : {}), ...(options ? { options } : {}) };
}

/** Parameter definitions of an effect `sspc` (skipping the first, which describes the effect itself). */
export function readParamDefs(bin: Bin, sspc: Chunk): ParamDef[] {
  const parT = findList(sspc.children, "parT");
  if (!parT) return [];
  const out: ParamDef[] = [];
  const seen = new Set<string>();
  let current: { mn: string; pard?: Chunk; pdnm?: string } | null = null;
  let index = 0;
  const flush = () => {
    if (current && current.pard && !seen.has(current.mn)) {
      if (index > 0) out.push(readPard(bin, current.mn, current.pard, current.pdnm));
      seen.add(current.mn);
      index++;
    } else if (current && !current.pard && !seen.has(current.mn)) {
      seen.add(current.mn);
      index++;
    }
  };
  for (const c of parT.children) {
    if (c.type === "tdmn") {
      flush();
      current = { mn: bin.text(c) };
    } else if (current && c.type === "pard") current.pard = c;
    else if (current && c.type === "pdnm") current.pdnm = bin.text(find(c.children, "Utf8"));
  }
  flush();
  return out;
}

/** Project-level effect definitions (`LIST:EfdG`), used when a layer's own copy is empty. */
export function readEffectDefinitions(bin: Bin, root: readonly Chunk[]): Map<string, ParamDef[]> {
  const defs = new Map<string, ParamDef[]>();
  const efdg = findList(root, "EfdG");
  if (!efdg) return defs;
  for (const efdf of efdg.children) {
    if (efdf.type !== "LIST" || efdf.list !== "EfDf") continue;
    const mn = bin.text(find(efdf.children, "tdmn"));
    const sspc = findList(efdf.children, "sspc");
    if (mn && sspc) defs.set(mn, readParamDefs(bin, sspc));
  }
  return defs;
}
