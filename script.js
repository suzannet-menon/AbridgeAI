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

  // Landing screen (first screen; hands off to the workspace).
  var landingEl = $("#landing");
  var appEl = $("#app");
  var landingEnter = $("#landing-enter");
  var landingPreview = $("#landing-preview");
  var landingSteps = $("#landing-steps");
  var landingThemeBtn = $("#landing-theme-btn");

  var STEP_ORDER = ["github", "research", "architecture", "stack", "task"];

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
    [themeBtn, landingThemeBtn].forEach(function (btn) {
      if (btn) btn.textContent = mode === "dark" ? "Light mode" : "Dark mode";
    });
  }

  function toggleTheme() {
    var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    applyTheme(next);
    toast(next === "dark" ? "Dark theme on." : "Light theme on.");
  }

  function initTheme() {
    applyTheme(storedTheme() || systemTheme());
    [themeBtn, landingThemeBtn].forEach(function (btn) {
      if (btn) btn.addEventListener("click", toggleTheme);
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

  function stackAgentText(input) {
    var key = input.stack || "unsure";
    var s = STACKS[key] || STACKS.unsure;
    var comfort = input.comfort === "advanced" ? "skip guardrails, add CI + benchmarks early"
      : input.comfort === "intermediate" ? "add small tests per module, keep it boring"
      : "prefer scaffolding + step-by-step notes, one feature at a time";

    var lines = [];
    lines.push("Stack: " + s.label);
    lines.push("  app     " + s.app);
    lines.push("  ui      " + s.ui);
    lines.push("  api     " + s.api);
    lines.push("  data    " + s.data);
    lines.push("  test    " + s.test);
    lines.push("  lint    " + s.lint);
    lines.push("");
    lines.push("Why: " + s.why);
    lines.push("Pace (" + input.comfort + "): " + comfort);
    return lines.join("\n");
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
    lines.push("- Stack: " + ctx.stackLabel);
    lines.push("- Architecture: " + ctx.architectureFirstLine);
    lines.push("- Research: " + ctx.researchFirstLine);
    lines.push("- Deadline: " + (ctx.deadline || "not specified") + " · Comfort: " + ctx.comfort);
    lines.push("");
    lines.push("Instructions");
    lines.push("1. Start with a short implementation plan before editing.");
    lines.push("2. Keep logic deterministic — no external AI calls.");
    lines.push("3. Structure the code as a pure core with thin adapters.");
    lines.push("4. Add a unit test for every module.");
    lines.push("5. Implement, verify locally, commit, and open a PR.");
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
    var card = addOutputCard(5, "AO Task Agent", "", { agent: "task" });
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
    L.push("- **Stack:** " + (STACKS[record.stack] || STACKS.unsure).label);
    L.push("- **GitHub:** " + (record.github || "—"));
    L.push("- **Deadline:** " + (record.deadline || "—"));
    L.push("- **Comfort:** " + (record.comfort || "—"));
    L.push("");

    if (record.outputs) {
      var agents = [
        ["1. GitHub Agent", record.outputs.github.text],
        ["2. Research Agent", record.outputs.research],
        ["3. Architecture Agent", record.outputs.architecture],
        ["4. Tech Stack Agent", record.outputs.stack],
        ["5. AO Task Agent", record.outputs.prompt || record.prompt]
      ];
      agents.forEach(function (a) {
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
    $("#f-github").value = item.github || "";
    $("#f-idea").value = item.idea || "";
    $("#f-deadline").value = item.deadline || "";
    $("#f-comfort").value = item.comfort || "beginner";
  }

  function readForm() {
    return {
      name: $("#f-name").value.trim(),
      stack: $("#f-stack").value,
      github: $("#f-github").value.trim(),
      idea: $("#f-idea").value.trim(),
      deadline: $("#f-deadline").value.trim(),
      comfort: $("#f-comfort").value
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
    addOutputCard(3, "Architecture Agent", "<pre>" + esc(saved.architecture) + "</pre>", {
      agent: "architecture",
      copyText: saved.architecture
    });
    addOutputCard(4, "Tech Stack Agent", "<pre>" + esc(saved.stack) + "</pre>", {
      agent: "stack",
      copyText: saved.stack
    });
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
    $("#f-github").value = draft.github || "";
    $("#f-idea").value = draft.idea || "";
    $("#f-deadline").value = draft.deadline || "";
    $("#f-comfort").value = draft.comfort || "beginner";
  }

  form.addEventListener("input", debounce(writeDraft, 350));

  // ------------------------------------------------------------------------
  // Load example — one click to try the pipeline with sample data
  // ------------------------------------------------------------------------
  exampleBtn.addEventListener("click", function () {
    $("#f-name").value = "Ada";
    $("#f-stack").value = "python";
    $("#f-github").value = "octocat";
    $("#f-idea").value = "A CLI that turns meeting notes into action items, with a simple web dashboard.";
    $("#f-deadline").value = "4 weeks";
    $("#f-comfort").value = "intermediate";
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

    // 3 — Architecture Agent
    setStepState("architecture", "running");
    setStatus("running", "architecture agent…");
    await sleep(900);
    var archText = architectureAgentText(input);
    addOutputCard(3, "Architecture Agent", "<pre>" + esc(archText) + "</pre>", {
      agent: "architecture",
      copyText: archText
    });
    setStepState("architecture", "done");

    // 4 — Tech Stack Agent
    setStepState("stack", "running");
    setStatus("running", "tech stack agent…");
    await sleep(800);
    var stackText = stackAgentText(input);
    addOutputCard(4, "Tech Stack Agent", "<pre>" + esc(stackText) + "</pre>", {
      agent: "stack",
      copyText: stackText
    });
    setStepState("stack", "done");

    // 5 — AO Task Agent (assembles the copyable prompt)
    setStepState("task", "running");
    setStatus("running", "assembling AO task…");
    await sleep(800);
    var ctx = {
      name: input.name,
      idea: input.idea,
      deadline: input.deadline,
      comfort: input.comfort,
      githubFirstLine: ghText.split("\n")[0],
      stackLabel: (STACKS[input.stack] || STACKS.unsure).label,
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
        github: input.github,
        idea: input.idea,
        deadline: input.deadline,
        comfort: input.comfort,
        time: new Date().toLocaleString(),
        outputs: {
          github: { text: ghText, badge: ghBadge },
          research: researchText,
          architecture: archText,
          stack: stackText,
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
  // Landing screen — one-section welcome that hands off to the workspace
  // ------------------------------------------------------------------------
  var LANDING_STEPS = ["github", "research", "architecture", "stack", "task"];
  var motionOk = !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function setLandingStep(step, state) {
    var li = landingSteps && landingSteps.querySelector('[data-preview="' + step + '"]');
    if (!li) return;
    li.classList.remove("is-running", "is-done");
    if (state === "running") li.classList.add("is-running");
    if (state === "done") li.classList.add("is-done");
    var status = li.querySelector(".lstep-status");
    status.textContent = state === "running"
      ? "running…"
      : state === "done"
        ? (step === "task" ? "prompt ready" : "done")
        : "ready";
  }

  // Mini demo: walk through the five agents exactly like the real pipeline.
  function previewPipeline() {
    if (!landingPreview || landingPreview.disabled) return;
    landingPreview.disabled = true;
    LANDING_STEPS.forEach(function (s) { setLandingStep(s, "ready"); });
    var unit = motionOk ? 480 : 150;
    var t = 0;
    LANDING_STEPS.forEach(function (step, i) {
      t += unit;
      setTimeout(function () { setLandingStep(step, "running"); }, t);
      t += Math.round(unit * 1.4);
      setTimeout(function () {
        setLandingStep(step, "done");
        if (i === LANDING_STEPS.length - 1) {
          landingPreview.disabled = false;
          landingPreview.textContent = "Replay the pipeline";
        }
      }, t);
    });
  }

  // Hand off: fade the landing out, reveal + focus the workspace.
  function enterWorkspace() {
    if (!landingEl || landingEl.hidden) return;
    landingEl.classList.add("is-leaving");
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      landingEl.hidden = true;
      if (appEl) appEl.inert = false;
      window.scrollTo(0, 0);
      var nameField = $("#f-name");
      if (nameField) nameField.focus();
      toast("Welcome to the workspace — fill the form and run the pipeline.");
    };
    // transitionend covers the fade; the timeout is a safety net (incl. reduced motion).
    landingEl.addEventListener("transitionend", function (e) {
      if (e.target === landingEl) finish();
    });
    setTimeout(finish, motionOk ? 450 : 0);
  }

  if (landingEnter) landingEnter.addEventListener("click", enterWorkspace);
  if (landingPreview) landingPreview.addEventListener("click", previewPipeline);

  // ------------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------------
  initTheme();
  restoreDraft();
  renderHistory();
  updateExportBtn();
  // The landing is the first screen; keep the workspace out of tab order until
  // "Enter the workspace" is clicked.
  if (landingEl && appEl) appEl.inert = true;
})();