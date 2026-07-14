# Changelog

## [0.4.0](https://github.com/yangxu52/rivmux/compare/v0.3.0...v0.4.0) (2026-07-14)

### Features

- remove wasm module runtime option ([7328f6e](https://github.com/yangxu52/rivmux/commit/7328f6e9c09a5de76c1c0421edc711eb0f3d5557))

### Bug Fixes

- infer video sample durations ([692bc22](https://github.com/yangxu52/rivmux/commit/692bc227ac1f249db5df4afb795ed97e961dfcf1))
- parse avc sps dimensions ([ba6cff8](https://github.com/yangxu52/rivmux/commit/ba6cff8cb82766b98c1c66ffdbcca48ac06cf212))
- reject reserved wasm runtime option ([7ea068a](https://github.com/yangxu52/rivmux/commit/7ea068ab35d408d61a32032379b46bf53b6f408f))
- use separate av source buffers ([b98df8c](https://github.com/yangxu52/rivmux/commit/b98df8c6ae49d07a532ad7a83e7f12852c557d30))
- emit asset for vite builds ([cc4489e](https://github.com/yangxu52/rivmux/commit/cc4489e25990d80d2a273abdb4f20cbc7defc55a))

### Miscellaneous Chores

- adjust style and script ([786af9f](https://github.com/yangxu52/rivmux/commit/786af9f267501f0f506006675aca1e97c6f7ed3f))
- update non-major dependencies ([b24fd81](https://github.com/yangxu52/rivmux/commit/b24fd81736c5c26a62a821531ea36e9421e813b0))

### Tests

- cover static fmp4 worker mse path ([c4117df](https://github.com/yangxu52/rivmux/commit/c4117df604568214bd47f2e5425c774f9f37938c))
- satisfy avc clippy layout ([7ca8bcb](https://github.com/yangxu52/rivmux/commit/7ca8bcb8b22b2d24706e396a05b17255344e37c5))

## [0.3.0](https://github.com/yangxu52/rivmux/compare/v0.2.0...v0.3.0) (2026-07-02)

### Bug Fixes

- lint config and enforce LF line endings ([a33351e](https://github.com/yangxu52/rivmux/commit/a33351edd6f0bf24debab3eb3ccf2056887fe5c1))
- require transmux core in runtime ([02142c3](https://github.com/yangxu52/rivmux/commit/02142c31c64699fa988034abe01ae4259b8cc472))

### Miscellaneous Chores

- add repository info to packages ([4e3cd95](https://github.com/yangxu52/rivmux/commit/4e3cd95d236a764787e05de333d5969bec13fde0))
- specify the build target to es2022 ([ec7cb0b](https://github.com/yangxu52/rivmux/commit/ec7cb0bbd9959aec9917fabcc5d7c3e59b74f6ac))
- update non-major dependencies ([36d93cd](https://github.com/yangxu52/rivmux/commit/36d93cd1e356c849fb7157f1a70ded41706f9423))

### Code Refactoring

- generalize mse mime requirements ([540bcff](https://github.com/yangxu52/rivmux/commit/540bcff4b05694ed6cb76556fa2de67597b49954))
- remove optional wasm host fallback ([1cf043c](https://github.com/yangxu52/rivmux/commit/1cf043c1ba2e3e82cf37acd8b22771bc415f0018))
- remove unimplemented runtime options ([5620832](https://github.com/yangxu52/rivmux/commit/562083214de1185e204571ac9393763a2344ed19))

### Tests

- clarify fixture ownership ([d7d49b2](https://github.com/yangxu52/rivmux/commit/d7d49b21deee11f5c6ac478245edb1f1e4db9157))
- isolate static media fixtures ([05561cc](https://github.com/yangxu52/rivmux/commit/05561cc46a8c6482814bdd540920a828532a6f28))

## [0.2.0](https://github.com/yangxu52/rivmux/compare/v0.1.0...v0.2.0) (2026-07-01)

### Features

- normalize transmux timestamps ([fdc5c35](https://github.com/yangxu52/rivmux/commit/fdc5c35f0872d98a0502e2622a8616eb317ccb14))

### Bug Fixes

- retry mse appends after quota cleanup ([5108a9d](https://github.com/yangxu52/rivmux/commit/5108a9d7cc0fa89e4bbcf89c1699c744fc805f4a))
- validate runtime capabilities and options ([ec8250e](https://github.com/yangxu52/rivmux/commit/ec8250eee0ddc895f0708dea144241f338dbd0b0))

### Documentation

- expand player usage docs ([2d66e9d](https://github.com/yangxu52/rivmux/commit/2d66e9dc2817431a73289621cbe91b3e53a23577))

### Miscellaneous Chores

- add playback playground ([1b7d6dc](https://github.com/yangxu52/rivmux/commit/1b7d6dc6ded61e6b48e08bcc9b471bc841360030))

### Code Refactoring

- narrow transmux core public surface ([3e60fce](https://github.com/yangxu52/rivmux/commit/3e60fcec46f400bbffb461ef23c824ce1320b439))
- standardize transmux core module names ([1039f3b](https://github.com/yangxu52/rivmux/commit/1039f3b670d9ae1187907bb39e43e603e2f00c9c))

### Tests

- cover published declaration resolution ([eb00860](https://github.com/yangxu52/rivmux/commit/eb00860a9bf415727b76cbf97325972a96f817fb))

## 0.1.0 (2026-06-29)

### Features

- add aac fmp4 mux path ([9bf2b64](https://github.com/yangxu52/rivmux/commit/9bf2b6475c33ccbf4165771fa56caa854b0b322d))
- add first release robustness coverage ([df7866e](https://github.com/yangxu52/rivmux/commit/df7866e4572efa96086392c3ddb352551235eadb))
- add flv parser core ([3bd5715](https://github.com/yangxu52/rivmux/commit/3bd5715b18160d6b0b0f7df050613b8e10a775ac))
- add fmp4 video writer ([9d20d55](https://github.com/yangxu52/rivmux/commit/9d20d55fdd74ec63164577ca4d4ec84e128e14bc))
- add live latency controls ([819d159](https://github.com/yangxu52/rivmux/commit/819d1599f14747776a3b7dc610e13aae88c57a4d))
- add wasm transmux host ([a1360ed](https://github.com/yangxu52/rivmux/commit/a1360ed7d14fcec22c4896eab8fb26889bda5eb2))
- append core fmp4 segments ([8b04bb3](https://github.com/yangxu52/rivmux/commit/8b04bb3d9f4f5fd91f56fcc34fa53a67055f3bb6))
- implement browser runtime proof ([2c4792d](https://github.com/yangxu52/rivmux/commit/2c4792d93d5b128d35e6cd9bd856e284c2541b85))
- implement worker loader lifecycle ([9c8ff32](https://github.com/yangxu52/rivmux/commit/9c8ff32d585e73ba7ee6f7176f22d57a42789e14))
- package default wasm assets ([8356f2e](https://github.com/yangxu52/rivmux/commit/8356f2ef499a2dcca75307be1f982fbcb34cf3e9))
- publish runtime worker package ([1d9fb40](https://github.com/yangxu52/rivmux/commit/1d9fb409740835a68b81ebe184ac4e255dcf74a8))
- scaffold runtime packages and crates ([d4d68d4](https://github.com/yangxu52/rivmux/commit/d4d68d4073368fd71a2c9e17c7045535b4e986f2))

### Miscellaneous Chores

- configure release version bump ([5a1768b](https://github.com/yangxu52/rivmux/commit/5a1768b2be6eab54e30755003c0ad25cad0662fb))
- configure workspace tooling ([00fa234](https://github.com/yangxu52/rivmux/commit/00fa234980ba4b61dfa091cbf3dc31452cb12eba))
- init ([154f90c](https://github.com/yangxu52/rivmux/commit/154f90c9efd3dbf33e2d6cd1e225bf4fcd490891))
- prepare packages for npm release ([93087a0](https://github.com/yangxu52/rivmux/commit/93087a05c8a50eabacde6f36f795b0a9b676d387))
- remove legacy player wasm asset script ([5b759b6](https://github.com/yangxu52/rivmux/commit/5b759b646f7faf0fef4442297c981683580f37c8))
- rename public workspace packages ([7067fe6](https://github.com/yangxu52/rivmux/commit/7067fe619c2a02f2d6a1787f5fdd9aff10331033))
- wire transmux core into workspace references ([ef19ac0](https://github.com/yangxu52/rivmux/commit/ef19ac0998f675a1d71a1f06ea92b37e58584699))

### Tests

- add browser package smoke coverage ([4b66b98](https://github.com/yangxu52/rivmux/commit/4b66b989943bcf4b1eb33eb09ca1c065302eb6bb))
- add smoke coverage for test domains ([1c821ac](https://github.com/yangxu52/rivmux/commit/1c821acf0288ee0d19c6cea5c8dfd68896ecdfee))
- add wasm browser core path ([86d7847](https://github.com/yangxu52/rivmux/commit/86d78476c2513c7de0dabff1c167d16bd7f95bad))

## 1.1.0 (2026-06-29)

### Features

- add aac fmp4 mux path ([9bf2b64](https://github.com/yangxu52/rivmux/commit/9bf2b6475c33ccbf4165771fa56caa854b0b322d))
- add first release robustness coverage ([df7866e](https://github.com/yangxu52/rivmux/commit/df7866e4572efa96086392c3ddb352551235eadb))
- add flv parser core ([3bd5715](https://github.com/yangxu52/rivmux/commit/3bd5715b18160d6b0b0f7df050613b8e10a775ac))
- add fmp4 video writer ([9d20d55](https://github.com/yangxu52/rivmux/commit/9d20d55fdd74ec63164577ca4d4ec84e128e14bc))
- add live latency controls ([819d159](https://github.com/yangxu52/rivmux/commit/819d1599f14747776a3b7dc610e13aae88c57a4d))
- add wasm transmux host ([a1360ed](https://github.com/yangxu52/rivmux/commit/a1360ed7d14fcec22c4896eab8fb26889bda5eb2))
- append core fmp4 segments ([8b04bb3](https://github.com/yangxu52/rivmux/commit/8b04bb3d9f4f5fd91f56fcc34fa53a67055f3bb6))
- implement browser runtime proof ([2c4792d](https://github.com/yangxu52/rivmux/commit/2c4792d93d5b128d35e6cd9bd856e284c2541b85))
- implement worker loader lifecycle ([9c8ff32](https://github.com/yangxu52/rivmux/commit/9c8ff32d585e73ba7ee6f7176f22d57a42789e14))
- package default wasm assets ([8356f2e](https://github.com/yangxu52/rivmux/commit/8356f2ef499a2dcca75307be1f982fbcb34cf3e9))
- publish runtime worker package ([1d9fb40](https://github.com/yangxu52/rivmux/commit/1d9fb409740835a68b81ebe184ac4e255dcf74a8))
- scaffold runtime packages and crates ([d4d68d4](https://github.com/yangxu52/rivmux/commit/d4d68d4073368fd71a2c9e17c7045535b4e986f2))

### Miscellaneous Chores

- configure workspace tooling ([00fa234](https://github.com/yangxu52/rivmux/commit/00fa234980ba4b61dfa091cbf3dc31452cb12eba))
- init ([154f90c](https://github.com/yangxu52/rivmux/commit/154f90c9efd3dbf33e2d6cd1e225bf4fcd490891))
- prepare packages for npm release ([93087a0](https://github.com/yangxu52/rivmux/commit/93087a05c8a50eabacde6f36f795b0a9b676d387))
- remove legacy player wasm asset script ([5b759b6](https://github.com/yangxu52/rivmux/commit/5b759b646f7faf0fef4442297c981683580f37c8))
- rename public workspace packages ([7067fe6](https://github.com/yangxu52/rivmux/commit/7067fe619c2a02f2d6a1787f5fdd9aff10331033))
- wire transmux core into workspace references ([ef19ac0](https://github.com/yangxu52/rivmux/commit/ef19ac0998f675a1d71a1f06ea92b37e58584699))

### Tests

- add browser package smoke coverage ([4b66b98](https://github.com/yangxu52/rivmux/commit/4b66b989943bcf4b1eb33eb09ca1c065302eb6bb))
- add smoke coverage for test domains ([1c821ac](https://github.com/yangxu52/rivmux/commit/1c821acf0288ee0d19c6cea5c8dfd68896ecdfee))
- add wasm browser core path ([86d7847](https://github.com/yangxu52/rivmux/commit/86d78476c2513c7de0dabff1c167d16bd7f95bad))
