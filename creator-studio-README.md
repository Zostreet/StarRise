# StarRise adult Creator Studio

The adult studio extends the Young Creators tool concept into six working adult creative rooms. It is free to try and does not add youth content filtering, change adult account eligibility, alter memberships or entitlements, enable payments, or modify the youth experience.

## Working features

- Multi-project browser library with autosave, duplicate, recoverable trash, full JSON backups and imports as new projects.
- Song sections with reordering, key/direction notes, word counts, original prompts and TXT/clipboard exports.
- Six synthesized drum tracks, 16 steps, two editable pattern banks, velocity, groove presets, swing, per-track pan/level/mute, arrangements, stereo WAV and individual stem exports.
- Digital recording studio: sequential microphone takes with one-bar count-in or no count-in, beat arrangement and existing-take playback, local audio import, track level/pan/mute/offset, stereo session mix export, and an explicit synthesized demo through the same AudioWorklet capture path. Live microphone monitoring is off.
- Audio clip editor with waveform, trim points, rate/pitch adjustment, gain, symmetric fades and PCM WAV export.
- 1200-square cover canvas with three layers, layer visibility, brush/eraser/line/rectangle, lettering, image import, session undo/redo, PNG export and keyboard marks.
- Flexible scene planner with shots, duration, action/dialogue, reordering, TXT script and CSV shot list; formula-like CSV values are neutralized.
- Setlist planning, cues, adjustable timed rehearsal with pause/reset, scrolling lyric/script prompt and TXT export.

## Storage and scope

IndexedDB `starrise-creator-studio` stores projects and a current-project pointer. Audio blobs and transparent PNG art layers are kept with each project. No Supabase, payment, tracking or upload API is initialized by the studio. Browser account tokens and existing account storage are not read. CSP restricts resources to same-origin scripts/assets and local blob/data media and blocks network connections and forms. Host request records still exist. Project input is rendered through form values or textContent rather than interpolated HTML.

Microphone capture begins only after the user chooses Record and grants browser permission. AudioWorklet buffers mono PCM, discards the count-in and emits silence to the destination to prevent live monitoring. Stop flushes the partial buffer before constructing the take; microphone tracks are released immediately. Hidden/pagehide events stop recording and playback. Interrupted navigation may prevent the last save from completing; the beforeunload guard and backup controls help protect drafts. Hardware latency varies; take offsets can be adjusted. Microphone takes stop after ten minutes and a project supports 32 takes. Import/export processing is subject to the browser's memory and codec support.

The demo explicitly records synthesized tones, not a person's voice, and never requests microphone access. Verify the capture engine through the demo without granting unnecessary test permissions; test the real microphone on the user's own device before claiming that hardware path has passed.

This is browser-based recording and creative tooling, not a DAW plugin host, automated mastering service, licensed sample library, copyright filing service, cloud collaborative editor, or streaming distribution integration. Publishing, listings, memberships and payments retain their existing behavior and readiness gates.

## Verification

Run `node scripts/validate-site.mjs`, `node --check css/creator-studio.js`, `node --check css/studio-recorder-worklet.js`, `node --test creator-studio.test.cjs`, and the existing payment suite. The core/worklet tests cover imports, scheduling, stems, WAV interleaving, trim bounds, CSV formulas, sample alignment, stereo-to-mono capture, flushing and silent monitoring.

Live UI checks should cover project persistence/reload, backup import/export with assets, lyrics and scripts, beat editing/playback and WAV, demo capture/imported takes/mix export, clip trim, layered PNG and undo, timer/prompt controls, entry points and responsive geometry. The production Pages workflow stages public HTML and css assets; this README and the test file remain excluded.
