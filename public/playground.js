// The flaky UI playground at /uiPlayground.
//
// Every case draws its timing from a PRNG seeded by (seed, case, run), not from
// Math.random. That is the whole point of the page: a UI test that failed on
// seed 481516 fails again on seed 481516, so the learner can watch the fragile
// version break, fix it, and prove the fix against the same timing. Re-running
// one case advances only that case's run number, so the others stay put.
//
// "stable" mode is not "instant": every delay collapses to its minimum and the
// surprises (inserted buttons, re-renders, shuffles, out-of-order responses) are
// switched off. A correct, robust test passes in both modes.
(function () {
  const params = new URLSearchParams(location.search);
  // Chaos controls on the page URL are forwarded to case 11's API call, so a
  // test can choose that case's outcome with nothing but page.goto().
  const FORWARD = ["_delay", "_status", "_fail_rate", "_scenario", "_retry_after", "_malformed"];

  let mode = params.get("mode") === "stable" ? "stable" : "flaky";
  let seed = parseSeed(params.get("seed"));
  if (seed === null) seed = Math.floor(Math.random() * 1e6);

  const runs = {};
  const timers = {};
  const templates = {};
  const cases = {};

  function parseSeed(v) {
    return v !== null && /^\d{1,9}$/.test(v) ? Number(v) : null;
  }

  // FNV-1a, then mulberry32. Small, fast, and identical in every browser.
  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setResult(node, text, tone) {
    node.textContent = text;
    node.classList.toggle("ok", tone === "ok");
    node.classList.toggle("bad", tone === "bad");
  }

  // Runs one case from a clean stage. Pending timers from the previous run are
  // cancelled, and alive() lets async work (a fetch) notice it was superseded.
  function run(name) {
    (timers[name] || []).forEach(clearTimeout);
    timers[name] = [];
    runs[name] = (runs[name] || 0) + 1;
    const gen = runs[name];
    const flaky = mode === "flaky";
    const rand = mulberry32(hash(`${seed}:${name}:${gen}`));
    const article = document.getElementById(name);
    const stage = article.querySelector(".stage");
    stage.innerHTML = templates[name];

    const c = {
      flaky,
      rand,
      stage,
      q: (id) => stage.querySelector(`[data-testid="${id}"]`),
      between: (min, max) => (flaky ? Math.round(min + rand() * (max - min)) : min),
      chance: (p) => flaky && rand() < p,
      alive: () => runs[name] === gen,
      later(ms, fn) {
        const id = setTimeout(() => { if (runs[name] === gen) fn(); }, ms);
        timers[name].push(id);
        return id;
      },
    };
    cases[name](c);
  }

  function runAll() {
    Object.keys(cases).forEach(run);
  }

  const PEOPLE = [
    "Leanne Graham", "Ervin Howell", "Clementine Bauch", "Patricia Lebsack", "Chelsey Dietrich",
    "Mrs. Dennis Schulist", "Kurtis Weissnat", "Nicholas Runolfsdottir V", "Glenna Reichert", "Clementina DuBuque",
  ];

  // 1 — late element
  cases.late = (c) => {
    c.later(c.between(500, 4000), () => {
      c.stage.append(el("p", { "data-testid": "late-message", class: "pg-result" }, "Welcome back, Leanne"));
    });
  };

  // 2 — enabled late
  cases.disabled = (c) => {
    const btn = c.q("disabled-submit");
    const result = c.q("disabled-result");
    btn.addEventListener("click", () => setResult(result, "Submitted", "ok"));
    c.later(c.between(400, 3500), () => {
      c.q("disabled-check").textContent = "Address looks good";
      btn.disabled = false;
    });
  };

  // 3 — overlay
  cases.overlay = (c) => {
    const result = c.q("overlay-result");
    let paid = 0;
    c.q("overlay-pay").addEventListener("click", () => setResult(result, `Paid (${++paid})`, "ok"));
    c.later(c.between(300, 3500), () => { c.q("overlay-veil").hidden = true; });
  };

  // 4 — layout shift
  cases.shift = (c) => {
    const stack = c.q("shift-buttons");
    const result = c.q("shift-result");
    const confirm = c.q("shift-confirm");
    confirm.addEventListener("click", () => setResult(result, "Order confirmed", "ok"));
    const insertCancel = () => {
      const cancel = el("button", { type: "button", class: "danger", "data-testid": "shift-cancel" }, "Cancel order");
      cancel.addEventListener("click", () => setResult(result, "Order cancelled", "bad"));
      stack.insertBefore(cancel, confirm);
    };
    // Without chaos the page simply renders both; the shift is the chaos.
    if (c.flaky) c.later(c.between(300, 2000), insertCancel);
    else insertCancel();
  };

  // 5 — stale element
  cases.stale = (c) => {
    const list = c.q("stale-rows");
    const result = c.q("stale-result");
    const counter = c.q("stale-renders");
    let renders = 0;
    const render = () => {
      // replaceChildren with new nodes on purpose: same text, different elements.
      list.replaceChildren(...PEOPLE.slice(0, 3).map((name) => {
        const li = el("li", {}, name);
        const btn = el("button", { type: "button" }, "Select");
        btn.addEventListener("click", () => setResult(result, `Selected: ${name}`, "ok"));
        li.append(btn);
        return li;
      }));
      renders++;
      counter.textContent = `Rendered ${renders} time${renders === 1 ? "" : "s"}`;
      if (c.flaky) c.later(c.between(900, 2200), render);
    };
    render();
  };

  // 6 — premature text
  cases.text = (c) => {
    const status = c.q("text-status");
    const count = c.q("text-count");
    let saves = 0;
    c.q("text-save").addEventListener("click", () => {
      c.later(c.between(0, 700), () => {
        status.textContent = "Saving…";
        c.later(c.between(500, 1500), () => {
          status.textContent = "All changes saved";
          saves++;
          count.textContent = `Saved ${saves} time${saves === 1 ? "" : "s"}`;
        });
      });
    });
  };

  // 7 — vanishing toast
  cases.toast = (c) => {
    const area = c.q("toast-area");
    c.q("toast-copy").addEventListener("click", () => {
      c.later(c.between(100, 800), () => {
        const toast = el("div", { class: "pg-toast", "data-testid": "toast", role: "status" }, "Link copied");
        area.replaceChildren(toast);
        c.later(1500, () => toast.remove());
      });
    });
  };

  // 8 — shuffled list
  cases.shuffle = (c) => {
    const items = ["Monitor", "Mouse", "Keyboard", "Webcam", "Headset"];
    if (c.flaky) {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(c.rand() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
    }
    const result = c.q("shuffle-result");
    c.q("shuffle-list").replaceChildren(...items.map((item) => {
      const li = el("li", {}, item);
      const btn = el("button", { type: "button" }, "Add");
      btn.addEventListener("click", () => setResult(result, `Cart: ${item}`, "ok"));
      li.append(btn);
      return li;
    }));
  };

  // 9 — dynamic ids
  cases.dynid = (c) => {
    const hex = (n) => Array.from({ length: n }, () => Math.floor(c.rand() * 16).toString(16)).join("");
    const id = c.flaky ? `btn-${hex(5)}` : "btn-00000";
    const cls = c.flaky ? `css-${hex(6)}` : "css-000000";
    const btn = c.q("dynid-button");
    btn.id = id;
    btn.className = cls;
    c.q("dynid-attrs").textContent = `id="${id}" class="${cls}"`;
    btn.addEventListener("click", () => setResult(c.q("dynid-result"), "Invoice downloaded", "ok"));
  };

  // 10 — moving target
  cases.animate = (c) => {
    const drawer = c.q("animate-drawer");
    c.q("animate-discard").addEventListener("click", () => setResult(c.q("animate-result"), "Changes discarded", "ok"));
    // With no transition, transitionend never fires, so those paths set the end state directly.
    if (!c.flaky || reducedMotion.matches) {
      drawer.classList.add("instant");
      drawer.dataset.state = "open";
      return;
    }
    drawer.addEventListener("transitionend", () => { drawer.dataset.state = "open"; }, { once: true });
    c.later(c.between(200, 1500), () => { drawer.dataset.state = "opening"; });
  };

  // 11 — flaky network, against the real API
  cases.network = (c) => {
    const card = c.q("network-card");
    const urlLabel = document.getElementById("network-url");
    const forwarded = new URLSearchParams();
    for (const k of FORWARD) if (params.has(k)) forwarded.set(k, params.get(k));

    const load = () => {
      // Forwarded controls win outright. Otherwise the outcome comes from the
      // seeded PRNG rather than the API's own _fail_rate, which is random on
      // the server and would make a seed stop reproducing.
      let query = forwarded;
      if (![...forwarded.keys()].length && c.flaky) {
        query = new URLSearchParams({ _delay: String(c.between(0, 2000)) });
        if (c.chance(0.4)) query.set("_status", "503");
      }
      const url = "/v1/users/1" + (query.toString() ? `?${query}` : "");
      urlLabel.textContent = url;
      card.setAttribute("aria-busy", "true");
      card.replaceChildren(
        el("div", { class: "pg-skeleton", "data-testid": "network-skeleton" }),
        el("div", { class: "pg-skeleton short" })
      );
      fetch(url, { headers: { accept: "application/json" } })
        .then(async (res) => {
          if (!c.alive()) return;
          if (!res.ok) throw new Error(String(res.status));
          const user = await res.json();
          if (!c.alive()) return;
          card.replaceChildren(
            el("p", { class: "name", "data-testid": "network-name" }, user.name),
            el("p", { class: "pg-state", "data-testid": "network-email" }, user.email)
          );
        })
        .catch((err) => {
          if (!c.alive()) return;
          const status = /^\d{3}$/.test(err.message) ? ` (${err.message})` : "";
          const retry = el("button", { type: "button", "data-testid": "network-retry" }, "Retry");
          retry.addEventListener("click", load);
          card.replaceChildren(el("p", { class: "err", "data-testid": "network-error" }, `Couldn't load this user${status}.`), retry);
        })
        .finally(() => { if (c.alive()) card.setAttribute("aria-busy", "false"); });
    };
    load();
  };

  // 12 — infinite scroll
  cases.scroll = (c) => {
    const feed = c.q("scroll-feed");
    const count = c.q("scroll-count");
    const PAGE = 10, MAX = 60;
    let loaded = 0, loading = false;
    const label = () => {
      count.textContent = `${loaded} rows loaded${loading ? " · loading more…" : loaded >= MAX ? " · end of feed" : ""}`;
    };
    const append = () => {
      for (let i = 0; i < PAGE; i++) feed.append(el("li", {}, `Row ${++loaded}`));
    };
    append();
    label();
    feed.addEventListener("scroll", () => {
      if (loading || loaded >= MAX) return;
      if (feed.scrollTop + feed.clientHeight < feed.scrollHeight - 4) return;
      loading = true;
      label();
      c.later(c.between(300, 1800), () => { append(); loading = false; label(); });
    });
  };

  // 13 — debounced search with out-of-order responses
  cases.search = (c) => {
    const input = c.q("search-input");
    const list = c.q("search-results");
    let debounce = 0, sent = 0, applied = 0;
    input.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = c.later(300, () => {
        const seq = ++sent;
        const query = input.value.trim().toLowerCase();
        // A newer response is never overwritten by an older one, so the list
        // always ends up right — but an older one can land first and show for a while.
        c.later(c.between(150, 1400), () => {
          if (seq < applied) return;
          applied = seq;
          const hits = query ? PEOPLE.filter((p) => p.toLowerCase().includes(query)) : [];
          list.dataset.query = query;
          list.replaceChildren(...hits.map((p) => el("li", {}, p)));
        });
      });
    });
  };

  // 14 — shadow DOM, rendered late
  customElements.define("flaky-subscribe", class extends HTMLElement {});
  cases.shadow = (c) => {
    const host = c.q("shadow-host");
    c.later(c.between(500, 3000), () => {
      const root = host.attachShadow({ mode: "open" });
      const wrap = el("div", { class: "pg-sub" });
      const btn = el("button", { type: "button" }, "Subscribe");
      btn.addEventListener("click", () => setResult(c.q("shadow-result"), "Subscribed", "ok"));
      wrap.append(el("span", {}, "Weekly digest"), btn);
      // The page's own <link> URLs, which carry the version stamp. A bare
      // /app.css would be served from a year-long cache after a deploy.
      const sheet = (name) => document.querySelector(`link[href^="/${name}"]`)?.getAttribute("href") || `/${name}`;
      root.append(
        el("link", { rel: "stylesheet", href: sheet("app.css") }),
        el("link", { rel: "stylesheet", href: sheet("playground.css") }),
        wrap
      );
    });
  };

  // ── controls ──
  const modeSel = document.getElementById("mode");
  const seedInput = document.getElementById("seed");
  const repro = document.getElementById("repro");

  function syncUrl() {
    const next = new URLSearchParams(location.search);
    next.set("seed", String(seed));
    if (mode === "stable") next.set("mode", "stable"); else next.delete("mode");
    const path = `${location.pathname}?${next}`;
    try { history.replaceState(null, "", path + location.hash); } catch { /* sandboxed frame */ }
    repro.textContent = path;
    modeSel.value = mode;
    seedInput.value = String(seed);
  }

  function restart() {
    for (const k of Object.keys(runs)) delete runs[k];
    syncUrl();
    runAll();
  }

  modeSel.addEventListener("change", () => { mode = modeSel.value === "stable" ? "stable" : "flaky"; restart(); });
  seedInput.addEventListener("change", () => {
    const next = parseSeed(seedInput.value.trim());
    if (next === null) { seedInput.value = String(seed); return; }
    seed = next;
    restart();
  });
  document.getElementById("new-seed").addEventListener("click", () => { seed = Math.floor(Math.random() * 1e6); restart(); });
  document.getElementById("rerun-all").addEventListener("click", runAll);

  for (const name of Object.keys(cases)) {
    const article = document.getElementById(name);
    templates[name] = article.querySelector(".stage").innerHTML;
    article.querySelector("[data-rerun]").addEventListener("click", () => run(name));
  }

  restart();
})();
