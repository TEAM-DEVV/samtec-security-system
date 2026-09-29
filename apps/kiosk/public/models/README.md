# The face models

The five model files Human 3.3.6 loads, **served from this app's own origin**
— never a CDN, because a tampered model that always passes liveness would be
invisible, and the kiosk's content security policy (`connect-src 'self'`)
enforces that at runtime.

They are committed rather than installed: the `@vladmandic/human-models`
package was refused by this repository's supply-chain policy (a flagged
transitive dependency), and a build that downloads models is a build that can
be fed different ones. These exact bytes came from
`github.com/vladmandic/human-models` and are pinned below — anyone can
re-download and compare.

| SHA-256 | File |
|---|---|
| `7fd698ae1cebabbcad79d3b8b448587b0365eb7911987418231bdcf36583112a` | antispoof.json |
| `4490fecb2becdb6869edc7e60f5e59962be013a8def8719b1373afb0f905c094` | antispoof.bin |
| `cd7bbfc078270572beb39f9e5ae67aadbd50b5e67cff37e6d4f6b3ea39312e5f` | blazeface.json |
| `dc9a97fdc50bc43216554bdd69aa3e7b9361a519ee7bdd996a2f69a98a6f9b72` | blazeface.bin |
| `b60ca26f404724f43bd2b1575761d8265180e1f053cc0731caa68462927309e7` | facemesh.json |
| `3826da640b0a3021161605369ee6af293f75d518040355b960ec71a3390c1c0b` | facemesh.bin |
| `5b83d49c0385d2e68a05122441b94226313677cae9fcc40b9587ad50079eb4df` | faceres.json |
| `2c7d2d62b76c97528b736527aa09d310ea71743c9e3e79fb6c62d4b2d73af79b` | faceres.bin |
| `9e51c8acf83b80abbf329b2735309ab5c90611c66905ade8b1bd130d473df9c8` | liveness.json |
| `fc6a6b6b3b9721bdb8bff67a457a15b7cbfd81715cfb27f3e65b757e81dd663e` | liveness.bin |

What each one does: `blazeface` finds the face, `facemesh` its shape and the
head's angle (the turn challenge), `faceres` makes the 1,024 numbers the
server matches (`human-faceres-1`), `antispoof` and `liveness` score whether
it is a real, live face. Emotion, iris, body and hand models are deliberately
not here: the kiosk does not use them, and a kiosk should not hold what it
does not use.
