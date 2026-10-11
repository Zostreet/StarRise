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

IndexedDB `starrise-creator-studio` keeps working projects, source blobs and transparent PNG art layers in the current browser. Local saves stay local. The account client loads only when Collaborate is opened (or an explicit session link is opened). It reuses the existing account and verifies it with `auth.getUser()`. Published versions upload the complete JSON backup to the private `studio-sessions` bucket. UI text uses form values and textContent. CSP allows local scripts and only the existing Supabase API/storage origins. The vendored clients are pinned to Supabase JS 2.117.3 and tus-js-client 4.3.1, with licenses and package-lock.json. No service-role key is present in the website.

Shared sessions have an owner and invited editor/viewer members. Invitations must be accepted before content access. Editors publish immutable snapshots; viewers can open and comment. Opening a version creates a new local project, and subsequent publication records the starting version. There is no concurrent merge, live audio call, or automatic email. Session links confer no permission. Owners manage invitations and remove future access; downloaded copies remain with recipients. Versions and comments remain until an administrator processes a deletion request.

Four RLS tables, guarded RPCs and bucket-qualified storage policies enforce access independently of the UI. Public mutation RPCs intentionally use SECURITY DEFINER with an empty search_path, explicit registered-account checks, action-specific owner/editor checks, and authenticated-only execute grants. The advisor reports those signed-in RPCs as expected warnings; no anonymous RPC grant exists. Anonymous auth accounts are also rejected. Storage inserts require a pending version reserved by that same author. Finalization verifies actual uploaded size and MIME type. Ready JSON objects cannot be overwritten through the studio. TUS uploads use the direct storage host, fixed 6 MiB chunks, retries and a cancel button. Published JSON backups are limited to 50 MiB, including embedded audio. Large projects can be transferred as source files / ZIPs outside the shared-version flow.

The migration was created with the pinned Supabase CLI and the file name was reconciled with the actual applied migration history (`20261011124315_studio_collaboration.sql`). The legacy JS assets remain for cache-safe deployment; creator-studio.html now loads creator-studio-core-v2.js and creator-studio-v3.js.

Microphone capture begins only after the user chooses Record and grants browser permission. AudioWorklet buffers mono float PCM, discards the count-in and emits silence to the destination to prevent live monitoring. Stop flushes the partial buffer before constructing the take; microphone tracks are released immediately. Hidden/pagehide events stop recording and playback. Interrupted navigation may prevent the last save from completing; the beforeunload guard and backup controls help protect drafts. Hardware latency varies; take offsets can be adjusted. Microphone takes stop after ten minutes and a project supports 32 takes. Import/export processing is subject to the browser's memory and codec support.

The demo explicitly records synthesized tones, not a person's voice, and never requests microphone access. Verify the capture engine through the demo without granting unnecessary test permissions; test the real microphone on the user's own device before claiming that hardware path has passed.

Track and master racks provide high pass, low/mid/high EQ, compression, makeup gain, saturation, deterministic stereo reverb and feedback delay. Settings are nondestructive and persist with the project. Trim/fade/offset edits are separate from original sources. New microphone takes are saved as float WAV at the browser audio engine rate; imports retain their original bytes. Export supports 44.1/48 kHz and PCM16, PCM24 or IEEE float32 WAV (including a fact chunk). Sample peak/RMS metering is not LUFS or true-peak analysis. The output bus includes a safety compressor, which is not a guarantee against every transient.

Studio ZIPs contain original sources, the editable StarRise JSON backup, credits, notes, lyrics, script, shot CSV, cover PNG and setlist. Clean and complete options add common-origin, equally padded stems and a reference mix. Clean stems have trim/fade edits but no track FX, level or pan changes; processed stems include track FX/level/pan but not master FX. Muted takes and drum patterns are included with mute flags in the manifest. Reference audio respects mute controls and master processing. ZIP assembly is limited to an estimated 256 MiB; individual offline renders to 128 MiB of float sample buffers. Choose source-only transfers or shorter projects for larger sessions. This is not a native Pro Tools / Logic / Ableton file or a VST/AU/AAX host; engineers can load the clean WAVs into desktop software and use their own plug-ins. Export settings do not repair poor capture quality.

Memberships, payments, youth tools and distribution readiness gates remain independent.

## Verification

Run `node scripts/validate-site.mjs`, `node --check css/creator-studio-v3.js`, `node --check css/studio-recorder-worklet.js`, `node --test creator-studio.test.cjs studio-pro.test.cjs`, and the existing payment suite. The core/worklet tests cover imports, scheduling, stems, WAV interleaving, trim bounds, CSV formulas, sample alignment, stereo-to-mono capture, flushing and silent monitoring.

Live UI checks should cover project persistence/reload, backup import/export with assets, lyrics and scripts, beat editing/playback and WAV, demo capture/imported takes/mix export, clip trim, layered PNG and undo, timer/prompt controls, entry points and responsive geometry. The production Pages workflow stages public HTML and css assets; this README and the test file remain excluded.

The production workflow runs 20 studio/core/worklet/format/ZIP tests and the existing 15 payment tests. ZIP integrity is checked by Python zipfile independently, including CRCs and exact binary source bytes. `scripts/studio-collaboration-test.sql` exercises owner/editor/viewer/invited/removed/stranger/anonymous access, pending uploads, immutable ready objects, size constraints and cross-session version boundaries in one transaction, then rolls back every synthetic account and record. No real member invitations or messages are sent during verification.

Exports present a ready-file dialog with a native download link. This keeps the final file save tied to a fresh user gesture after long renders. Closing the dialog keeps its URL briefly for download completion; a new export replaces it.
