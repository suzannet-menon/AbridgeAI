/* ==========================================================================
   AbridgeAI — agent workspace
   Client-side agent pipeline. Everything is deterministic: the same inputs
   always produce the same outputs, so results are reproducible per project.
   Zero dependencies — plain HTML/CSS/JS.
   ========================================================================== */
"use strict";

(function () {
  // ------------------------------------------------------------------------
  // DOM helpers
  // ------------------------------------------------------------------------
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var form = $("#project-form");
  var runBtn = $("#run-btn");
  var exampleBtn = $("#example-btn");
  var formHint = $("#form-hint");
  var statusEl = $("#status");
  var statusText = $("#status-text");
  var pipelineEl = $("#pipeline");
  var outputsEl = $("#outputs");
  var outputsPanel = $("#outputs-panel");
  var historyList = $("#history-list");
  var historyEmpty = $("#history-empty");
  var historyCount = $("#history-count");
  var historyClear = $("#history-clear");
  var toastEl = $("#toast");
  var pipelineState = $("#pipeline-state");
  var themeBtn = $("#theme-btn");
  var exportBtn = $("#export-btn");

  var STEP_ORDER = ["github", "research", "feasibility", "architecture", "stack", "builder", "task"];

  var HISTORY_KEY = "abridgeai.history.v1";
  var DRAFT_KEY = "abridgeai.draft.v1";
  var THEME_KEY = "abridgeai.theme.v1";

  var running = false;
  // The most recently generated / loaded project record (drives the export button).
  var currentProject = null;

  // ------------------------------------------------------------------------
  // Small utilities
  // ------------------------------------------------------------------------
  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  // djb2 — stable hash so agent outputs are deterministic per input string.
  function hash(str) {
    var h = 5381;
    var s = String(str == null ? "" : str);
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return h >>> 0;
  }

  // Deterministic pick: same seed + array => same items every time.
  function pick(seed, arr, count) {
    var items = arr.slice();
    var out = [];
    var h = seed >>> 0;
    var i, idx;
    for (i = 0; i < count && items.length > 0; i++) {
      h = (h * 1103515245 + 12345) >>> 0;
      idx = h % items.length;
      out.push(items.splice(idx, 1)[0]);
    }
    return out;
  }

  function timeStamp() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.hidden = true; }, 2600);
  }

  // ------------------------------------------------------------------------
  // Theme (light / dark). Respects the stored choice, else the system theme.
  // ------------------------------------------------------------------------
  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  function systemTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = mode === "dark" ? "#151310" : "#b6e62c";
    themeBtn.textContent = mode === "dark" ? "Light mode" : "Dark mode";
  }

  function initTheme() {
    applyTheme(storedTheme() || systemTheme());
    themeBtn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
      applyTheme(next);
      toast(next === "dark" ? "Dark theme on." : "Light theme on.");
    });
    if (window.matchMedia) {
      var mql = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function (e) {
        if (!storedTheme()) applyTheme(e.matches ? "dark" : "light");
      };
      if (mql.addEventListener) mql.addEventListener("change", onChange);
      else if (mql.addListener) mql.addListener(onChange);
    }
  }

  // ------------------------------------------------------------------------
  // GitHub parser (client-side, public API) + sample fallback
  // ------------------------------------------------------------------------
  function parseGitHubProfile(profile) {
    return {
      login: profile.login || "unknown",
      name: profile.name || profile.login || "Unknown",
      bio: profile.bio || null,
      location: profile.location || null,
      company: profile.company || null,
      blog: profile.blog || null,
      publicRepos: profile.public_repos != null ? profile.public_repos : 0,
      followers: profile.followers != null ? profile.followers : 0,
      following: profile.following != null ? profile.following : 0,
      htmlUrl: profile.html_url || null,
      createdAt: profile.created_at || null
    };
  }

  function tallyLanguages(repos) {
    var tally = {};
    (repos || []).forEach(function (repo) {
      var lang = repo.language;
      if (lang) tally[lang] = (tally[lang] || 0) + 1;
    });
    return Object.keys(tally)
      .map(function (k) { return { language: k, count: tally[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
  }

  function summarizeRepos(repos) {
    var sorted = (repos || []).slice().sort(function (a, b) {
      return (b.stargazers_count || 0) - (a.stargazers_count || 0);
    });
    return sorted.slice(0, 4).map(function (r) {
      return {
        name: r.name || r.full_name || "?",
        description: r.description || null,
        language: r.language || null,
        stars: r.stargazers_count != null ? r.stargazers_count : 0
      };
    });
  }

  // Try the public GitHub API; fall back to bundled sample data on any failure
  // (offline, rate limit, non-existent user, CORS).
  async function loadGitHub(username) {
    var user = String(username || "").trim().replace(/^@/, "");
    if (!user) return loadSampleGitHub();

    try {
      var profileRes = await fetch("https://api.github.com/users/" + encodeURIComponent(user));
      if (!profileRes.ok) throw new Error("GitHub profile status " + profileRes.status);
      var profile = await profileRes.json();

      var reposRes = await fetch(
        "https://api.github.com/users/" + encodeURIComponent(user) + "/repos?per_page=100&sort=updated"
      );
      var repos = reposRes.ok ? await reposRes.json() : [];

      return {
        source: "live",
        profile: parseGitHubProfile(profile),
        languages: tallyLanguages(repos),
        repos: summarizeRepos(repos)
      };
    } catch (err) {
      return loadSampleGitHub();
    }
  }

  async function loadSampleGitHub() {
    try {
      var res = await fetch("data/sample-github-analysis.json");
      if (!res.ok) throw new Error("sample fetch failed");
      var data = await res.json();
      return {
        source: "sample",
        profile: parseGitHubProfile(data.profile),
        languages: tallyLanguages(data.repos),
        repos: summarizeRepos(data.repos)
      };
    } catch (err) {
      return {
        source: "sample",
        profile: {
          login: "octocat", name: "The Octocat", bio: "Curious cat.",
          location: null, company: null, blog: null,
          publicRepos: 8, followers: 20124, following: 9,
          htmlUrl: null, createdAt: null
        },
        languages: [{ language: "TypeScript", count: 3 }, { language: "JavaScript", count: 1 }, { language: "Python", count: 1 }, { language: "Go", count: 1 }, { language: "Rust", count: 1 }],
        repos: []
      };
    }
  }

  // ------------------------------------------------------------------------
  // Deterministic agent outputs
  // ------------------------------------------------------------------------
  function githubAgentText(gh) {
    var p = gh.profile;
    var lines = [];
    lines.push(p.name + " (@" + p.login + ")");
    if (p.bio) lines.push("Bio: " + p.bio);
    var meta = [];
    if (p.location) meta.push(p.location);
    if (p.company) meta.push(p.company);
    if (p.blog) meta.push(p.blog);
    if (meta.length) lines.push("From: " + meta.join(" · "));
    lines.push("Public repos: " + p.publicRepos + "  ·  Followers: " + p.followers + "  ·  Following: " + p.following);

    var langs = gh.languages.slice(0, 3);
    if (langs.length) {
      lines.push("Top languages: " + langs.map(function (l) { return l.language + " (" + l.count + ")"; }).join(", "));
    }

    if (gh.repos.length) {
      lines.push("");
      lines.push("Featured repos:");
      gh.repos.forEach(function (r) {
        lines.push("  • " + r.name + (r.stars ? " ★" + r.stars : "") + (r.language ? " [" + r.language + "]" : ""));
        if (r.description) lines.push("    " + r.description);
      });
    }
    return lines.join("\n");
  }

  var RESEARCH_POOL = {
    opportunities: [
      "Small, focused tools with a single clear job tend to win over sprawling platforms.",
      "There is a steady market for fast, opinionated utilities that remove ceremony.",
      "Automation of recurring manual work remains underserved by most tooling.",
      "Teams pay for measurable time saved; the pitch should be concrete and numeric.",
      "The pattern of 'input → structured output' generalizes well across domains."
    ],
    risks: [
      "Feature creep is the top failure mode; scope to one sharp slice first.",
      "Existing incumbents often win on habit rather than capability.",
      "Solo-built tools struggle on support load; keep the surface area small.",
      "Integration friction with existing workflows is the most common adoption blocker.",
      "Underspecified inputs produce unreliable outputs; define inputs explicitly."
    ],
    directions: [
      "Lead with the fastest end-to-end vertical slice, then harden it.",
      "Ship a CLI first, then wrap it in a minimal web surface.",
      "Publish the deterministic core as a library so other tools can embed it.",
      "Make the pipeline observable: users should see each stage work.",
      "Design for offline-first; it removes a whole class of failure modes."
    ]
  };

  function researchAgentText(input, gh) {
    var seed = hash((input.idea || "") + "|" + input.stack);
    var opportunities = pick(seed, RESEARCH_POOL.opportunities, 3);
    var risks = pick(seed ^ 0x9e3779b9, RESEARCH_POOL.risks, 2);
    var directions = pick(seed ^ 0x85ebca6b, RESEARCH_POOL.directions, 2);

    var lines = [];
    lines.push("Project: " + input.idea);
    lines.push("Signal: " + (gh.languages.length ? gh.languages[0].language : "n/a") + "-first builder, " + gh.profile.followers + " followers on GitHub.");
    lines.push("");
    lines.push("Opportunity scan");
    opportunities.forEach(function (o, i) { lines.push((i + 1) + ". " + o); });
    lines.push("");
    lines.push("Risks to plan around");
    risks.forEach(function (r, i) { lines.push((i + 1) + ". " + r); });
    lines.push("");
    lines.push("Recommended direction");
    directions.forEach(function (d, i) { lines.push((i + 1) + ". " + d); });
    return lines.join("\n");
  }

  var MODULE_POOL = [
    "core / domain logic",
    "cli entrypoint",
    "web / api layer",
    "persistence adapter",
    "config & env handling",
    "logging & observability",
    "error taxonomy",
    "test harness / fixtures"
  ];

  function architectureAgentText(input) {
    var seed = hash((input.idea || "") + "|arch");
    var modules = pick(seed, MODULE_POOL, 4);
    var flow = pick(seed ^ 0x2545f491, [
      "input → parse → transform → output",
      "request → validate → execute → persist → respond",
      "collect → analyze → summarize → deliver",
      "watch → filter → act → report"
    ], 1)[0];

    var lines = [];
    lines.push("Shape: " + flow);
    lines.push("");
    lines.push("Modules");
    modules.forEach(function (m, i) { lines.push((i + 1) + ". " + m); });
    lines.push("");
    lines.push("Data flow");
    lines.push("  boundary → " + modules[0] + " → " + modules[1] + " → " + modules[2]);
    lines.push("");
    lines.push("Principles");
    lines.push("  • Pure core, thin shell: all logic deterministic & side-effect free.");
    lines.push("  • Adapters at the edges: swap CLI for web without touching core.");
    lines.push("  • Every module gets a unit test with fixed fixtures.");
    return lines.join("\n");
  }

  var STACKS = {
    typescript: {
      label: "TypeScript / JavaScript",
      app: "TypeScript 5 + Node 22 (or Bun)",
      ui: "React 18 + Vite",
      api: "Hono (lightweight, edge-ready)",
      data: "SQLite via better-sqlite3 (file) → Postgres when needed",
      test: "Vitest",
      lint: "Biome",
      why: "Strong typing for a deterministic pipeline, one language across CLI + web."
    },
    python: {
      label: "Python",
      app: "Python 3.12 + uv",
      ui: "Starlette + simple server-rendered templates",
      api: "FastAPI",
      data: "SQLite via stdlib sqlite3 → Postgres when needed",
      test: "pytest",
      lint: "Ruff",
      why: "Fast to iterate, rich stdlib for parsing and data work."
    },
    go: {
      label: "Go",
      app: "Go 1.22",
      ui: "net/http + static assets",
      api: "net/http stdlib (or chi)",
      data: "SQLite via modernc.org/sqlite → Postgres when needed",
      test: "go test",
      lint: "golangci-lint",
      why: "Single static binary, trivial to deploy, great for CLIs."
    },
    rust: {
      label: "Rust",
      app: "Rust 2021 edition",
      ui: "axum + serve static",
      api: "axum",
      data: "rusqlite → Postgres via sqlx when needed",
      test: "cargo test",
      lint: "clippy",
      why: "Maximum correctness for a deterministic pipeline; compile-time safety."
    },
    unsure: {
      label: "Not sure yet",
      app: "TypeScript 5 + Node 22",
      ui: "React 18 + Vite",
      api: "Hono",
      data: "SQLite via better-sqlite3",
      test: "Vitest",
      lint: "Biome",
      why: "Recommended default: one language, huge ecosystem, fastest path to a working demo."
    }
  };

  function stackParts(input) {
    return String(input.stackCustom || "")
      .split(",")
      .map(function (part) { return part.trim(); })
      .filter(Boolean);
  }

  function stackLabel(input) {
    var parts = stackParts(input);
    if (parts.length) return parts.join(" + ");
    return (STACKS[input.stack] || STACKS.unsure).label;
  }

  function stackAgentText(input) {
    var parts = stackParts(input);
    var custom = parts.length > 0;
    var key = input.stack || "unsure";
    var s = custom ? null : (STACKS[key] || STACKS.unsure);
    var comfort = input.comfort === "advanced" ? "skip guardrails, add CI + benchmarks early"
      : input.comfort === "intermediate" ? "add small tests per module, keep it boring"
      : "prefer scaffolding + step-by-step notes, one feature at a time";

    var lines = [];

    if (custom) {
      lines.push("Custom stack: " + parts.join(" + "));
      lines.push("Stack parts: " + parts.join(", "));
      lines.push("  app     define the smallest runnable slice for this stack");
      lines.push("  ui      use the lightest UI layer from the chosen stack");
      lines.push("  api     keep the first endpoint, command, or workflow narrow");
      lines.push("  data    start with local files or SQLite unless the idea clearly needs more");
      lines.push("  test    add one smoke test around the core flow");
      lines.push("  lint    use the standard formatter/linter for these tools");
      lines.push("");
      lines.push("Why: Custom stack requested by the builder; keep the first AO task scoped so the agent does not invent extra architecture.");
    } else {
      lines.push("Stack: " + s.label);
      lines.push("  app     " + s.app);
      lines.push("  ui      " + s.ui);
      lines.push("  api     " + s.api);
      lines.push("  data    " + s.data);
      lines.push("  test    " + s.test);
      lines.push("  lint    " + s.lint);
      lines.push("");
      lines.push("Why: " + s.why);
    }

    lines.push("Pace (" + input.comfort + "): " + comfort);
    return lines.join("\n");
  }

  // ------------------------------------------------------------------------
  // Feasibility Agent — deterministic score, verdict, estimate, risk register
  // ------------------------------------------------------------------------
  var PROJECT_TYPES = {
    tool: "CLI / developer tool",
    "web-app": "Web app",
    service: "API / service",
    "data-pipeline": "Data pipeline",
    unsure: "Not sure yet"
  };

  var TEAM_SIZES = {
    solo: "Solo",
    pair: "Pair",
    "small-team": "Small team (3–5)"
  };

  var PHASE_PLAN = [
    { week: 1, title: "Foundation", deliver: "repo, tooling, CI, module skeleton, fixtures" },
    { week: 2, title: "Core slice", deliver: "the main input → output flow, end to end" },
    { week: 3, title: "Harden", deliver: "edge cases, error taxonomy, tests per module" },
    { week: 4, title: "Ship", deliver: "docs, packaging, release notes, demo" }
  ];

  var FEAS_RISKS = [
    { risk: "Feature creep pulls the timeline out.", fix: "Freeze scope after the foundation phase and ship the vertical slice." },
    { risk: "Integration friction with existing workflows blocks adoption.", fix: "Design a paste-ready output and a copyable CLI from day one." },
    { risk: "Underspecified inputs produce unreliable outputs.", fix: "Define the input contract explicitly in the first milestone." },
    { risk: "Solo support load grows faster than the feature set.", fix: "Keep the surface area small; automate errors and self-help." },
    { risk: "The stack is unfamiliar at this comfort level.", fix: "Use the scaffolded starter files and step-by-step notes for the first week." }
  ];

  function padScore(n, max) {
    var s = String(n);
    while (s.length < String(max).length) s = " " + s;
    return s + "/" + max;
  }

  function feasibilityAgent(input) {
    var idea = String(input.idea || "").trim();
    var words = idea ? idea.split(/\s+/).length : 0;
    var audience = String(input.audience || "").trim();
    var comfort = input.comfort || "beginner";
    var typeKey = PROJECT_TYPES[input.type] ? input.type : "unsure";
    var teamKey = TEAM_SIZES[input.team] ? input.team : "solo";
    var dl = String(input.deadline || "").toLowerCase();

    // Deterministic score, 100 points across five weighted axes.
    var clarity = Math.min(30, Math.floor(words * 0.5) + (audience ? 3 : 0));
    var stackFit = comfort === "advanced" ? 25 : comfort === "intermediate" ? 20 : 15;
    var scope = { tool: 20, "data-pipeline": 18, service: 15, "web-app": 14, unsure: 10 }[typeKey];
    var time = dl.indexOf("month") !== -1 ? 14
      : dl.indexOf("week") !== -1 ? 12
      : dl === "" ? 8
      : /^\s*\d+\s*$/.test(String(input.deadline || "")) ? 9 : 10;
    var builderFit = input.stack && input.stack !== "unsure" ? 10 : 6;

    var score = Math.max(0, Math.min(100, clarity + stackFit + scope + time + builderFit));

    var verdictClass, verdict, verdictMsg;
    if (score >= 70) {
      verdictClass = "good";
      verdict = "GO";
      verdictMsg = "Worth building now — scope and stack line up with a realistic path.";
    } else if (score >= 50) {
      verdictClass = "warn";
      verdict = "Proceed with caution";
      verdictMsg = "Buildable — tighten scope or extend the deadline before committing.";
    } else {
      verdictClass = "bad";
      verdict = "Rethink / reshape";
      verdictMsg = "Too much surface for the current setup — reshape the scope first.";
    }

    var estimate = score >= 75 ? "Lean" : score >= 55 ? "Medium" : "Large";
    var weeks = score >= 75 ? "1–2" : score >= 55 ? "3–5" : "6–10";

    var seed = hash((input.idea || "") + "|" + input.stack + "|" + comfort + "|" + input.deadline + "|" + typeKey);
    var risks = pick(seed, FEAS_RISKS, 3);

    var stackLabel = input.stack && STACKS[input.stack] && input.stack !== "unsure"
      ? STACKS[input.stack].label
      : "default stack";

    var lines = [];
    lines.push("Feasibility: " + score + "/100 — " + verdict);
    lines.push("Verdict: " + verdictMsg);
    lines.push("");
    lines.push("Score card");
    lines.push("  Idea clarity  " + padScore(clarity, 30) + "  (" + words + " words" + (audience ? " · audience: yes" : "") + ")");
    lines.push("  Stack fit     " + padScore(stackFit, 25) + "  (" + comfort + ")");
    lines.push("  Scope         " + padScore(scope, 20) + "  (" + (PROJECT_TYPES[typeKey] || typeKey).toLowerCase() + ")");
    lines.push("  Time realism  " + padScore(time, 15) + "  (" + (input.deadline || "no deadline") + ")");
    lines.push("  Builder fit   " + padScore(builderFit, 10) + "  (" + stackLabel + ")");
    lines.push("");
    lines.push("Estimate: " + estimate + " — ~" + weeks + " weeks (" + (TEAM_SIZES[teamKey] || "Solo") + ")");
    lines.push("");
    lines.push("Phases");
    PHASE_PLAN.forEach(function (p, i) {
      lines.push("  " + (i + 1) + ". W" + p.week + " " + p.title + " — " + p.deliver);
    });
    lines.push("");
    lines.push("Risks & mitigations");
    risks.forEach(function (r, i) {
      lines.push("  " + (i + 1) + ". " + r.risk);
      lines.push("     " + r.fix);
    });

    return {
      score: score,
      verdict: verdict,
      verdictClass: verdictClass,
      estimate: estimate + " — ~" + weeks + " weeks",
      text: lines.join("\n")
    };
  }

  // ------------------------------------------------------------------------
  // Builder Agent — AO handoff scaffold (file tree + files) and milestone plan
  // ------------------------------------------------------------------------
  function builderAgent(input, feasibility) {
    var stackKey = input.stack || "unsure";
    var stack = STACKS[stackKey] || STACKS.unsure;
    var slug = slugify(input.name || input.idea || "project");
    var files = scaffoldFiles(input, slug);
    var treeLines = renderTree(files, slug);
    var milestones = buildMilestones();
    var dirs = countDirs(files);

    var lines = [];
    lines.push("Builder plan");
    lines.push("AO handoff scaffold: " + files.length + " files · " + dirs + " directories (" + stackLabel(input) + ")");
    lines.push("Use the ZIP as a scoped starting point for AO, not as production-ready code.");
    if (stackKey === "unsure") {
      lines.push("Stack: recommended default (TypeScript / JavaScript) until the stack is decided.");
    }
    lines.push("");
    lines.push("File tree");
    treeLines.forEach(function (l) { lines.push("  " + l); });
    lines.push("");
    lines.push("Starter files");
    files.forEach(function (f) {
      lines.push("  " + f.path + " — " + filePurpose(f.path));
    });
    lines.push("");
    lines.push("Milestones");
    milestones.forEach(function (m, i) {
      lines.push("  M" + (i + 1) + " · W" + m.week + " " + m.title);
      m.tasks.forEach(function (t) { lines.push("    - " + t); });
      lines.push("    Done when: " + m.accept);
    });

    return {
      text: lines.join("\n"),
      folder: slug,
      files: files
    };
  }

  function countDirs(files) {
    var dirs = {};
    files.forEach(function (f) {
      var parts = f.path.split("/");
      if (parts.length > 1) {
        for (var i = 1; i < parts.length; i++) {
          dirs[parts.slice(0, i).join("/")] = true;
        }
      }
    });
    return Object.keys(dirs).length;
  }

  function renderTree(files, rootName) {
    var root = {};
    files.forEach(function (f) {
      var parts = f.path.split("/");
      var node = root;
      parts.forEach(function (part) {
        if (!node[part]) node[part] = {};
        node = node[part];
      });
    });
    var lines = [];
    if (rootName) lines.push(rootName + "/");
    (function walk(node, prefix) {
      var keys = Object.keys(node).sort();
      keys.forEach(function (k, i) {
        var last = i === keys.length - 1;
        var children = node[k];
        var label = k + (Object.keys(children).length ? "/" : "");
        lines.push(prefix + (last ? "└── " : "├── ") + label);
        if (Object.keys(children).length) {
          walk(children, prefix + (last ? "    " : "│   "));
        }
      });
    })(root, "");
    return lines;
  }

  function filePurpose(path) {
    var name = path.split("/").pop();
    var map = {
      "package.json": "scripts, dev deps, module config",
      "tsconfig.json": "strict TypeScript config",
      "pyproject.toml": "project metadata, deps, pytest + ruff config",
      "go.mod": "module definition",
      "Cargo.toml": "crate metadata and deps",
      "index.ts": "entry point — parse input, run core, print output",
      "main.py": "entry point — Typer CLI over the core",
      "main.go": "entry point — parse args, run core",
      "main.rs": "entry point — parse args, run core",
      "core.ts": "pure deterministic core",
      "core.py": "pure deterministic core",
      "core.go": "pure deterministic core",
      "core.rs": "pure deterministic core",
      "core.test.ts": "first unit test for the core",
      "test_core.py": "first unit test for the core",
      "core_test.go": "first unit test for the core",
      "__init__.py": "package marker",
      "README.md": "quick start + run instructions",
      "PLAN.md": "feasibility summary + milestones",
      "AO_TASK.md": "scoped first PR prompt for AO",
      "ACCEPTANCE_CRITERIA.md": "checks AO should satisfy before PR review",
      ".gitignore": "ignore build artifacts"
    };
    return map[name] || "project file";
  }

  function buildMilestones() {
    return [
      { week: 1, title: "Foundation", tasks: ["Scaffold the repo from the starter files.", "Wire build, test, and lint scripts.", "Add fixtures for the first input sample."], accept: "the repo builds and the placeholder test passes." },
      { week: 2, title: "Core slice", tasks: ["Implement the main input → output flow in the core module.", "Connect the entry point to the core."], accept: "running the CLI on the sample input produces the expected output." },
      { week: 3, title: "Harden", tasks: ["Add error taxonomy and edge-case handling.", "Unit-test every module with fixed fixtures."], accept: "all tests are green and failures are clear and actionable." },
      { week: 4, title: "Ship", tasks: ["Write docs and a README quick start.", "Tag a release and open the PR."], accept: "a fresh clone builds and runs straight from the README." }
    ];
  }

  function scaffoldStackName(input) {
    return stackLabel(input);
  }

  function scaffoldCommands(stackKey, slug) {
    if (stackKey === "python") {
      return {
        install: "uv sync",
        run: "uv run " + slug + " \"hello\"",
        test: "uv run pytest",
        build: "uv run ruff check ."
      };
    }
    if (stackKey === "go") {
      return {
        install: "go mod tidy",
        run: "go run . \"hello\"",
        test: "go test ./...",
        build: "go build ./..."
      };
    }
    if (stackKey === "rust") {
      return {
        install: "cargo fetch",
        run: "cargo run -- \"hello\"",
        test: "cargo test",
        build: "cargo check"
      };
    }
    return {
      install: "npm install",
      run: "node dist/index.js \"hello\"",
      test: "npm test",
      build: "npm run build"
    };
  }

  function scaffoldReadme(input, slug, name, desc, stackKey) {
    var commands = scaffoldCommands(stackKey, slug);
    var lines = [];
    lines.push("# " + name);
    lines.push("");
    lines.push(desc);
    lines.push("");
    lines.push("## What this scaffold contains");
    lines.push("");
    lines.push("- A small deterministic core for the first vertical slice.");
    lines.push("- A thin entry point that calls the core.");
    lines.push("- A smoke test so AO has a concrete correctness target.");
    lines.push("- PLAN.md, AO_TASK.md, and ACCEPTANCE_CRITERIA.md for scoped delegation.");
    lines.push("");
    lines.push("## Stack");
    lines.push("");
    lines.push(scaffoldStackName(input));
    lines.push("");
    lines.push("## Install");
    lines.push("");
    lines.push("```bash");
    lines.push(commands.install);
    lines.push("```");
    lines.push("");
    lines.push("## Build / lint");
    lines.push("");
    lines.push("```bash");
    lines.push(commands.build);
    lines.push("```");
    lines.push("");
    lines.push("## Run");
    lines.push("");
    lines.push("```bash");
    lines.push(commands.run);
    lines.push("```");
    lines.push("");
    lines.push("## Test");
    lines.push("");
    lines.push("```bash");
    lines.push(commands.test);
    lines.push("```");
    lines.push("");
    lines.push("## First AO task");
    lines.push("");
    lines.push("Use AO_TASK.md as the first prompt. Keep the first PR narrow and only implement the vertical slice described there.");
    lines.push("");
    lines.push("## What not to build yet");
    lines.push("");
    lines.push("- Authentication.");
    lines.push("- Database persistence unless the first slice requires it.");
    lines.push("- Multiple UI screens.");
    lines.push("- Deployment automation.");
    lines.push("- Extra integrations not listed in the acceptance criteria.");
    lines.push("");
    lines.push("This scaffold is an AO handoff scaffold, not production-ready code.");
    lines.push("");
    return lines.join("\n");
  }

  function aoTaskMarkdown(input, slug) {
    var lines = [];
    lines.push("# AO Task");
    lines.push("");
    lines.push("Project: " + (input.name || slug));
    lines.push("Stack: " + scaffoldStackName(input));
    lines.push("Deadline: " + (input.deadline || "not specified"));
    lines.push("Comfort: " + (input.comfort || "beginner"));
    lines.push("");
    lines.push("## Idea");
    lines.push("");
    lines.push(input.idea || "Build the first deterministic vertical slice.");
    lines.push("");
    lines.push("## First PR prompt");
    lines.push("");
    lines.push("Implement the smallest runnable vertical slice for this project using the existing scaffold.");
    lines.push("Keep the deterministic core separate from the entry point.");
    lines.push("Add or update one smoke test that proves the core behavior.");
    lines.push("Update README.md only if the run/test commands change.");
    lines.push("Do not add authentication, persistence, deployment, or unrelated screens.");
    lines.push("Open a PR with a concise summary and verification notes.");
    lines.push("");
    return lines.join("\n");
  }

  function acceptanceMarkdown(input, slug) {
    var commands = scaffoldCommands(input.stack || "unsure", slug);
    var lines = [];
    lines.push("# Acceptance Criteria");
    lines.push("");
    lines.push("- Install works: `" + commands.install + "`");
    lines.push("- Run command works: `" + commands.run + "`");
    lines.push("- One smoke test passes: `" + commands.test + "`");
    lines.push("- README instructions are accurate.");
    lines.push("- The first vertical slice is implemented only.");
    lines.push("- No unrelated features are added.");
    lines.push("- The core logic remains deterministic and easy to test.");
    lines.push("");
    return lines.join("\n");
  }

  function scaffoldFiles(input, slug) {
    var stackKey = input.stack || "unsure";
    var name = input.name || slug;
    var desc = input.idea || "A deterministic tool.";
    var files = [
      { path: "PLAN.md", content: planMarkdown(input, slug) },
      { path: "AO_TASK.md", content: aoTaskMarkdown(input, slug) },
      { path: "ACCEPTANCE_CRITERIA.md", content: acceptanceMarkdown(input, slug) }
    ];
    var starter = stackKey === "python" ? pyStarter(slug, name, desc, input)
      : stackKey === "go" ? goStarter(slug, name, desc, input)
      : stackKey === "rust" ? rustStarter(slug, name, desc, input)
      : tsStarter(slug, name, desc, input); // typescript + unsure (recommended default)
    return files.concat(starter);
  }

  function planMarkdown(input, slug) {
    var f = feasibilityAgent(input);
    var lines = [];
    lines.push("# " + (input.name || slug) + " — Build Plan");
    lines.push("");
    lines.push("- **Idea:** " + (input.idea || "—"));
    lines.push("- **Feasibility:** " + f.score + "/100 — " + f.verdict);
    lines.push("- **Estimate:** " + f.estimate);
    lines.push("");
    lines.push("## Milestones");
    buildMilestones().forEach(function (m, i) {
      lines.push("### M" + (i + 1) + " — W" + m.week + " " + m.title);
      lines.push("");
      m.tasks.forEach(function (t) { lines.push("- " + t); });
      lines.push("- **Done when:** " + m.accept);
      lines.push("");
    });
    return lines.join("\n");
  }

  function tsStarter(slug, name, desc, input) {
    var pkg = {
      name: slug,
      version: "0.1.0",
      private: true,
      type: "module",
      description: desc,
      scripts: { build: "tsc", test: "vitest run", "test:watch": "vitest", lint: "biome check src" },
      devDependencies: { typescript: "^5.5.0", vitest: "^2.1.0", "@types/node": "^22.0.0", "@biomejs/biome": "^1.9.0" }
    };
    var tsconfig = {
      compilerOptions: {
        target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
        strict: true, outDir: "dist", rootDir: "src",
        declaration: true, sourceMap: true, esModuleInterop: true, skipLibCheck: true
      },
      include: ["src"]
    };
    return [
      { path: "package.json", content: JSON.stringify(pkg, null, 2) + "\n" },
      { path: "tsconfig.json", content: JSON.stringify(tsconfig, null, 2) + "\n" },
      { path: "src/index.ts", content:
        "// " + name + " — " + desc + "\n" +
        "// Entry point: parse the input, run the deterministic core, print output.\n" +
        "\n" +
        'import { run } from "./core.js";\n' +
        "\n" +
        "function main() {\n" +
        '  const input = process.argv.slice(2).join(" ");\n' +
        '  process.stdout.write(run(input) + "\\n");\n' +
        "}\n" +
        "\n" +
        "main();\n" },
      { path: "src/core.ts", content:
        "// Pure, deterministic core — no side effects, no external AI calls.\n" +
        "export function run(input: string): string {\n" +
        '  return "received: " + input;\n' +
        "}\n" },
      { path: "test/core.test.ts", content:
        'import { describe, expect, it } from "vitest";\n' +
        'import { run } from "../src/core.js";\n' +
        "\n" +
        'describe("core", () => {\n' +
        '  it("handles empty input", () => {\n' +
        '    expect(run("")).toBe("received: ");\n' +
        "  });\n" +
        "});\n" },
      { path: ".gitignore", content: "node_modules/\ndist/\n*.log\n" },
      { path: "README.md", content: scaffoldReadme(input, slug, name, desc, "typescript") }
    ];
  }

  function pyStarter(slug, name, desc, input) {
    return [
      { path: "pyproject.toml", content:
        "[project]\n" +
        "name = \"" + slug + "\"\n" +
        "version = \"0.1.0\"\n" +
        "description = \"" + desc + "\"\n" +
        "requires-python = \">=3.12\"\n" +
        "dependencies = [\"typer>=0.12\"]\n" +
        "\n" +
        "[project.scripts]\n" +
        slug + " = \"src.main:cli\"\n" +
        "\n" +
        "[tool.pytest.ini_options]\n" +
        "addopts = \"-q\"\n" +
        "\n" +
        "[tool.ruff]\n" +
        "line-length = 100\n" +
        "\n" +
        "[dependency-groups]\n" +
        "dev = [\"pytest>=8.0\", \"ruff>=0.6\"]\n" },
      { path: "src/__init__.py", content: "" },
      { path: "src/main.py", content:
        '"""Entry point — Typer CLI over the deterministic core."""\n' +
        "\n" +
        "from src.core import run\n" +
        "\n" +
        "def cli():\n" +
        "    import typer\n" +
        "\n" +
        "    app = typer.Typer()\n" +
        "\n" +
        "    @app.command()\n" +
        "    def go(input_text: str):\n" +
        '        """Run the pipeline over INPUT_TEXT."""\n' +
        "        typer.echo(run(input_text))\n" +
        "\n" +
        "    app()\n" +
        "\n" +
        "if __name__ == \"__main__\":\n" +
        "    cli()\n" },
      { path: "src/core.py", content:
        '"""Pure, deterministic core — no side effects, no external AI calls."""\n' +
        "\n" +
        "def run(input_text: str) -> str:\n" +
        '    return "received: " + input_text\n' },
      { path: "tests/test_core.py", content:
        "from src.core import run\n" +
        "\n" +
        "def test_empty():\n" +
        '    assert run("") == "received: "\n' },
      { path: ".gitignore", content: "__pycache__/\n.venv/\n*.pyc\n" },
      { path: "README.md", content: scaffoldReadme(input, slug, name, desc, "python") }
    ];
  }

  function goStarter(slug, name, desc, input) {
    return [
      { path: "go.mod", content: "module " + slug + "\n\ngo 1.22\n" },
      { path: "main.go", content:
        "package main\n" +
        "\n" +
        "import (\n" +
        "  \"fmt\"\n" +
        "  \"os\"\n" +
        "  \"strings\"\n" +
        "  \"" + slug + "/core\"\n" +
        ")\n" +
        "\n" +
        "func main() {\n" +
        "  input := strings.Join(os.Args[1:], \" \")\n" +
        "  fmt.Println(core.Run(input))\n" +
        "}\n" },
      { path: "core/core.go", content:
        "package core\n" +
        "\n" +
        "// Run is the pure, deterministic core.\n" +
        "func Run(input string) string {\n" +
        "  return \"received: \" + input\n" +
        "}\n" },
      { path: "core/core_test.go", content:
        "package core\n" +
        "\n" +
        "import \"testing\"\n" +
        "\n" +
        "func TestRunEmpty(t *testing.T) {\n" +
        "  if got := Run(\"\"); got != \"received: \" {\n" +
        '    t.Fatalf("Run() = %q, want %q", got, "received: ")\n' +
        "  }\n" +
        "}\n" },
      { path: ".gitignore", content: "bin/\n*.exe\n" },
      { path: "README.md", content: scaffoldReadme(input, slug, name, desc, "go") }
    ];
  }

  function rustStarter(slug, name, desc, input) {
    return [
      { path: "Cargo.toml", content:
        "[package]\n" +
        "name = \"" + slug + "\"\n" +
        "version = \"0.1.0\"\n" +
        "edition = \"2021\"\n" +
        "\n" +
        "[dependencies]\n" },
      { path: "src/main.rs", content:
        "mod core;\n" +
        "\n" +
        "fn main() {\n" +
        "  let input: Vec<String> = std::env::args().skip(1).collect();\n" +
        "  println!(\"{}\", core::run(&input.join(\" \")));\n" +
        "}\n" },
      { path: "src/core.rs", content:
        "// Pure, deterministic core — no side effects, no external AI calls.\n" +
        "pub fn run(input: &str) -> String {\n" +
        "  format!(\"received: {input}\")\n" +
        "}\n" +
        "\n" +
        "#[cfg(test)]\n" +
        "mod tests {\n" +
        "  use super::*;\n" +
        "\n" +
        "  #[test]\n" +
        "  fn run_empty() {\n" +
        "    assert_eq!(run(\"\"), \"received: \");\n" +
        "  }\n" +
        "}\n" },
      { path: ".gitignore", content: "/target\n" },
      { path: "README.md", content: scaffoldReadme(input, slug, name, desc, "rust") }
    ];
  }

  // ------------------------------------------------------------------------
  // Scaffold download — minimal ZIP (store-only, no dependencies)
  // ------------------------------------------------------------------------
  var CRC_TABLE = null;

  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Int32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c;
      }
    }
    var crc = -1;
    for (var i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

  function buildZip(files) {
    var enc = new TextEncoder();
    var localChunks = [];
    var central = [];
    var offset = 0;
    var DOS_TIME = 0;
    var DOS_DATE = 0x5821; // 2024-01-01 00:00 — fixed, so downloads are reproducible.

    files.forEach(function (f) {
      var nameBytes = enc.encode(f.path);
      var dataBytes = enc.encode(f.content);
      var crc = crc32(dataBytes);
      var local = new Uint8Array(30 + nameBytes.length + dataBytes.length);
      var v = new DataView(local.buffer);
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 0x0800, true); // UTF-8 filename flag
      v.setUint16(8, 0, true);      // store (no compression)
      v.setUint16(10, DOS_TIME, true);
      v.setUint16(12, DOS_DATE, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, dataBytes.length, true);
      v.setUint32(22, dataBytes.length, true);
      v.setUint16(26, nameBytes.length, true);
      v.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      local.set(dataBytes, 30 + nameBytes.length);
      localChunks.push(local);
      central.push({ nameBytes: nameBytes, crc: crc, size: dataBytes.length, offset: offset });
      offset += local.length;
    });

    var centralChunks = [];
    var centralStart = offset;
    central.forEach(function (c, i) {
      var hdr = new Uint8Array(46 + c.nameBytes.length);
      var v = new DataView(hdr.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, DOS_TIME, true);
      v.setUint16(14, DOS_DATE, true);
      v.setUint32(16, c.crc, true);
      v.setUint32(20, c.size, true);
      v.setUint32(24, c.size, true);
      v.setUint16(28, c.nameBytes.length, true);
      v.setUint16(30, 0, true);
      v.setUint16(32, 0, true);
      v.setUint16(34, 0, true);
      v.setUint16(36, 0, true);
      v.setUint32(38, 0, true);
      v.setUint32(42, c.offset, true);
      hdr.set(c.nameBytes, 46);
      centralChunks.push(hdr);
    });

    var centralSize = centralChunks.reduce(function (s, c) { return s + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    ev.setUint16(20, 0, true);

    var total = centralStart + centralSize + eocd.length;
    var out = new Uint8Array(total);
    var pos = 0;
    localChunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
    centralChunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
    out.set(eocd, pos);
    return out;
  }

  function downloadZip(files, name) {
    var blob = new Blob([buildZip(files)], { type: "application/zip" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function taskAgentText(ctx) {
    var lines = [];
    lines.push("AO READY TASK PROMPT");
    lines.push("====================");
    lines.push("");
    lines.push("Build: " + ctx.idea);
    lines.push("For: " + (ctx.name || "the project owner"));
    lines.push("");
    lines.push("Context");
    lines.push("- GitHub: " + ctx.githubFirstLine);
    lines.push("- Feasibility: " + ctx.feasLine);
    lines.push("- Builder: " + ctx.builderLine);
    lines.push("- Stack: " + ctx.stackLabel);
    lines.push("- Architecture: " + ctx.architectureFirstLine);
    lines.push("- Research: " + ctx.researchFirstLine);
    lines.push("- Deadline: " + (ctx.deadline || "not specified") + " · Comfort: " + ctx.comfort);
    lines.push("");
    lines.push("Instructions");
    lines.push("1. Start with a short implementation plan before editing.");
    lines.push("2. Scaffold the project from the provided starter files.");
    lines.push("3. Keep logic deterministic — no external AI calls.");
    lines.push("4. Structure the code as a pure core with thin adapters.");
    lines.push("5. Add a unit test for every module.");
    lines.push("6. Implement, verify locally, commit, and open a PR.");
    return lines.join("\n");
  }

  // ------------------------------------------------------------------------
  // Pipeline UI
  // ------------------------------------------------------------------------
  function setStepState(step, state) {
    var el = pipelineEl.querySelector('[data-step="' + step + '"]');
    if (!el) return;
    el.classList.remove("is-running", "is-done");
    if (state === "running") el.classList.add("is-running");
    if (state === "done") el.classList.add("is-done");
    var statusEl = el.querySelector(".pipe-status");
    statusEl.textContent = state === "running" ? "running…" : state === "done" ? "done" : "queued";
  }

  function resetSteps() {
    STEP_ORDER.forEach(function (step) { setStepState(step, "queued"); });
  }

  function setPipelineState(state) {
    pipelineState.textContent = state;
  }

  function setStatus(state, text) {
    statusEl.setAttribute("data-state", state);
    statusText.textContent = text;
  }

  function addOutputCard(index, title, bodyHtml, opts) {
    opts = opts || {};
    outputsPanel.hidden = false;
    var card = document.createElement("article");
    card.className = "card";
    card.setAttribute("data-agent", opts.agent || "");

    var head = document.createElement("div");
    head.className = "card-head";

    var titleEl = document.createElement("div");
    titleEl.className = "card-title";
    titleEl.innerHTML =
      '<span class="card-index">' + esc("0" + index) + "</span>" +
      "<span>" + esc(title) + "</span>";

    head.appendChild(titleEl);

    var headActions = document.createElement("div");
    headActions.className = "card-head-actions";

    if (opts.copyText) {
      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "card-copy";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", function () {
        copyText(opts.copyText, copyBtn);
      });
      headActions.appendChild(copyBtn);
    }

    if (opts.badge) {
      var badge = document.createElement("span");
      badge.className = "card-badge";
      badge.textContent = opts.badge;
      headActions.appendChild(badge);
    }

    if (headActions.children.length) head.appendChild(headActions);

    var body = document.createElement("div");
    body.className = "card-body";
    body.innerHTML = bodyHtml;

    card.appendChild(head);
    card.appendChild(body);
    outputsEl.appendChild(card);

    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return card;
  }

  function renderPromptCard(text) {
    var card = addOutputCard(7, "AO Task Agent", "", { agent: "task" });
    var body = $(".card-body", card);

    var wrap = document.createElement("div");
    wrap.className = "prompt-wrap";

    var ta = document.createElement("textarea");
    ta.id = "ao-prompt";
    ta.readOnly = true;
    ta.value = text;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "Copy prompt";
    btn.addEventListener("click", function () {
      copyText(ta.value, btn);
    });

    wrap.appendChild(ta);
    wrap.appendChild(btn);
    body.appendChild(wrap);
  }

  // Feasibility card: score meter + verdict badge, then the full text.
  function renderFeasibilityCard(feas) {
    var card = addOutputCard(3, "Feasibility Agent", "", { agent: "feasibility", copyText: feas.text });
    var body = $(".card-body", card);

    var meter = document.createElement("div");
    meter.className = "feas-meter";

    var scoreEl = document.createElement("div");
    scoreEl.className = "feas-score";
    scoreEl.innerHTML =
      '<span class="feas-score-num">' + esc(feas.score) + "</span>" +
      '<span class="feas-score-max">/100</span>';

    var track = document.createElement("div");
    track.className = "feas-track";
    track.setAttribute("aria-hidden", "true");
    var fill = document.createElement("div");
    fill.className = "feas-fill";
    fill.style.width = Math.max(0, Math.min(100, feas.score)) + "%";
    track.appendChild(fill);

    var verdictEl = document.createElement("div");
    verdictEl.className = "feas-verdict feas-verdict--" + esc(feas.verdictClass || "good");
    verdictEl.textContent = feas.verdict;

    meter.appendChild(scoreEl);
    meter.appendChild(track);
    meter.appendChild(verdictEl);

    var pre = document.createElement("pre");
    pre.textContent = feas.text;

    body.appendChild(meter);
    body.appendChild(pre);
    return card;
  }

  // Builder card: full plan text + a scaffold (.zip) download action.
  function renderBuilderCard(builder) {
    var card = addOutputCard(6, "Builder Agent", "", { agent: "builder", copyText: builder.text });
    var headActions = $(".card-head-actions", card);

    var dl = document.createElement("button");
    dl.type = "button";
    dl.className = "card-download";
    dl.textContent = "Download scaffold (.zip)";
    dl.addEventListener("click", function () {
      downloadZip(builder.files, builder.folder + ".zip");
      toast("Scaffold downloaded.");
    });
    headActions.appendChild(dl);

    var body = $(".card-body", card);
    var pre = document.createElement("pre");
    pre.textContent = builder.text;
    body.appendChild(pre);
    return card;
  }

  function copyText(text, btn) {
    function flash() {
      if (btn) {
        btn.classList.add("is-copied");
        setTimeout(function () { btn.classList.remove("is-copied"); }, 1400);
      }
    }

    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); toast("Copied to clipboard"); flash(); }
      catch (e) { toast("Could not copy — select the text manually."); }
      document.body.removeChild(ta);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast("Copied to clipboard");
        flash();
      }, fallback);
    } else {
      fallback();
    }
  }

  // ------------------------------------------------------------------------
  // Brief export (Markdown file download — no dependencies)
  // ------------------------------------------------------------------------
  function slugify(str) {
    return String(str || "project").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project";
  }

  function buildBriefMarkdown(record) {
    var L = [];
    L.push("# " + (record.name || "Project") + " — AbridgeAI Brief");
    L.push("");
    L.push("> Generated by AbridgeAI · " + (record.time || new Date().toLocaleString()));
    L.push("");
    L.push("## Project");
    L.push("");
    L.push("- **Idea:** " + (record.idea || "—"));
    L.push("- **Stack:** " + stackLabel(record));
    L.push("- **Type:** " + ((PROJECT_TYPES[record.type] || record.type || "—")));
    L.push("- **Team:** " + ((TEAM_SIZES[record.team] || record.team || "—")));
    L.push("- **Audience:** " + (record.audience || "—"));
    L.push("- **GitHub:** " + (record.github || "—"));
    L.push("- **Deadline:** " + (record.deadline || "—"));
    L.push("- **Comfort:** " + (record.comfort || "—"));
    L.push("");

    if (record.outputs) {
      var agents = [
        ["1. GitHub Agent", record.outputs.github.text],
        ["2. Research Agent", record.outputs.research],
        ["3. Feasibility Agent", record.outputs.feasibility ? record.outputs.feasibility.text : ""],
        ["4. Architecture Agent", record.outputs.architecture],
        ["5. Tech Stack Agent", record.outputs.stack],
        ["6. Builder Agent", record.outputs.builder ? record.outputs.builder.text : ""],
        ["7. AO Task Agent", record.outputs.prompt || record.prompt]
      ];
      agents.forEach(function (a) {
        if (!a[1]) return;
        L.push("## " + a[0]);
        L.push("");
        L.push("```text");
        L.push(a[1]);
        L.push("```");
        L.push("");
      });
    }
    return L.join("\n");
  }

  function downloadFile(name, content, type) {
    var blob = new Blob([content], { type: type || "text/markdown;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function updateExportBtn() {
    exportBtn.hidden = !currentProject;
  }

  exportBtn.addEventListener("click", function () {
    if (!currentProject) return;
    downloadFile(
      slugify(currentProject.name || currentProject.idea) + "-abridgeai-brief.md",
      buildBriefMarkdown(currentProject)
    );
    toast("Project brief exported.");
  });

  // ------------------------------------------------------------------------
  // History (left rail) — now stores full outputs, not just inputs
  // ------------------------------------------------------------------------
  function readHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch (e) { return []; }
  }

  function writeHistory(items) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items)); } catch (e) { /* ignore */ }
  }

  function renderHistory(activeId) {
    var items = readHistory();
    historyList.innerHTML = "";
    historyEmpty.style.display = items.length ? "none" : "";
    historyCount.textContent = items.length;
    historyClear.hidden = !items.length;

    items.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "history-item" + (item.id === activeId ? " is-active" : "");
      // Keyboard-accessible: focusable and activatable with Enter / Space.
      li.tabIndex = 0;
      li.setAttribute("aria-label", "Open project " + esc(item.name || item.idea || "untitled"));
      li.innerHTML =
        '<p class="history-item-title">' + esc(item.name || item.idea || "Untitled") + "</p>" +
        '<div class="history-item-meta">' + esc(item.time || "") + "</div>" +
        '<button type="button" class="history-item-del" aria-label="Delete ' + esc(item.name || item.idea || "project") + '">×</button>';
      li.addEventListener("click", function () {
        loadProject(item);
      });
      li.addEventListener("keydown", function (e) {
        if (e.target !== li) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          loadProject(item);
        }
      });
      var del = li.querySelector(".history-item-del");
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        deleteHistoryItem(item.id);
      });
      historyList.appendChild(li);
    });
  }

  function deleteHistoryItem(id) {
    var items = readHistory().filter(function (it) { return it.id !== id; });
    writeHistory(items);
    if (currentProject && currentProject.id === id) currentProject = null;
    updateExportBtn();
    renderHistory();
    toast("Project removed from history.");
  }

  historyClear.addEventListener("click", function () {
    if (!readHistory().length) return;
    if (window.confirm("Clear all saved projects? This cannot be undone.")) {
      writeHistory([]);
      currentProject = null;
      updateExportBtn();
      renderHistory();
      toast("History cleared.");
    }
  });

  function saveHistory(record) {
    var items = readHistory();
    items.unshift(record);
    writeHistory(items.slice(0, 12));
  }

  function loadProject(item) {
    fillForm(item);
    renderHistory(item.id);
    renderSavedProject(item);
  }

  function fillForm(item) {
    $("#f-name").value = item.name || "";
    $("#f-stack").value = item.stack || "typescript";
    $("#f-stack-custom").value = item.stackCustom || "";
    $("#f-github").value = item.github || "";
    $("#f-idea").value = item.idea || "";
    $("#f-deadline").value = item.deadline || "";
    $("#f-comfort").value = item.comfort || "beginner";
    $("#f-type").value = item.type || "tool";
    $("#f-team").value = item.team || "solo";
    $("#f-audience").value = item.audience || "";
  }

  function readForm() {
    return {
      name: $("#f-name").value.trim(),
      stack: $("#f-stack").value,
      stackCustom: $("#f-stack-custom").value.trim(),
      github: $("#f-github").value.trim(),
      idea: $("#f-idea").value.trim(),
      deadline: $("#f-deadline").value.trim(),
      comfort: $("#f-comfort").value,
      type: $("#f-type").value,
      team: $("#f-team").value,
      audience: $("#f-audience").value.trim()
    };
  }

  // Re-render a saved project's outputs without re-running the pipeline.
  function renderSavedProject(item) {
    outputsEl.innerHTML = "";
    resetSteps();
    var saved = item.outputs;
    var prompt = saved && (saved.prompt || item.prompt);
    if (!saved || !prompt) {
      outputsPanel.hidden = true;
      setPipelineState("standby");
      setStatus("idle", "idle");
      toast("Run the pipeline to generate outputs for this project.");
      return;
    }
    outputsPanel.hidden = false;
    addOutputCard(1, "GitHub Agent", "<pre>" + esc(saved.github.text) + "</pre>", {
      agent: "github",
      badge: saved.github.badge,
      copyText: saved.github.text
    });
    addOutputCard(2, "Research Agent", "<pre>" + esc(saved.research) + "</pre>", {
      agent: "research",
      copyText: saved.research
    });
    // Feasibility + Builder are deterministic, so they can be re-derived from
    // the saved inputs even when a project predates this upgrade.
    var feas = saved.feasibility
      ? { score: saved.feasibility.score, verdict: saved.feasibility.verdict, verdictClass: saved.feasibility.verdictClass || "good", text: saved.feasibility.text }
      : feasibilityAgent(item);
    renderFeasibilityCard(feas);
    addOutputCard(4, "Architecture Agent", "<pre>" + esc(saved.architecture) + "</pre>", {
      agent: "architecture",
      copyText: saved.architecture
    });
    addOutputCard(5, "Tech Stack Agent", "<pre>" + esc(saved.stack) + "</pre>", {
      agent: "stack",
      copyText: saved.stack
    });
    var builder = saved.builder || builderAgent(item, feas);
    renderBuilderCard(builder);
    renderPromptCard(prompt);
    STEP_ORDER.forEach(function (step) { setStepState(step, "done"); });
    setPipelineState("complete");
    setStatus("done", "saved · " + (item.time || ""));
    currentProject = item;
    updateExportBtn();
    toast("Loaded saved project outputs.");
  }

  // ------------------------------------------------------------------------
  // Draft autosave — refresh-safe form persistence
  // ------------------------------------------------------------------------
  function writeDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(readForm())); } catch (e) { /* ignore */ }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
  }

  function restoreDraft() {
    var draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (e) { /* ignore */ }
    if (!draft) return;
    $("#f-name").value = draft.name || "";
    $("#f-stack").value = draft.stack || "typescript";
    $("#f-stack-custom").value = draft.stackCustom || "";
    $("#f-github").value = draft.github || "";
    $("#f-idea").value = draft.idea || "";
    $("#f-deadline").value = draft.deadline || "";
    $("#f-comfort").value = draft.comfort || "beginner";
    $("#f-type").value = draft.type || "tool";
    $("#f-team").value = draft.team || "solo";
    $("#f-audience").value = draft.audience || "";
  }

  form.addEventListener("input", debounce(writeDraft, 350));

  // ------------------------------------------------------------------------
  // Load example — one click to try the pipeline with sample data
  // ------------------------------------------------------------------------
  exampleBtn.addEventListener("click", function () {
    $("#f-name").value = "Ada";
    $("#f-stack").value = "python";
    $("#f-stack-custom").value = "Python, FastAPI, React";
    $("#f-github").value = "octocat";
    $("#f-idea").value = "A CLI that turns meeting notes into action items, with a simple web dashboard.";
    $("#f-deadline").value = "4 weeks";
    $("#f-comfort").value = "intermediate";
    $("#f-type").value = "tool";
    $("#f-team").value = "solo";
    $("#f-audience").value = "busy engineers who take a lot of meeting notes";
    writeDraft();
    toast("Example loaded — press Run pipeline (or Ctrl+Enter).");
    $("#f-idea").focus();
  });

  // ------------------------------------------------------------------------
  // Pipeline runner
  // ------------------------------------------------------------------------
  async function runPipeline(input) {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    formHint.textContent = "";
    outputsEl.innerHTML = "";
    outputsPanel.hidden = true;
    // No brief to export while a fresh run is in progress.
    currentProject = null;
    updateExportBtn();

    resetSteps();
    setPipelineState("running");
    setStatus("running", "running pipeline");

    // 1 — GitHub Agent (real API with sample fallback)
    setStepState("github", "running");
    setStatus("running", "github agent…");
    var gh = await loadGitHub(input.github);
    await sleep(650);
    var ghText = githubAgentText(gh);
    var ghBadge = gh.source === "live" ? "live · github.com" : "sample data";
    addOutputCard(1, "GitHub Agent", "<pre>" + esc(ghText) + "</pre>", {
      agent: "github",
      badge: ghBadge,
      copyText: ghText
    });
    setStepState("github", "done");

    // 2 — Research Agent
    setStepState("research", "running");
    setStatus("running", "research agent…");
    await sleep(900);
    var researchText = researchAgentText(input, gh);
    addOutputCard(2, "Research Agent", "<pre>" + esc(researchText) + "</pre>", {
      agent: "research",
      copyText: researchText
    });
    setStepState("research", "done");

    // 3 — Feasibility Agent
    setStepState("feasibility", "running");
    setStatus("running", "feasibility agent…");
    await sleep(800);
    var feas = feasibilityAgent(input);
    renderFeasibilityCard(feas);
    setStepState("feasibility", "done");

    // 4 — Architecture Agent
    setStepState("architecture", "running");
    setStatus("running", "architecture agent…");
    await sleep(900);
    var archText = architectureAgentText(input);
    addOutputCard(4, "Architecture Agent", "<pre>" + esc(archText) + "</pre>", {
      agent: "architecture",
      copyText: archText
    });
    setStepState("architecture", "done");

    // 5 — Tech Stack Agent
    setStepState("stack", "running");
    setStatus("running", "tech stack agent…");
    await sleep(800);
    var stackText = stackAgentText(input);
    addOutputCard(5, "Tech Stack Agent", "<pre>" + esc(stackText) + "</pre>", {
      agent: "stack",
      copyText: stackText
    });
    setStepState("stack", "done");

    // 6 — Builder Agent (starter scaffold + milestone plan)
    setStepState("builder", "running");
    setStatus("running", "builder agent…");
    await sleep(900);
    var builder = builderAgent(input, feas);
    renderBuilderCard(builder);
    setStepState("builder", "done");

    // 7 — AO Task Agent (assembles the copyable prompt)
    setStepState("task", "running");
    setStatus("running", "assembling AO task…");
    await sleep(800);
    var ctx = {
      name: input.name,
      idea: input.idea,
      deadline: input.deadline,
      comfort: input.comfort,
      githubFirstLine: ghText.split("\n")[0],
      feasLine: feas.score + "/100 — " + feas.verdict,
      builderLine: builder.files.length + " files · " + countDirs(builder.files) + " dirs — download the scaffold (.zip)",
      stackLabel: stackLabel(input),
      architectureFirstLine: archText.split("\n")[0],
      researchFirstLine: researchText.split("\n")[0]
    };
    var promptText = taskAgentText(ctx);
    renderPromptCard(promptText);
    setStepState("task", "done");

    setPipelineState("complete");
    setStatus("done", "complete · " + timeStamp());

    if (input.idea) {
      var record = {
        id: Date.now().toString(36),
        name: input.name,
        stack: input.stack,
        stackCustom: input.stackCustom,
        github: input.github,
        idea: input.idea,
        deadline: input.deadline,
        comfort: input.comfort,
        type: input.type,
        team: input.team,
        audience: input.audience,
        time: new Date().toLocaleString(),
        outputs: {
          github: { text: ghText, badge: ghBadge },
          research: researchText,
          feasibility: { score: feas.score, verdict: feas.verdict, verdictClass: feas.verdictClass, text: feas.text },
          architecture: archText,
          stack: stackText,
          builder: { text: builder.text, folder: builder.folder, files: builder.files },
          prompt: promptText
        },
        prompt: promptText
      };
      currentProject = record;
      updateExportBtn();
      saveHistory(record);
      renderHistory(record.id);
      clearDraft();
    }

    running = false;
    runBtn.disabled = false;
    formHint.textContent = "Pipeline complete.";
  }

  function onSubmit(e) {
    e.preventDefault();
    var input = readForm();
    if (!input.idea) {
      formHint.textContent = "Add a project idea first.";
      return;
    }
    // Never leave the UI stuck if something unexpected fails mid-pipeline.
    runPipeline(input).catch(function () {
      running = false;
      runBtn.disabled = false;
      setPipelineState("standby");
      setStatus("idle", "idle");
      formHint.textContent = "";
      toast("Something went wrong — please try again.");
    });
  }

  form.addEventListener("submit", onSubmit);

  // Ctrl/Cmd + Enter anywhere in the form runs the pipeline.
  form.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      onSubmit(e);
    }
  });

  // ------------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------------
  initTheme();
  restoreDraft();
  renderHistory();
  updateExportBtn();
})();