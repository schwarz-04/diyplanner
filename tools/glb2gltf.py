"""Wandelt .glb in eingebettetes glTF (JSON) um, z. B. für Hosts, die keine .glb-Dateien ausliefern.

Aufruf: python tools/glb2gltf.py in.glb out.gltf.json
"""
import json, struct, base64, sys
b = open(sys.argv[1], 'rb').read()
assert b[:4] == b'glTF'
off = 12; js = None; bin_ = b''
while off < len(b):
    ln, typ = struct.unpack_from('<II', b, off); chunk = b[off+8:off+8+ln]; off += 8 + ln
    if typ == 0x4E4F534A: js = json.loads(chunk)
    elif typ == 0x004E4942: bin_ = chunk
if js.get('buffers'):
    js['buffers'][0]['uri'] = 'data:application/octet-stream;base64,' + base64.b64encode(bin_).decode()
json.dump(js, open(sys.argv[2], 'w'), separators=(',', ':'))
