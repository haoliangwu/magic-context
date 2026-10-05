"""Show, for each cache commit between consecutive sampler.sh snapshots, which top-level
fields of core_state and meta changed. usage: diffsamples.py [samples dir]"""
import json, sys, glob
import os
files = sorted(glob.glob(os.path.join(sys.argv[1] if len(sys.argv) > 1 else "samples", "s*.json")))
prev = None
for f in files:
    s = json.load(open(f))
    rows = {r[0]: r for r in s["rows"]}
    pt = {r[0]: r[1:] for r in s["pass_trace"]}
    if prev:
        for sid, r in rows.items():
            p = prev[0].get(sid)
            if not p or p[1] == r[1]:
                continue
            changes = []
            for i, name in ((2, "core"), (3, "meta")):
                oa, ob = json.loads(p[i]), json.loads(r[i])
                for k in sorted(set(oa) | set(ob)):
                    va, vb = oa.get(k), ob.get(k)
                    if va != vb:
                        if isinstance(va, list) and isinstance(vb, list):
                            pre = 0
                            for x, y in zip(va, vb):
                                if x != y: break
                                pre += 1
                            changes.append(f"{name}.{k}[{len(va)}->{len(vb)} prefix={pre}]")
                        elif isinstance(va, dict) and isinstance(vb, dict):
                            changes.append(f"{name}.{k}{{{','.join(sorted(kk for kk in set(va)|set(vb) if va.get(kk)!=vb.get(kk)))}}}")
                        else:
                            changes.append(f"{name}.{k}")
            print(f"{f} {sid[:18]} rv {p[1]}->{r[1]} size {len(r[2])+len(r[3])} pt {pt.get(sid)} :: {' '.join(changes)}")
    prev = (rows, pt)
