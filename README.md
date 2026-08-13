# AbridgeAI — Agent Workspace

A static, client-side workspace that turns a project idea into an AO-ready task prompt.
No build step, no backend, no external AI calls: every agent output is **deterministic** —
the same inputs always produce the same outputs.

## Features

- **Landing screen** — a one-section welcome that previews the five-agent pipeline
  interactively and hands off to the full workspace with one click.
- **Five-agent pipeline** — GitHub → Research → Architecture → Tech Stack → AO Task, run
  in order and visualized live in the right-hand rail.
- **Deterministic by design** — inputs are hashed (djb2) and used to pick from fixed
  knowledge pools; there is no randomness anywhere in the pipeline.
- **Live GitHub data with graceful fallback** — fetches the public GitHub profile + repos
  via the public GitHub API (client-side). Falls back to bundled sample data
  (`data/sample-github-analysis.json`) when the API is unreachable, rate-limited, CORS-blocked,
  or the user doesn't exist.
- **Copy-ready AO task prompt** — the final agent assembles one copyable prompt; the
  **Copy prompt** button writes it to the clipboard, and every agent card has its own
  **Copy** button.
- **Export the full project brief** — one click downloads the entire brief (project
  profile + all five agent outputs) as a Markdown file, ready to share or file.
- **Project history with saved outputs** — completed runs (inputs *and* outputs) are saved
  to the left-hand rail (localStorage). Clicking an entry restores the form **and**
  re-opens the full saved brief without re-running; individual entries can be deleted and
  history can be cleared.
- **Draft autosave** — the form persists automatically, so a refresh never loses an
  in-progress idea.
- **Light & dark themes** — a toggle in the top bar; honors the stored choice and falls
  back to your system preference.
- **Works everywhere** — plain HTML/CSS/JS. Open the file directly or serve the folder;
  no dependencies, no install.

## How it works

Fill in the form (name, preferred stack, GitHub username, project idea, deadline,
comfort level) and run the pipeline — with the **Run pipeline** button or **Ctrl+Enter**:

1. **GitHub Agent** — pulls the public GitHub profile + top repos and languages.
2. **Research Agent** — deterministic opportunity / risk / direction scan.
3. **Architecture Agent** — deterministic module + data-flow blueprint.
4. **Tech Stack Agent** — deterministic stack recommendation from your preference.
5. **AO Task Agent** — assembles one copyable, AO-ready task prompt.

The **Load example** button fills the form with a sample project (which pairs with the
bundled fallback GitHub data) so you can try the whole pipeline in one click.

## Run it

Static files only — open `index.html` in any browser, or serve the folder:

```sh
# any static server works, e.g.
python -m http.server 8000
# then open http://localhost:8000
```

## Project structure

| Path | Purpose |
| --- | --- |
| `index.html` | Landing screen + workspace shell (history / form / pipeline). |
| `styles.css` | Design system (light & dark themes). |
| `script.js` | GitHub parser, deterministic agents, pipeline runner, history, export, theme, copy. |
| `favicon.svg` | Site favicon (matches the brand mark). |
| `data/sample-github-analysis.json` | Fallback GitHub profile + repos when the API is unavailable. |
| `CONTRIBUTING.md` | Guidelines for contributing. |
| `LICENSE` | Apache-2.0 license. |

```
abridgeai/
├── index.html
├── styles.css
├── script.js
├── favicon.svg
├── data/
│   └── sample-github-analysis.json
├── CONTRIBUTING.md
├── LICENSE
└── README.md
```

## Layout

- **Landing screen** — opens first: brand, pitch, an interactive pipeline preview
  (walk through all five agents), and the **Enter the workspace** button that reveals
  the workspace and focuses the form.
- **Left rail** — project history (populates after runs; click to re-open a saved brief,
  delete individual entries, or clear all).
- **Center** — form + generated outputs, with a **Export brief (.md)** action and a
  light/dark theme toggle in the top bar.
- **Right rail** — live agent pipeline (status per agent).

Style: warm off-white background, near-black text, one lime accent, hairline borders.
Dark theme switches the palette while keeping the same identity.

## Notes

- GitHub API usage is unauthenticated (60 req/hr/IP). On failure the pipeline
  transparently falls back to sample data and labels the card accordingly.
- Determinism is guaranteed by hashing inputs (djb2) before selecting from fixed
  knowledge pools — no randomness anywhere in the pipeline.
- Everything persists in `localStorage` under `abridgeai.*` keys (history, draft, theme);
  clearing browser data for the site resets it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run, test, and submit changes.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).