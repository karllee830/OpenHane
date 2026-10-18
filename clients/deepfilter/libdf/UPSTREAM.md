# libDF (DeepFilterNet) Subset

- Source: `libDF/` from <https://github.com/Rikorose/DeepFilterNet> at commit `d375b2d8309e0935d165700c91da9de862a99c31` (2024-10-17, the last upstream commit)
- License: MIT or Apache-2.0 (see LICENSE-MIT / LICENSE-APACHE in this directory), copyright Hendrik Schröter
- Upstream has been unmaintained since 2024, so it is vendored into this repository and maintained here instead of being fetched at build time

## What is included

Only the four files needed for inference: `src/lib.rs`, `src/tract.rs`, `src/transforms.rs` and `src/logging.rs`. Training datasets, command-line tools and the Python / C / wasm-bindgen interfaces are not included.
`Cargo.toml` was rewritten: it keeps only the dependencies used by the files above and declares the other features as empty (so the `cfg` attributes in the source stay valid).

## Changes to the source

| File | Change | Reason |
|---|---|---|
| `src/tract.rs` | `m.symbol_table.sym("S")` → `m.symbols.sym("S")` (3 places) | Upgrade to tract 0.21.7 (upstream pins 0.21.4; this field was renamed afterwards): 0.21.7 has WASM SIMD matrix multiplication kernels, making the web client twice as fast |
| `Cargo.toml` | ndarray 0.15 → 0.16 | tract 0.21.7 uses ndarray 0.16, and the types must match |

Otherwise it is byte-for-byte identical to upstream, which you can check with `diff`.
