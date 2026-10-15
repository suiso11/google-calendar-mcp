// M5 dedicated reschedule entrypoint (SEPARATE from the readonly surface).
//
// Provenance: derived from fork base 6939311fd3eae9846648e0a175e304c9500f578e
// (`feat/companion-readonly-compatibility`); reschedule sources live ONLY
// under `src/reschedule/` (ported byte-identical from standalone work
// `164cb83`, superseded orphan branch `feat/m5-reschedule-entrypoint`).
// The readonly entry (`src/index.ts` -> `build/index.js`, name
// `google-calendar`, version `3.0.0-readonly.2`) is untouched: this bundle
// (`build/reschedule-cli.js`, bin `calendar-reschedule-mcp`) registers ONLY
// `reschedule-event` with identity `google-calendar-reschedule` /
// `1.0.0-reschedule.1`. No live writes, no OAuth activation in this file.

import "./reschedule/cli.js";
