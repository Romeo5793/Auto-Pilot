/**
 * Auto-Pilot 共通コア
 * - API通信 / Toast / ストレージ / リトライ / キャッシュ
 * index.html と gemini-code-*.js の両方から利用
 */
(function (global) {
  "use strict";

  const STORAGE_KEYS = {
    gemini: "autopilot_api_key",
    geminiLegacy: "gemini_api_key",
    finnhub: "finnhub_api_key",
    alpha: "alphavantage_api_key",
    tavily: "tavily_api_key",
    assets: "my_assets_v1",
    cachePrefix: "cache_",
  };

  const APP_STORAGE_KEYS = [
    STORAGE_KEYS.gemini,
    STORAGE_KEYS.geminiLegacy,
    STORAGE_KEYS.finnhub,
    STORAGE_KEYS.alpha,
    STORAGE_KEYS.tavily,
    STORAGE_KEYS.assets,
  ];

  const GEMINI_MODELS = [
    "gemini-3.5-flash",
    "gemini-2.5-flash",
    "gemini-3.1-flash-lite",
  ];

  const CACHE_TTL_MS = 15 * 60 * 1000;
  const CACHE_MAX_ENTRIES = 40;
  const FETCH_CONCURRENCY = 3;
  const GEMINI_MAX_ROUNDS = 2;
  const GEMINI_BASE_DELAY_MS = 800;

  const DISCOVER_RESPONSE_SCHEMA = {
    type: "OBJECT",
    properties: {
      marketSignal: {
        type: "OBJECT",
        properties: {
          phase: {
            type: "STRING",
            format: "enum",
            enum: ["STRONG_BUY", "BUY", "NEUTRAL", "SELL", "STRONG_SELL"],
          },
          reason: { type: "STRING" },
        },
        required: ["phase", "reason"],
      },
      sectorHeatmap: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            sectorName: { type: "STRING" },
            heat: {
              type: "STRING",
              format: "enum",
              enum: ["HOT", "WARM", "COLD"],
            },
            reason: { type: "STRING" },
          },
          required: ["sectorName", "heat", "reason"],
        },
      },
      ranking20: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            rank: { type: "INTEGER" },
            ticker: { type: "STRING" },
            companyName: { type: "STRING" },
            sector: { type: "STRING" },
            score: { type: "INTEGER" },
            reason: { type: "STRING" },
          },
          required: ["rank", "ticker", "companyName", "sector", "score", "reason"],
        },
      },
    },
    required: ["marketSignal", "sectorHeatmap", "ranking20"],
  };

  const PORTFOLIO_SCAN_RESPONSE_SCHEMA = {
    type: "OBJECT",
    properties: {
      correlationRisk: { type: "STRING" },
      individualVerdicts: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            ticker: { type: "STRING" },
            verdict: {
              type: "STRING",
              format: "enum",
              enum: ["BUY", "HOLD", "SELL"],
            },
            advice: { type: "STRING" },
          },
          required: ["ticker", "verdict", "advice"],
        },
      },
    },
    required: ["correlationRisk", "individualVerdicts"],
  };

  const DEEP_SCAN_RESPONSE_SCHEMA = {
    type: "OBJECT",
    properties: {
      geniusView: { type: "STRING" },
      veteranView: { type: "STRING" },
      macroView: { type: "STRING" },
      quantView: { type: "STRING" },
      finalVerdict: {
        type: "OBJECT",
        properties: {
          decision: {
            type: "STRING",
            format: "enum",
            enum: ["BUY", "HOLD", "SELL"],
          },
          conclusion: { type: "STRING" },
        },
        required: ["decision", "conclusion"],
      },
      radarScores: {
        type: "OBJECT",
        properties: {
          growth: { type: "INTEGER" },
          value: { type: "INTEGER" },
          momentum: { type: "INTEGER" },
          safety: { type: "INTEGER" },
          macroTailwind: { type: "INTEGER" },
        },
        required: ["growth", "value", "momentum", "safety", "macroTailwind"],
      },
    },
    required: [
      "geniusView",
      "veteranView",
      "macroView",
      "quantView",
      "finalVerdict",
      "radarScores",
    ],
  };

  const ANALYSIS_RESPONSE_SCHEMA = PORTFOLIO_SCAN_RESPONSE_SCHEMA;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function safeJsonParse(text, fallback) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return fallback;
    }
  }

  function getStorage(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return raw;
    } catch (_) {
      return fallback;
    }
  }

  function setStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  function removeStorage(key) {
    try {
      localStorage.removeItem(key);
    } catch (_) {
      /* ignore */
    }
  }

  function getGeminiApiKey() {
    return (
      getStorage(STORAGE_KEYS.gemini, "") ||
      getStorage(STORAGE_KEYS.geminiLegacy, "") ||
      ""
    );
  }

  function setGeminiApiKey(value) {
    setStorage(STORAGE_KEYS.gemini, value);
    // 旧キー互換を維持しつつ正規キーへ寄せる
    if (getStorage(STORAGE_KEYS.geminiLegacy)) {
      removeStorage(STORAGE_KEYS.geminiLegacy);
    }
  }

  function getApiKeys() {
    return {
      gemini: getGeminiApiKey(),
      finnhub: getStorage(STORAGE_KEYS.finnhub, "") || "",
      alpha: getStorage(STORAGE_KEYS.alpha, "") || "",
      tavily: getStorage(STORAGE_KEYS.tavily, "") || "",
    };
  }

  function clearAppStorage() {
    APP_STORAGE_KEYS.forEach(removeStorage);
    // 期限切れ・銘柄キャッシュも掃除
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(STORAGE_KEYS.cachePrefix)) toRemove.push(key);
      }
      toRemove.forEach(removeStorage);
    } catch (_) {
      /* ignore */
    }
  }

  function getMyAssets() {
    const raw = getStorage(STORAGE_KEYS.assets, "[]");
    const parsed = safeJsonParse(raw, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  function saveMyAssets(assets) {
    setStorage(STORAGE_KEYS.assets, JSON.stringify(assets || []));
  }

  function pruneCaches() {
    try {
      const entries = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(STORAGE_KEYS.cachePrefix)) continue;
        const parsed = safeJsonParse(getStorage(key, ""), null);
        const ts = parsed && typeof parsed.timestamp === "number" ? parsed.timestamp : 0;
        if (!parsed || Date.now() - ts >= CACHE_TTL_MS) {
          removeStorage(key);
        } else {
          entries.push({ key, ts });
        }
      }
      entries.sort((a, b) => a.ts - b.ts);
      while (entries.length > CACHE_MAX_ENTRIES) {
        const oldest = entries.shift();
        if (oldest) removeStorage(oldest.key);
      }
    } catch (_) {
      /* ignore */
    }
  }

  function readTickerCache(ticker) {
    pruneCaches();
    const key = STORAGE_KEYS.cachePrefix + ticker;
    const parsed = safeJsonParse(getStorage(key, ""), null);
    if (!parsed || typeof parsed.timestamp !== "number") return null;
    if (Date.now() - parsed.timestamp >= CACHE_TTL_MS) {
      removeStorage(key);
      return null;
    }
    return parsed.data || null;
  }

  function writeTickerCache(ticker, data) {
    const key = STORAGE_KEYS.cachePrefix + ticker;
    setStorage(key, JSON.stringify({ timestamp: Date.now(), data }));
    pruneCaches();
  }

  let toastTimer = null;

  function ensureToastContainer() {
    let container = document.getElementById("toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      container.setAttribute("aria-live", "polite");
      container.setAttribute("aria-atomic", "true");
      document.body.appendChild(container);
    }
    return container;
  }

  function clearToasts() {
    const container = document.getElementById("toast-container");
    if (!container) return;
    container.innerHTML = "";
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  function friendlyErrorMessage(error) {
    if (error && error.name === "AbortError") {
      return "処理をキャンセルしました。";
    }
    const msg = error && error.message ? String(error.message) : String(error || "");
    if (/429|503|混み合|RETRY|busy|quota|rate limit/i.test(msg)) {
      return "現在データ取得元が混み合っています。少し待ってから再度お試しください。";
    }
    if (/Failed to fetch|network|通信|NetworkError/i.test(msg)) {
      return "通信に失敗しました。インターネット接続を確認して、もう一度お試しください。";
    }
    if (/API Error|APIキー|api key|401|403/i.test(msg)) {
      return "データ取得に失敗しました。APIキー設定をご確認のうえ、再度お試しください。";
    }
    if (/JSON|Structured|パース|応答が空/i.test(msg)) {
      return "結果の読み取りに失敗しました。少し時間をおいて再度お試しください。";
    }
    return msg || "うまく処理できませんでした。もう一度お試しください。";
  }

  function showToast(message, type, durationMs) {
    type = type || "info";
    durationMs = durationMs == null ? 5500 : durationMs;
    const container = ensureToastContainer();
    clearToasts();

    const banner = document.createElement("div");
    const typeClass =
      type === "error" ? "toast-error" : type === "success" ? "toast-success" : "toast-info";
    banner.className = "toast-banner " + typeClass;

    const icon = document.createElement("i");
    icon.setAttribute(
      "data-lucide",
      type === "error" ? "alert-circle" : type === "success" ? "check-circle" : "info"
    );
    icon.className = "w-6 h-6 flex-shrink-0 mt-0.5";

    const text = document.createElement("span");
    text.className = "flex-grow";
    text.textContent = String(message || "");

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "toast-close";
    closeBtn.setAttribute("aria-label", "閉じる");
    const closeIcon = document.createElement("i");
    closeIcon.setAttribute("data-lucide", "x");
    closeIcon.className = "w-5 h-5";
    closeBtn.appendChild(closeIcon);

    banner.appendChild(icon);
    banner.appendChild(text);
    banner.appendChild(closeBtn);

    const close = () => {
      banner.classList.remove("show");
      setTimeout(() => banner.remove(), 350);
    };
    closeBtn.addEventListener("click", close);
    container.appendChild(banner);

    if (typeof lucide !== "undefined" && lucide.createIcons) {
      lucide.createIcons({ nodes: [banner] });
    }
    requestAnimationFrame(() => banner.classList.add("show"));
    toastTimer = setTimeout(close, durationMs);
  }

  function createIconsIn(root) {
    if (typeof lucide === "undefined" || !lucide.createIcons) return;
    try {
      if (root) lucide.createIcons({ nodes: [root] });
      else lucide.createIcons();
    } catch (_) {
      try {
        lucide.createIcons();
      } catch (__) {
        /* ignore */
      }
    }
  }

  async function fetchJson(url, options) {
    options = options || {};
    const res = await fetch(url, options);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error("API Error: " + res.status + " " + errText.slice(0, 300));
    }
    return res.json();
  }

  async function fetchFinnhubData(ticker, apiKeys, signal) {
    const key = (apiKeys && apiKeys.finnhub) || getApiKeys().finnhub;
    if (!key) throw new Error("Finnhub APIキーが未設定です。");
    const data = await fetchJson(
      "https://finnhub.io/api/v1/quote?symbol=" +
        encodeURIComponent(ticker) +
        "&token=" +
        encodeURIComponent(key),
      { signal: signal }
    );
    if (data.c === 0 && data.d == null) return "データなし";
    return "現在値: $" + data.c + ", 前日比: $" + data.d + " (" + data.dp + "%)";
  }

  async function fetchAlphaVantageData(ticker, apiKeys, signal) {
    const key = (apiKeys && apiKeys.alpha) || getApiKeys().alpha;
    if (!key) throw new Error("Alpha Vantage APIキーが未設定です。");
    const data = await fetchJson(
      "https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=" +
        encodeURIComponent(ticker) +
        ".TOK&apikey=" +
        encodeURIComponent(key),
      { signal: signal }
    );
    const quote = data["Global Quote"];
    if (quote && quote["05. price"]) {
      return "現在値: ¥" + quote["05. price"] + ", 前日比: " + quote["09. change"];
    }
    if (data.Note || data.Information) {
      throw new Error("現在データ取得元が混み合っています。少し待ってから再度お試しください。");
    }
    return "データなし";
  }

  async function fetchTavilyNews(query, apiKeys, signal) {
    const key = (apiKeys && apiKeys.tavily) || getApiKeys().tavily;
    if (!key) throw new Error("Tavily APIキーが未設定です。");
    const data = await fetchJson("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query: query,
        include_answer: true,
        days_back: 3,
      }),
      signal: signal,
    });
    return data.answer || "関連ニュースなし";
  }

  function parseStructuredResponse(apiResult) {
    const cand = apiResult && apiResult.candidates && apiResult.candidates[0];
    if (!cand) {
      const block =
        apiResult &&
        apiResult.promptFeedback &&
        apiResult.promptFeedback.blockReason;
      throw new Error(
        block
          ? "AI応答がブロックされました: " + block
          : "AIからの応答が空です。"
      );
    }
    if (cand.finishReason && /SAFETY|BLOCK|RECITATION/i.test(cand.finishReason)) {
      throw new Error("AI応答が制限されました: " + cand.finishReason);
    }
    const text =
      cand.content &&
      cand.content.parts &&
      cand.content.parts[0] &&
      cand.content.parts[0].text;
    if (!text) throw new Error("AIからの応答が空です。");
    const parsed = safeJsonParse(text, null);
    if (parsed == null) {
      throw new Error("Structured Output の JSON パースに失敗しました。");
    }
    return parsed;
  }

  function getCandidateText(apiResult) {
    return (
      apiResult &&
      apiResult.candidates &&
      apiResult.candidates[0] &&
      apiResult.candidates[0].content &&
      apiResult.candidates[0].content.parts &&
      apiResult.candidates[0].content.parts[0] &&
      apiResult.candidates[0].content.parts[0].text
    ) || "";
  }

  async function callGeminiAPI(payload, options) {
    options = options || {};
    const apiKey = options.apiKey || getGeminiApiKey();
    if (!apiKey) throw new Error("Gemini APIキーが未設定です。");
    const signal = options.signal;
    const models = options.models || GEMINI_MODELS;
    const maxRounds = options.maxRounds || GEMINI_MAX_ROUNDS;

    // 呼び出し元のオブジェクトを破壊しない
    const body = Object.assign({}, payload);
    if (body.tools) delete body.tools;
    const bodyText = JSON.stringify(body);

    let lastError = null;
    for (let round = 0; round < maxRounds; round++) {
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        const url =
          "https://generativelanguage.googleapis.com/v1beta/models/" +
          model +
          ":generateContent?key=" +
          encodeURIComponent(apiKey);
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: bodyText,
            signal: signal,
          });
          if (!response.ok) {
            const errText = await response.text().catch(() => "");
            if (response.status === 429 || response.status === 503) {
              lastError = new Error("RETRY");
              const delay = GEMINI_BASE_DELAY_MS * Math.pow(2, round) + i * 200;
              await sleep(delay);
              continue;
            }
            throw new Error("API Error: " + response.status + " " + errText.slice(0, 400));
          }
          return await response.json();
        } catch (e) {
          if (e && e.name === "AbortError") throw e;
          if (e && e.message === "RETRY") {
            lastError = e;
            continue;
          }
          // 一時的なネットワーク失敗も短い待機後に次モデルへ
          if (/Failed to fetch|NetworkError/i.test(String(e && e.message))) {
            lastError = e;
            await sleep(GEMINI_BASE_DELAY_MS);
            continue;
          }
          throw e;
        }
      }
    }
    throw (
      lastError && lastError.message !== "RETRY"
        ? lastError
        : new Error("現在データ取得元が混み合っています。少し待ってから再度お試しください。")
    );
  }

  async function mapPool(items, concurrency, iterator) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < items.length) {
        const current = nextIndex++;
        results[current] = await iterator(items[current], current);
      }
    }

    const workers = [];
    const n = Math.min(concurrency, Math.max(items.length, 1));
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  function isUsTicker(ticker) {
    return /^[A-Z]+$/.test(String(ticker || ""));
  }

  function isJapaneseTicker(ticker) {
    return /^\d{4}$/.test(String(ticker || ""));
  }

  function scoreOrDefault(value, fallback) {
    fallback = fallback == null ? 50 : fallback;
    return Number.isFinite(value) ? value : fallback;
  }

  function applyVerdictStyle(el, verdict) {
    if (!el) return;
    el.classList.remove(
      "verdict-buy",
      "verdict-sell",
      "verdict-hold",
      "bg-slate-800",
      "border-slate-500",
      "text-slate-200"
    );
    const v = String(verdict || "").toUpperCase();
    el.textContent = v || "未診断";
    if (v === "BUY" || v === "STRONG_BUY") {
      el.classList.add("verdict-buy", "text-xl", "font-black");
    } else if (v === "SELL" || v === "STRONG_SELL") {
      el.classList.add("verdict-sell", "text-xl", "font-black");
    } else if (v === "HOLD" || v === "NEUTRAL") {
      el.classList.add("verdict-hold", "text-xl", "font-black");
    } else {
      el.classList.add(
        "bg-slate-800",
        "border-slate-500",
        "text-slate-200",
        "text-xl",
        "font-black"
      );
    }
  }

  function createAbortBundle() {
    const controller = new AbortController();
    return {
      controller: controller,
      signal: controller.signal,
      abort: function () {
        try {
          controller.abort();
        } catch (_) {
          /* ignore */
        }
      },
    };
  }

  global.AutoPilotCore = {
    STORAGE_KEYS: STORAGE_KEYS,
    GEMINI_MODELS: GEMINI_MODELS,
    CACHE_TTL_MS: CACHE_TTL_MS,
    FETCH_CONCURRENCY: FETCH_CONCURRENCY,
    DISCOVER_RESPONSE_SCHEMA: DISCOVER_RESPONSE_SCHEMA,
    PORTFOLIO_SCAN_RESPONSE_SCHEMA: PORTFOLIO_SCAN_RESPONSE_SCHEMA,
    DEEP_SCAN_RESPONSE_SCHEMA: DEEP_SCAN_RESPONSE_SCHEMA,
    ANALYSIS_RESPONSE_SCHEMA: ANALYSIS_RESPONSE_SCHEMA,
    sleep: sleep,
    safeJsonParse: safeJsonParse,
    getStorage: getStorage,
    setStorage: setStorage,
    getGeminiApiKey: getGeminiApiKey,
    setGeminiApiKey: setGeminiApiKey,
    getApiKeys: getApiKeys,
    clearAppStorage: clearAppStorage,
    getMyAssets: getMyAssets,
    saveMyAssets: saveMyAssets,
    readTickerCache: readTickerCache,
    writeTickerCache: writeTickerCache,
    pruneCaches: pruneCaches,
    showToast: showToast,
    clearToasts: clearToasts,
    friendlyErrorMessage: friendlyErrorMessage,
    createIconsIn: createIconsIn,
    fetchFinnhubData: fetchFinnhubData,
    fetchAlphaVantageData: fetchAlphaVantageData,
    fetchTavilyNews: fetchTavilyNews,
    parseStructuredResponse: parseStructuredResponse,
    getCandidateText: getCandidateText,
    callGeminiAPI: callGeminiAPI,
    mapPool: mapPool,
    isUsTicker: isUsTicker,
    isJapaneseTicker: isJapaneseTicker,
    scoreOrDefault: scoreOrDefault,
    applyVerdictStyle: applyVerdictStyle,
    createAbortBundle: createAbortBundle,
  };
})(typeof window !== "undefined" ? window : globalThis);
