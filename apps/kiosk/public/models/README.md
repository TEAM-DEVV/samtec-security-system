# The face models

The model files the kiosk loads, **served from this app's own origin** —
never a CDN, because a tampered model that always passes liveness would be
invisible, and the kiosk's content security policy (`connect-src 'self'`)
enforces that at runtime.

They are committed rather than installed: a build that downloads models is a
build that can be fed different ones. The exact bytes are pinned below —
anyone can re-download and compare. The Human files came from
`github.com/vladmandic/human-models`; `arcface-mbf.onnx` is InsightFace's
`w600k_mbf` recognition model (the `buffalo_s` pack, via
`huggingface.co/immich-app/buffalo_s`); the `ort-*` files are onnxruntime-web
1.30.0's WebAssembly runtime, byte-identical to the npm package this app
depends on.

| SHA-256 | File |
|---|---|
| `7fd698ae1cebabbcad79d3b8b448587b0365eb7911987418231bdcf36583112a` | antispoof.json |
| `4490fecb2becdb6869edc7e60f5e59962be013a8def8719b1373afb0f905c094` | antispoof.bin |
| `cd7bbfc078270572beb39f9e5ae67aadbd50b5e67cff37e6d4f6b3ea39312e5f` | blazeface.json |
| `dc9a97fdc50bc43216554bdd69aa3e7b9361a519ee7bdd996a2f69a98a6f9b72` | blazeface.bin |
| `b60ca26f404724f43bd2b1575761d8265180e1f053cc0731caa68462927309e7` | facemesh.json |
| `3826da640b0a3021161605369ee6af293f75d518040355b960ec71a3390c1c0b` | facemesh.bin |
| `9e51c8acf83b80abbf329b2735309ab5c90611c66905ade8b1bd130d473df9c8` | liveness.json |
| `fc6a6b6b3b9721bdb8bff67a457a15b7cbfd81715cfb27f3e65b757e81dd663e` | liveness.bin |
| `9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f` | arcface-mbf.onnx |
| `3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2` | ort-wasm-simd-threaded.wasm |
| `e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b` | ort-wasm-simd-threaded.mjs |

What each one does: `blazeface` finds the face, `facemesh` its shape and the
head's angle (the turn challenge and the ArcFace cut-out), `antispoof` and
`liveness` score whether it is a real, live face, and `arcface-mbf.onnx` makes
the 512 numbers the server matches (`arcface-mbf-1`), run by the `ort-*`
WebAssembly runtime. Human's own measurer (`faceres`) was removed on
2 October 2026 after a stranger's face scored above its match line at a real
kiosk; the threshold report, section 13, has the measurements. Emotion, iris,
body and hand models are deliberately not here: the kiosk does not use them,
and a kiosk should not hold what it does not use.
