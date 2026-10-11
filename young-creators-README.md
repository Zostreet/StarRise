# StarRise Young Creators

The youth section is a working, free learning and creation area, separate from the existing adult community. It implements the account-free approach in the Youth Arts school proposal. Adult account, content, membership, messaging and payment behavior is unchanged.

## Available

- Eight original creative activities, path filters and self-reported progress for the current visit.
- Songwriting and story writing with text exports and clipboard copy.
- Eight-step kick/snare/hi-hat sequencer, explicit audio playback and local PCM WAV export.
- Pointer and keyboard drawing, undo, a confirmation before clearing, and PNG export.
- Three-scene story planner with text export and stage practice with a 30-second timer.
- Adult parent/teacher information and the proposed school pilot at `youth-program.html`.
- Dedicated youth privacy notice and entry points from the home, join, registration, community, dashboard and partner pages.

## Boundary

The youth page uses only same-origin static assets. Its Content Security Policy blocks network connections, forms, plugins and third-party resources. It neither initializes Supabase nor reads browser account tokens, cookies, localStorage or sessionStorage. All creative state is in memory and is cleared on reload. Exports use local Blob URLs; no creations or progress reach a backend. Ordinary hosting request records still exist.

The adult-information dialog is an intentional transition for parents and teachers, not age verification or verified parental consent. This is a separate navigation experience, not a device-wide content blocker. Do not describe it as a child account system, moderated social network, approved school program or certified COPPA compliance.

## Shared youth features are closed

Child accounts, cloud saves, public profiles, youth posts and direct messages are not implemented or offered. Do not connect the adult community feed, sign-up, uploads, marketplace or payment SDK to the youth page. A future shared service requires verified guardian permissions and appropriate notices, child data minimization and retention, isolated access controls, publication review, guardian removal tools and an operational supervision process before opening. A consent checkbox or client-side age selector is insufficient.

The FTC's current children's privacy resources are at https://www.ftc.gov/business-guidance/privacy-security/childrens-privacy. The rule includes updated requirements; review the current rule before adding collection or disclosure. The school pilot separately needs a host, written arrangements, approved facilitators, supervision, permissions and funding.

## Deployment and verification

All public HTML is staged by the existing Pages workflow. JavaScript and CSS are in `css/`, which is already copied. This developer document is excluded from the Pages artifact.

Run the existing site validator and payment tests. Browser verification should cover phone layouts, activity filters/dialogs, keyboard tabs, beat playback/export, pointer/keyboard drawing and undo, writing/story exports, timer controls, parent navigation, and zero backend requests or account storage access. Do not enable youth collection merely to test it.
