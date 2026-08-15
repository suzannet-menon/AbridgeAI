# AbridgeAI — Agent Workspace

*Built for the Agent Orchestrator (Orchestra Hackathon).*

A static, client-side workspace that turns a project idea into a **feasibility plan, a
starter scaffold, and an AO-ready task prompt**. No build step, no backend, no external
AI calls: every agent output is **deterministic** — the same inputs always produce the
same outputs.

## Features

- **Seven-agent pipeline** — GitHub → Research → Feasibility → Architecture → Tech Stack →
  Builder → AO Task, run in order and visualized live in the right-hand rail.
- **Deterministic by design** — inputs are hashed (djb2) and used to pick from fixed
  knowledge pools; there is no randomness anywhere in the pipeline.
- **Feasibility planner** — a scored verdict (/100 across five axes), a GO / proceed /
  rethink recommendation, an effort estimate with week ranges, a four-phase plan, and a
  risk register with mitigations — all computed from the form inputs.
- **Builder capability** — the Builder Agent generates a starter scaffold for the chosen
  stack (file tree, starter files, milestone checklist with acceptance criteria) and a
  **Download scaffold (.zip)** button produces a real, unzippable starter project that
  includes a `PLAN.md` build plan plus `AO_TASK.md` and `ACCEPTANCE_CRITERIA.md` handoff docs.
- **Live GitHub data with graceful fallback** — fetches the public GitHub profile + repos
  via the public GitHub API (client-side). Falls back to bundled sample data
  (`data/sample-github-analysis.json`) when the API is unreachable, rate-limited, CORS-blocked,
  or the user doesn't exist.
- **Copy-ready AO task prompt** — the final agent assembles one copyable prompt; the
  **Copy prompt** button writes it to the clipboard, and every agent card has its own
  **Copy** button.
- **Export the full project brief** — one click downloads the entire brief (project
  profile + all seven agent outputs) as a Markdown file, ready to share or file.
- **Project history with saved outputs** — completed runs (inputs *and* outputs) are saved
  to the left-hand rail (localStorage). Clicking an entry restores the form **and**
  re-opens the full saved brief without re-running; individual entries can be deleted and
  history can be cleared. Projects saved before the Feasibility/Builder upgrade are
  re-derived deterministically on open.
- **Draft autosave** — the form persists automatically, so a refresh never loses an
  in-progress idea.
- **Light & dark themes** — a toggle in the top bar; honors the stored choice and falls
  back to your system preference.
- **Works everywhere** — plain HTML/CSS/JS. Open the file directly or serve the folder;
  no dependencies, no install.

## Screenshots

![AbridgeAI dashboard form](Abridge-kanman-board.png)

![AbridgeAI kanban board](AbridgeAi-dashboard.png)

## How it works

Fill in the form (name, preferred stack, optional custom stack, GitHub username, project
idea, deadline, comfort level, project type, team size, audience) and run the pipeline —
with the **Run pipeline** button or **Ctrl+Enter**:

1. **GitHub Agent** — pulls the public GitHub profile + top repos and languages.
2. **Research Agent** — deterministic opportunity / risk / direction scan.
3. **Feasibility Agent** — scored feasibility, verdict, effort estimate, phases, risk register.
4. **Architecture Agent** — deterministic module + data-flow blueprint.
5. **Tech Stack Agent** — deterministic stack recommendation from your preference.
6. **Builder Agent** — starter scaffold (file tree + starter files), milestone checklist, and
   a **Download scaffold (.zip)** action.
7. **AO Task Agent** — assembles one copyable, AO-ready task prompt citing the feasibility
   verdict and the scaffold.

The **Load example** button fills the form with a sample project (which pairs with the
bundled fallback GitHub data) so you can try the whole pipeline in one click.

## Run it

Static files only — open `index.html` in any browser, or serve the folder:

```sh
# any static server works, e.g.
python -m http.server 8000
# then open http://localhost:8000
```

If you changed `script.js`, confirm it still parses before opening the page:
`node --check script.js`.

## Submission links

- **Output repo** — where AO raised a PR for the problem statement:
  <https://github.com/ruchirajags/AO-DUMMY.git>
- **Demo video** — <https://youtu.be/AJ6Sbk-3UQU>

## Project structure

| Path | Purpose |
| --- | --- |
| `index.html` | Workspace shell (history / form / pipeline). |
| `styles.css` | Design system (light & dark themes). |
| `script.js` | GitHub parser, deterministic agents, pipeline runner, history, export, theme, copy. |
| `favicon.svg` | Site favicon (matches the brand mark). |
| `AbridgeAi-dashboard.png` | Dashboard screenshot for the README. |
| `Abridge-kanman-board.png` | Kanban board screenshot for the README. |
| `data/sample-github-analysis.json` | Fallback GitHub profile + repos when the API is unavailable. |
| `LICENSE` | Apache-2.0 license. |

```
abridgeai/
├── index.html
├── styles.css
├── script.js
├── favicon.svg
├── AbridgeAi-dashboard.png
├── Abridge-kanman-board.png
├── data/
│   └── sample-github-analysis.json
├── LICENSE
└── README.md
```

## Layout

- **Left rail** — project history (populates after runs; click to re-open a saved brief,
  delete individual entries, or clear all).
- **Center** — form + generated outputs, with an **Export brief (.md)** action and a
  light/dark theme toggle in the top bar.
- **Right rail** — live agent pipeline (status per agent, GitHub → Research → Feasibility →
  Architecture → Tech Stack → Builder → AO Task).

Style: warm off-white background, near-black text, one lime accent, hairline borders.
Dark theme switches the palette while keeping the same identity.

## Notes

- GitHub API usage is unauthenticated (60 req/hr/IP). On failure the pipeline
  transparently falls back to sample data and labels the card accordingly.
- Determinism is guaranteed by hashing inputs (djb2) before selecting from fixed
  knowledge pools — no randomness anywhere in the pipeline.
- The scaffold download is a dependency-free, store-only ZIP built in the browser;
  the same inputs always produce byte-identical starter files.
- Everything persists in `localStorage` under `abridgeai.*` keys (history, draft, theme);
  clearing browser data for the site resets it.

## Team Members

- [Suzanne Daniel Thomas](https://github.com/suzannet-menon)
- [Ruchira Rajesh Jagshettiwar](https://github.com/ruchirajags)

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
