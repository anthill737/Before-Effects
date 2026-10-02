# Usability test kit (first-time users)

_Status 2026-10-02: **human testing pending.** No participants have been available yet. The build and these instructions are ready. Automated journey tests and screenshot reviews are not a substitute; they are listed separately at the end._

## Who and how

- **5 participants** who have never used Before Effects. Mix them:
  - two with no animation experience
  - two who use phone video or slideshow apps
  - one who knows After Effects
- **45 minutes each**, one at a time, on the participant's own or a borrowed Windows PC with a second screen if possible.
- **Think-aloud:** "Please say what you're looking for and what you expect." Don't help unless they're stuck for 2 minutes. If you help, write down exactly what you said.
- **Record** the screen and audio (with consent), or take timed notes.
- **Their own content:**
  - Ask them to bring a photo of a building or object, straight-on and daytime, plus one picture or short video and one song.
  - Keep spare content in `<data folder>\Test content` (a test photo, a short video and a music track).

## Setup (before each session)

1. Double-click **`Before Effects.exe`** in the Before Effects folder (or the desktop shortcut **Before Effects**). Check that it opens on the welcome screen.
2. Optional: check Claude Code or Codex is signed in, for task 9.
3. Close the app. The participant starts it.

## Tasks (read each one aloud; don't name buttons)

| # | Task (say this) | Success means | Record |
|---|---|---|---|
| 1 | "Start Before Effects from the desktop." | App open on the welcome screen | Time; did they find the shortcut |
| 2 | "Use your photo to start a show for your building." | Photo loaded as the canvas | Time; errors |
| 3 | "Mark three windows (or parts) on your photo, and correct one outline so it fits better." | 3 parts traced; one adjusted | Time; did they find "find similar" or tracing; satisfaction |
| 4 | "Make those windows light up one after another." | Effect applied to the right parts | Time; which route (action bar or library) |
| 5 | "Find the preview, play it, then go to exactly 3 seconds and step one frame forward." | Plays; frame stepping used | Did they find the transport and arrow keys |
| 6 | "Make the preview smaller so it plays more smoothly, then put it back to full quality." | Changed Preview size to Half or Quarter, then back | Did they confuse preview size with zoom or export size? |
| 7 | "Put your picture or video into one of the windows, and add your song so the windows flash with the beat." | Media fill and Move with the beat | Time; understanding of the beat |
| 8 | "Change the colour and speed of one effect." | Inspector controls used | Time |
| 9 | (Optional, if signed in) "Ask the assistant to make the top windows glow blue with the music, then make it slower." | Assistant change visible and kept; or undone if they want | Did they trust it; did they find Undo |
| 10 | "Add smoke rising from one window." | Smoke appears after preparing | Did they understand "Preparing…" |
| 11 | "Export a full-quality video you could send to a friend, while you keep working." | Export queued at full size; editor used meanwhile; file opened from Renders | Did they think the preview size affects the export? |
| 12 | "Save your show, close the app, open it again and carry on." | Same show reopened | Time |
| 13 | (Second screen) "Show your show full-screen on the second screen and line it up with the test pattern." | Output window on screen 2; pattern shown | Hardware-dependent; note the display used |

After each task, ask on a 1–5 scale:
- "How easy was that?"
- "How sure are you it did what you wanted?"

## Closing questions

- What was the most confusing moment?
- What did you expect to find that wasn't there?
- Would you use this for a real show? What would stop you?
- SUS questionnaire (System Usability Scale, 10 items).

## Release gate (from the brief)

The common workflow must be easy to understand: select surface → choose result → adjust a few controls → preview → export or play.

- **Pass:**
  - At least 4 of 5 participants complete tasks 2–8 and 11–12 without help.
  - Median ease ≥ 4 on those tasks.
  - Nobody believes the preview size changes the export.
- **Fix before release:** any task where 2 or more participants needed help.

## Results log (fill in)

| Participant | Date | Tasks completed unaided | Help given (task, what was said) | Ease (median) | SUS | Top problems |
|---|---|---|---|---|---|---|
| P1 | pending | | | | | |
| P2 | pending | | | | | |
| P3 | pending | | | | | |
| P4 | pending | | | | | |
| P5 | pending | | | | | |

## What is already verified without people (not a substitute)

- **Automated journey tests:** `npx electron . --ui-test` from `apps/studio` runs 70+ steps covering every task above except 13's physical alignment. They include pixel checks, exact export sizes, A/V timing, live AI runs (opt-in) and simulations.
- **Visual review:** each step saves a screenshot to `<data folder>\Renders\ui-test`. Reviewing them found and fixed:
  - toasts covering the assistant's text box
  - a Renders panel that repeated the Drive notice and overflowed sideways
  - an Inspector that said "Selection 2" instead of the part names
  - hex colour codes in assistant summaries
- **Hardware:** the projector output and second-display alignment are verified only on this PC's single built-in display. They are unverified on a real projector.
