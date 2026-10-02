# .aep test fixtures

These files come from the sample corpus of **py_aep** (MIT License, © 2023 Fortiche production,
https://github.com/forticheprod/py-aep); see `LICENSE-py_aep.txt` in this folder.

- `*.aep` — After Effects project files, copied unchanged from py_aep's `samples/` folder (same
  relative paths: `versions/ae20xx/complete.aep`, `models/<area>/<name>.aep`).
- `*.json` — the ground truth for each project, exported from After Effects itself by py_aep's
  ExtendScript exporter (`scripts/jsx/export_project_json.jsx`), **trimmed** by
  `packages/aep/scripts/make-fixtures.py` to the fields the `AeJsonProject` contract covers
  (Layer Styles' default children dropped) to keep the fixtures small. Values are unchanged.

Expected mask paths and text documents that After Effects' export doesn't include are baked into
`../aep.test.ts`; they were produced with py_aep (`../oracle/dump_py_aep.py`).

To regenerate: `python packages/aep/scripts/make-fixtures.py <path to py_aep>/samples`.
