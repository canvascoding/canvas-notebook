# Rebuilding and replacing libvips in the Canvas Docker image

Stand: 2026-10-30

Canvas Docker releases do not distribute the prebuilt `@img/sharp-libvips-*`
archives. The release image builds libvips 8.18.7 as shared libraries from the
unmodified upstream source archive and builds all shipped sharp addons against
that shared installation.

## Source and build definition

- libvips source:
  `https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz`
- expected SHA-256:
  `5baaead3b0bb20ffdb9e9ff09aa9fda08620923df77b63b436654cb5e0b3bf94`
- complete Canvas build definition: the `libvips-build` stage in `Dockerfile`
- Debian build and runtime dependencies: the immutable snapshot identified in
  `docs/compliance/docker-native-distribution-policy.json`
- license: LGPL-2.1-or-later; the complete text is shipped in
  `docs/compliance/license-texts/LGPL-2.1-or-later.txt`

Tagged releases additionally publish the verified source archive and a native
compliance archive containing the Dockerfile, the per-platform runtime
inventories and linkage-test results.

The same Docker stage first builds Cairo 1.18.6 and librsvg 2.57.5 as shared
libraries. The latter contains the upstream CVE-2026-96889 fix; Debian Bookworm
librsvg 2.54.7 remains vulnerable. The exact source URLs and SHA-256 values
are recorded under `libvips.svgDependencies` in the native distribution policy.
A deterministic `librsvg-rust-source.tar.xz` also retains every Cargo.lock-pinned
Rust dependency source and its packaged license notices. These archives accompany the libvips source in the image and release
evidence. Rebuild these dependencies with the tagged Dockerfile before libvips,
and retain the `/usr/local/lib` linkage verified by the runtime test.

## Rebuild

Use a Debian Bookworm environment and the exact source archive above. The
authoritative flags are kept in the tagged Dockerfile. The essential build is:

```sh
tar -xJf vips-8.18.7.tar.xz
meson setup vips-8.18.7/build \
  --prefix=/usr/local \
  --libdir=lib \
  --buildtype=release \
  -Ddeprecated=false \
  -Dexamples=false \
  -Ddocs=false \
  -Dintrospection=disabled \
  -Dmodules=disabled
meson compile -C vips-8.18.7/build
meson install -C vips-8.18.7/build
```

Use the remaining explicit feature flags from the tagged Dockerfile so the
replacement retains the image formats Canvas enables. No private patch or
unpublished generator is required.

## Replace and verify

The sharp addons resolve `libvips-cpp.so` and `libvips.so` from `/usr/local/lib`
at runtime. They do not contain the prebuilt sharp-libvips aggregate.

1. Stop application traffic and retain a copy of the original
   `/usr/local/lib/libvips*.so*` files.
2. Replace them with ABI-compatible rebuilt shared libraries.
3. Run `ldconfig` as root.
4. Run the tagged `scripts/sharp-runtime-linkage-test.mjs` inside the image.
5. Restart Canvas and exercise an image upload and conversion before returning
   the instance to service.

The release CI performs the same linkage inspection and a real sharp PNG
conversion independently on linux/amd64 and linux/arm64. Canvas imposes no
contractual restriction on reverse engineering performed solely to debug or
replace these LGPL libraries.

The libraries are part of the immutable application image. A local replacement
therefore creates a derived operational image and must be preserved across
upgrades; the supported operational method is to maintain a small downstream
Dockerfile based on the exact Canvas release digest.
