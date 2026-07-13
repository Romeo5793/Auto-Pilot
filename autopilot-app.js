/**
 * Auto-Pilot UI アプリケーション
 * 依存: autopilot-core.js / lucide / chart.js
 */
(function () {
  "use strict";

  const C = window.AutoPilotCore;
  if (!C) {
    console.error("AutoPilotCore が読み込まれていません。");
    return;
  }

  let apiKeys = C.getApiKeys();
  let currentRadarChart = null;
  let activeJobs = {
    discover: null,
    portfolio: null,
    deepScan: null,
    whyMoved: null,
  };

  function refreshApiKeys() {
    apiKeys = C.getApiKeys();
    return apiKeys;
  }

  function guardBeforeNetwork() {
    refreshApiKeys();
    C.assertOnline();
    return C.requireCompleteApiKeys(apiKeys);
  }

  function handleCaughtError(error, fallbackUi) {
    if (C.isAbortError(error)) return;
    C.showToast(C.friendlyErrorMessage(error), "error");
    if (typeof fallbackUi === "function") {
      try {
        fallbackUi();
      } catch (_) {
        /* ignore */
      }
    }
  }

  function abortJob(name) {
    if (activeJobs[name]) {
      activeJobs[name].abort();
      activeJobs[name] = null;
    }
  }

  function beginJob(name) {
    abortJob(name);
    const bundle = C.createAbortBundle();
    activeJobs[name] = bundle;
    return bundle;
  }

  function endJob(name, bundle) {
    if (activeJobs[name] === bundle) activeJobs[name] = null;
  }

  function checkAuth() {
    refreshApiKeys();
    const overlay = document.getElementById("auth-overlay");
    if (!overlay) return;
    const ready = apiKeys.gemini && apiKeys.finnhub && apiKeys.alpha && apiKeys.tavily;
    if (!ready) {
      const g = document.getElementById("api-key-gemini");
      const f = document.getElementById("api-key-finnhub");
      const a = document.getElementById("api-key-alpha");
      const t = document.getElementById("api-key-tavily");
      if (g) g.value = apiKeys.gemini;
      if (f) f.value = apiKeys.finnhub;
      if (a) a.value = apiKeys.alpha;
      if (t) t.value = apiKeys.tavily;
      overlay.classList.remove("hidden");
      overlay.classList.add("flex");
    } else {
      overlay.classList.add("hidden");
      overlay.classList.remove("flex");
    }
  }

  function saveApiKeys() {
    const gemini = (document.getElementById("api-key-gemini").value || "").trim();
    const finnhub = (document.getElementById("api-key-finnhub").value || "").trim();
    const alpha = (document.getElementById("api-key-alpha").value || "").trim();
    const tavily = (document.getElementById("api-key-tavily").value || "").trim();

    if (gemini && finnhub && alpha && tavily) {
      C.setGeminiApiKey(gemini);
      const ok =
        C.setStorage(C.STORAGE_KEYS.finnhub, finnhub) &&
        C.setStorage(C.STORAGE_KEYS.alpha, alpha) &&
        C.setStorage(C.STORAGE_KEYS.tavily, tavily);
      if (!ok) {
        C.showToast("APIキーの保存に失敗しました。端末の保存容量をご確認ください。", "error");
        return;
      }
      refreshApiKeys();
      C.showToast("APIキーを保存しました。", "success");
      checkAuth();
    } else {
      C.showToast("4つすべてのAPIキーを入力してください。右上のリンクから取得できます。", "error");
    }
  }

  function resetApiKey() {
    C.clearAppStorage();
    location.reload();
  }

  function switchMainTab(tabId) {
    document.querySelectorAll(".main-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    const tabBtn = document.querySelector('[data-tab="' + tabId + '"]');
    const panel = document.getElementById(tabId);
    if (tabBtn) tabBtn.classList.add("active");
    if (panel) panel.classList.add("active");
  }

  const loadingPanel = document.getElementById("loading-panel");

  function setLoading(visible, text) {
    if (!loadingPanel) return;
    if (visible) {
      loadingPanel.classList.remove("hidden");
      loadingPanel.classList.add("flex");
      if (text) {
        const el = document.getElementById("loading-text");
        if (el) el.textContent = text;
      }
    } else {
      loadingPanel.classList.add("hidden");
      loadingPanel.classList.remove("flex");
    }
  }

  function buildDiscoverConditions(isYutaiOnly, isUsStock) {
    const segment = document.getElementById("setting-segment").value;
    const timeframe = document.getElementById("setting-timeframe").value;
    const priceMin = (document.getElementById("setting-price-min").value || "").trim();
    const priceMax = (document.getElementById("setting-price-max").value || "").trim();
    const yieldTarget = (document.getElementById("setting-yield").value || "").trim();
    const yutaiGenre = document.getElementById("setting-yutai-genre").value;

    let text = "検索対象市場: " + (isUsStock ? "米国市場" : segment) + "\n";
    text += "対象期間: " + timeframe + "\n";
    if (priceMin || priceMax) {
      text += "株価レンジ: " + (priceMin || "下限なし") + " 〜 " + (priceMax || "上限なし") + "\n";
    }
    if (yieldTarget && Number(yieldTarget) > 0) {
      text += "目標配当利回り: " + yieldTarget + "%以上\n";
    }
    if (isYutaiOnly) {
      text += "優待重視: はい\n";
      text += "優待ジャンル: " + yutaiGenre + "\n";
    } else if (yutaiGenre && yutaiGenre !== "指定なし") {
      text += "優待ジャンル希望: " + yutaiGenre + "\n";
    }
    return { text: text, timeframe: timeframe, segment: segment };
  }

  async function startAutoPilotMultiStep(isUpdate, isYutaiOnly, isUsStock) {
    isYutaiOnly = !!isYutaiOnly;
    isUsStock = !!isUsStock;

    try {
      apiKeys = guardBeforeNetwork();
    } catch (error) {
      handleCaughtError(error, function () {
        checkAuth();
      });
      return;
    }

    const job = beginJob("discover");
    const conditions = buildDiscoverConditions(isYutaiOnly, isUsStock);

    const intro = document.getElementById("intro-panel");
    const discoverResults = document.getElementById("discover-results");
    if (intro) intro.style.display = "none";
    if (discoverResults) discoverResults.classList.add("hidden");
    setLoading(true, "外部APIから最新の市場ニュースを収集しています...");

    try {
      const newsQuery = isUsStock
        ? conditions.timeframe + " US stocks to buy market news"
        : conditions.segment + " おすすめ株 " + conditions.timeframe + " 最新ニュース";
      const newsContext = await C.fetchTavilyNews(newsQuery, apiKeys, job.signal);

      setLoading(true, "収集したニュースをAIが分析し、ランキングを生成しています...");

      const payload = {
        contents: [
          {
            parts: [
              {
                text:
                  "以下の検索条件と外部APIから取得した最新ニュースに基づいて分析してください。\n\n【最新ニュース】\n" +
                  newsContext +
                  "\n\n【検索条件】\n" +
                  conditions.text +
                  "\n【指示】\n1. 資金流入(HOT)と流出(COLD)のヒートマップを作成。\n2. 今の市場環境をSTRONG_BUY/BUY/NEUTRAL/SELL/STRONG_SELLの5段階で判定せよ。\n3. 条件を満たすおすすめランキングTOP20銘柄を作成。",
              },
            ],
          },
        ],
        systemInstruction: {
          parts: [
            {
              text: "プロのアナリストとして分析せよ。出力は Structured Outputs のスキーマに厳密に従うこと。",
            },
          ],
        },
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: C.DISCOVER_RESPONSE_SCHEMA,
        },
      };

      const result = await C.callGeminiAPI(payload, { apiKey: apiKeys.gemini, signal: job.signal });
      const finalData = C.assertDiscoverPayload(C.parseStructuredResponse(result));
      renderDiscoverResults(finalData);
      C.showToast("おすすめランキングの作成が完了しました。", "success");
    } catch (error) {
      handleCaughtError(error, function () {
        if (intro) intro.style.display = "block";
      });
    } finally {
      endJob("discover", job);
      setLoading(false);
    }
  }

  function renderDiscoverResults(data) {
    if (!data) return;

    if (data.marketSignal) {
      const signalColor = document.getElementById("signal-color");
      const signalText = document.getElementById("signal-text");
      const signalReason = document.getElementById("signal-reason");
      if (signalReason) signalReason.textContent = data.marketSignal.reason || "";
      if (signalColor) {
        signalColor.className =
          "w-20 h-20 rounded-full flex items-center justify-center mb-4 shadow-[0_0_30px_currentColor]";
      }
      const phase = data.marketSignal.phase || data.marketSignal.status || "";
      const label =
        phase === "STRONG_BUY"
          ? "爆買い推奨期"
          : phase === "BUY"
            ? "買い推奨期"
            : phase === "NEUTRAL"
              ? "中立・様子見"
              : phase === "SELL"
                ? "売り警戒期"
                : phase === "STRONG_SELL"
                  ? "即退避・売り期"
                  : phase || "---";
      const colorClass =
        phase === "STRONG_BUY"
          ? ["text-emerald-400", "bg-emerald-900/30"]
          : phase === "BUY"
            ? ["text-green-400", "bg-green-900/30"]
            : phase === "NEUTRAL"
              ? ["text-slate-200", "bg-slate-800/50"]
              : phase === "SELL"
                ? ["text-orange-400", "bg-orange-900/30"]
                : phase === "STRONG_SELL"
                  ? ["text-red-400", "bg-red-900/30"]
                  : ["text-purple-400", "bg-purple-900/30"];
      if (signalText) signalText.textContent = label;
      if (signalColor) signalColor.classList.add(colorClass[0], colorClass[1]);
    }

    const heatmapContainer = document.getElementById("heatmap-container");
    if (heatmapContainer) {
      heatmapContainer.innerHTML = "";
      const sectors = Array.isArray(data.sectorHeatmap) ? data.sectorHeatmap : [];
      sectors.forEach((sector) => {
        let hClass = "bg-slate-800";
        if (sector.heat === "HOT") hClass = "heat-hot";
        else if (sector.heat === "WARM") hClass = "heat-warm";
        else if (sector.heat === "COLD") hClass = "heat-cold";

        const div = document.createElement("div");
        div.className =
          "p-3 rounded-xl border flex flex-col justify-center items-center text-center " + hClass;
        const name = document.createElement("span");
        name.className = "text-base font-black text-white mb-1";
        name.textContent = sector.sectorName || "";
        const reason = document.createElement("span");
        reason.className = "text-sm text-slate-200 line-clamp-3";
        reason.textContent = sector.reason || "";
        div.appendChild(name);
        div.appendChild(reason);
        heatmapContainer.appendChild(div);
      });
    }

    const listContainer = document.getElementById("portfolio-list");
    if (listContainer) {
      listContainer.innerHTML = "";
      const ranking = Array.isArray(data.ranking20) ? data.ranking20 : [];
      const template = document.getElementById("ranking-card-template");
      if (!template) {
        C.showToast("画面テンプレートの読み込みに失敗しました。", "error");
        return;
      }
      ranking.forEach((item) => {
        const clone = template.content.cloneNode(true);
        const tickerEl = clone.querySelector(".ticker-text");
        const companyEl = clone.querySelector(".company-text");
        const reasonEl = clone.querySelector(".reason-text");
        if (tickerEl) tickerEl.textContent = item.ticker || "";
        if (companyEl) companyEl.textContent = item.companyName || "";
        if (reasonEl) reasonEl.textContent = item.reason || "";
        const deepBtn = clone.querySelector(".deep-scan-btn");
        if (deepBtn) {
          deepBtn.addEventListener("click", () =>
            openDeepScanModal(item.ticker, item.companyName)
          );
        }
        listContainer.appendChild(clone);
      });
      C.createIconsIn(listContainer);
    }

    const results = document.getElementById("discover-results");
    if (!results) return;
    results.classList.remove("hidden");
    results.classList.add("flex");
    setTimeout(() => {
      results.style.opacity = "1";
    }, 100);
  }

  function renderMyPortfolio() {
    const assets = C.getMyAssets();
    const list = document.getElementById("my-portfolio-list");
    const empty = document.getElementById("my-portfolio-empty");
    if (!list) return;
    list.innerHTML = "";

    if (empty) {
      if (assets.length === 0) empty.classList.remove("hidden");
      else empty.classList.add("hidden");
    }

    const template = document.getElementById("myasset-card-template");
    assets.forEach((asset) => {
      const clone = template.content.cloneNode(true);
      const cardRoot = clone.querySelector(".portfolio-card") || clone.firstElementChild;
      clone.querySelector(".ticker-text").textContent = asset.ticker;

      if (asset.verdict) {
        clone.querySelector(".advice-text").textContent = asset.advice || "";
        C.applyVerdictStyle(clone.querySelector(".verdict-badge"), asset.verdict);
      }

      clone.querySelector(".delete-btn").addEventListener("click", () => removeMyAsset(asset.id));
      clone.querySelector(".deep-scan-btn").addEventListener("click", () =>
        openDeepScanModal(asset.ticker, "保有銘柄")
      );

      const whyBtn = clone.querySelector(".why-moved-btn");
      const whyRes = clone.querySelector(".why-moved-result");
      whyBtn.addEventListener("click", () => explainPriceMovement(asset.ticker, whyBtn, whyRes));

      list.appendChild(clone);
      if (cardRoot) C.createIconsIn(cardRoot);
    });
  }

  function removeMyAsset(id) {
    const assets = C.getMyAssets().filter((a) => a.id !== id);
    C.saveMyAssets(assets);
    renderMyPortfolio();
  }

  async function scanMyPortfolio() {
    try {
      apiKeys = guardBeforeNetwork();
    } catch (error) {
      handleCaughtError(error, checkAuth);
      return;
    }

    const assets = C.getMyAssets();
    if (assets.length === 0) {
      C.showToast("保有銘柄を追加してください。", "info");
      return;
    }

    const job = beginJob("portfolio");
    setLoading(true, "全" + assets.length + "銘柄の最新データを取得中...");

    try {
      const settled = await C.mapPoolSettled(assets, C.FETCH_CONCURRENCY, async (a) => {
        const stockData = C.isUsTicker(a.ticker)
          ? await C.fetchFinnhubData(a.ticker, apiKeys, job.signal)
          : await C.fetchAlphaVantageData(a.ticker, apiKeys, job.signal);
        return "【" + a.ticker + "】 株価: " + stockData;
      });

      const okLines = [];
      const failedTickers = [];
      settled.forEach((row) => {
        if (row.status === "fulfilled") okLines.push(row.value);
        else failedTickers.push((row.item && row.item.ticker) || "?");
      });

      if (okLines.length === 0) {
        throw new Error(
          "全銘柄のデータ取得に失敗しました。" +
            (failedTickers.length ? "（" + failedTickers.join(", ") + "）" : "")
        );
      }

      if (failedTickers.length) {
        C.showToast(
          "一部銘柄の取得に失敗しました: " + failedTickers.join(", ") + "。取得できた銘柄で診断を続けます。",
          "info",
          7000
        );
      }

      const combinedStockData = okLines.join("\n");
      const generalNews = await C.fetchTavilyNews(
        "stock market latest news today",
        apiKeys,
        job.signal
      );

      setLoading(true, "取得したデータをもとにGemini AIが一括診断中...");

      const payload = {
        contents: [
          {
            parts: [
              {
                text:
                  "以下の保有銘柄リストと最新データに基づき、以下の2点を実行してください。\n\n【銘柄データ】\n" +
                  combinedStockData +
                  "\n\n【市場ニュース】\n" +
                  generalNews +
                  "\n\n1. ポートフォリオ全体の相関性・偏りリスクの診断\n2. 各個別銘柄の最新アクション判定（BUY/HOLD/SELL）と簡潔なアドバイス",
              },
            ],
          },
        ],
        systemInstruction: {
          parts: [
            {
              text: "プロのマネージャーとして診断せよ。出力は Structured Outputs のスキーマに厳密に従うこと。",
            },
          ],
        },
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: C.PORTFOLIO_SCAN_RESPONSE_SCHEMA,
        },
      };

      const result = await C.callGeminiAPI(payload, { apiKey: apiKeys.gemini, signal: job.signal });
      const aiData = C.assertPortfolioPayload(C.parseStructuredResponse(result));
      const verdicts = aiData.individualVerdicts;

      const commentary = document.getElementById("my-market-commentary");
      const commentaryText = document.getElementById("my-commentary-text");
      if (commentary) commentary.classList.remove("hidden");
      if (commentaryText) commentaryText.textContent = aiData.correlationRisk || "";

      const nextAssets = assets.map((asset) => {
        const vData = verdicts.find(
          (v) => String(v.ticker || "").toUpperCase() === String(asset.ticker).toUpperCase()
        );
        if (!vData) return asset;
        return Object.assign({}, asset, {
          verdict: vData.verdict,
          advice: vData.advice,
        });
      });
      if (!C.saveMyAssets(nextAssets)) {
        C.showToast("診断結果の保存に失敗しました。端末の保存容量をご確認ください。", "error");
      }
      renderMyPortfolio();
      C.showToast("ポートフォリオの診断が完了しました。", "success");
    } catch (error) {
      handleCaughtError(error);
    } finally {
      endJob("portfolio", job);
      setLoading(false);
    }
  }

  function destroyRadarChart() {
    if (currentRadarChart) {
      try {
        currentRadarChart.destroy();
      } catch (_) {
        /* ignore */
      }
      currentRadarChart = null;
    }
  }

  function closeDeepScanModal() {
    abortJob("deepScan");
    destroyRadarChart();
    const modal = document.getElementById("deep-scan-modal");
    if (!modal) return;
    modal.classList.remove("opacity-100");
    setTimeout(() => modal.classList.add("hidden"), 300);
  }

  async function openDeepScanModal(ticker, companyName) {
    if (!ticker) {
      C.showToast("銘柄コードがありません。", "error");
      return;
    }

    try {
      apiKeys = guardBeforeNetwork();
    } catch (error) {
      handleCaughtError(error, checkAuth);
      return;
    }

    const job = beginJob("deepScan");
    destroyRadarChart();

    const titleEl = document.getElementById("modal-title");
    const subtitleEl = document.getElementById("modal-subtitle");
    const modal = document.getElementById("deep-scan-modal");
    const loadingEl = document.getElementById("modal-loading");
    const contentEl = document.getElementById("modal-content-data");
    const loadingSub = document.getElementById("modal-loading-subtext");
    if (!modal || !loadingEl || !contentEl) {
      C.showToast("カルテ画面の表示に失敗しました。", "error");
      return;
    }

    if (titleEl) titleEl.textContent = ticker;
    if (subtitleEl) subtitleEl.textContent = companyName || "企業データ";
    modal.classList.remove("hidden");
    setTimeout(() => modal.classList.add("opacity-100"), 10);

    loadingEl.classList.remove("hidden");
    contentEl.classList.add("hidden");
    if (loadingSub) loadingSub.textContent = "外部APIから最新の株価とニュースを取得中...";

    try {
      const stockData = C.isUsTicker(ticker)
        ? await C.fetchFinnhubData(ticker, apiKeys, job.signal)
        : await C.fetchAlphaVantageData(ticker, apiKeys, job.signal);
      const newsData = await C.fetchTavilyNews(ticker + " stock news", apiKeys, job.signal);

      if (job.signal.aborted) return;
      if (loadingSub) {
        loadingSub.textContent = "取得したデータをもとにAIが詳細なカルテを作成中...";
      }

      const payload = {
        contents: [
          {
            parts: [
              {
                text:
                  "外部APIから取得した以下の最新データを用いて「" +
                  ticker +
                  "」を分析してください。\n\n【株価データ】\n" +
                  stockData +
                  "\n\n【最新ニュース】\n" +
                  newsData +
                  "\n\n【指示】\ngeniusViewはグロース、veteranViewはバリュー、macroViewはマクロ、quantViewはクオンツの観点で分析せよ。radarScoresは0〜100の整数。",
              },
            ],
          },
        ],
        systemInstruction: {
          parts: [
            {
              text: "最高峰のアナリストAIとして分析せよ。出力は Structured Outputs のスキーマに厳密に従うこと。",
            },
          ],
        },
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: C.DEEP_SCAN_RESPONSE_SCHEMA,
        },
      };

      const result = await C.callGeminiAPI(payload, { apiKey: apiKeys.gemini, signal: job.signal });
      if (job.signal.aborted) return;
      const rawData = C.assertDeepScanPayload(C.parseStructuredResponse(result));
      const finalVerdict = rawData.finalVerdict || {};
      const radar = rawData.radarScores || {};

      const setText = function (id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value || "";
      };
      setText("modal-genius-view", rawData.geniusView);
      setText("modal-veteran-view", rawData.veteranView);
      setText("modal-macro-view", rawData.macroView);
      setText("modal-quant-view", rawData.quantView);
      C.applyVerdictStyle(document.getElementById("modal-decision-badge"), finalVerdict.decision);
      setText("modal-final-conclusion", finalVerdict.conclusion);

      const canvas = document.getElementById("radarChart");
      if (canvas && typeof Chart !== "undefined") {
        const ctx = canvas.getContext("2d");
        const scores = [
          C.scoreOrDefault(radar.growth),
          C.scoreOrDefault(radar.value),
          C.scoreOrDefault(radar.momentum),
          C.scoreOrDefault(radar.safety),
          C.scoreOrDefault(radar.macroTailwind),
        ];
        try {
          currentRadarChart = new Chart(ctx, {
            type: "radar",
            data: {
              labels: ["成長", "割安", "勢い", "安全", "マクロ"],
              datasets: [
                {
                  data: scores,
                  borderColor: "#a855f7",
                  backgroundColor: "rgba(168, 85, 247, 0.2)",
                  pointBackgroundColor: "#c084fc",
                  borderWidth: 2,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                r: {
                  min: 0,
                  max: 100,
                  suggestedMin: 0,
                  suggestedMax: 100,
                  grid: { color: "rgba(255, 255, 255, 0.15)" },
                  angleLines: { color: "rgba(255, 255, 255, 0.15)" },
                  ticks: { display: false, stepSize: 20 },
                  pointLabels: {
                    color: "#94a3b8",
                    font: { size: 12, weight: "bold" },
                  },
                },
              },
            },
          });
        } catch (chartError) {
          console.error(chartError);
          C.showToast("レーダーチャートの表示に失敗しましたが、文章の診断は表示できます。", "info");
        }
      }

      loadingEl.classList.add("hidden");
      contentEl.classList.remove("hidden");
      contentEl.classList.add("flex");
    } catch (error) {
      handleCaughtError(error);
      loadingEl.classList.add("hidden");
    } finally {
      endJob("deepScan", job);
    }
  }

  async function explainPriceMovement(ticker, btnElement, resultElement) {
    if (!btnElement || !resultElement) return;

    try {
      apiKeys = guardBeforeNetwork();
    } catch (error) {
      handleCaughtError(error, checkAuth);
      return;
    }

    const job = beginJob("whyMoved");
    const originalLabel = "なぜ動いた？（最新ニュース）";
    btnElement.textContent = "最新ニュースを検索中...";
    btnElement.disabled = true;
    resultElement.classList.add("hidden");
    resultElement.textContent = "";

    try {
      const newsData = await C.fetchTavilyNews(
        ticker + " なぜ株価が動いた 最新ニュース",
        apiKeys,
        job.signal
      );
      const payload = {
        contents: [
          {
            parts: [
              {
                text:
                  "以下の最新ニュースを基に、「" +
                  ticker +
                  "」の今日の株価がなぜ動いているのかを初心者に向けて1〜2文で教えてください。\n\n【最新ニュース】\n" +
                  newsData,
              },
            ],
          },
        ],
        systemInstruction: {
          parts: [{ text: "優しく分かりやすい口調で。プレーンテキストで出力。" }],
        },
      };
      const result = await C.callGeminiAPI(payload, { apiKey: apiKeys.gemini, signal: job.signal });
      const textOut = C.getCandidateText(result);
      if (!textOut) throw new Error("AIからの応答が空です。");

      resultElement.textContent = "";
      const strong = document.createElement("strong");
      strong.textContent = "AIの解説: ";
      resultElement.appendChild(strong);
      resultElement.appendChild(document.createTextNode(textOut));
      resultElement.classList.remove("hidden");
    } catch (error) {
      if (!C.isAbortError(error)) {
        resultElement.textContent = "取得失敗: " + C.friendlyErrorMessage(error);
        resultElement.classList.remove("hidden");
      }
    } finally {
      endJob("whyMoved", job);
      btnElement.textContent = originalLabel;
      btnElement.disabled = false;
    }
  }

  function bindUi() {
    const form = document.getElementById("add-asset-form");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const ticker = (document.getElementById("add-ticker").value || "")
          .trim()
          .toUpperCase();
        if (!ticker) {
          C.showToast("銘柄コードを入力してください。", "error");
          return;
        }
        const assets = C.getMyAssets();
        assets.push({
          id: Date.now(),
          ticker: ticker,
          buyPrice: 0,
          shares: 0,
          verdict: null,
          advice: null,
        });
        C.saveMyAssets(assets);
        document.getElementById("add-ticker").value = "";
        renderMyPortfolio();
        C.showToast(ticker + " を追加しました。", "success");
      });
    }

    const closeBtn = document.getElementById("close-modal-btn");
    if (closeBtn) closeBtn.addEventListener("click", closeDeepScanModal);

    document.addEventListener("DOMContentLoaded", () => {
      checkAuth();
      renderMyPortfolio();
      C.createIconsIn(document.body);
      C.pruneCaches();
      C.installGlobalErrorHandlers();
    });

    // DOMContentLoaded 済みの場合（遅延読込対策）
    if (document.readyState !== "loading") {
      checkAuth();
      renderMyPortfolio();
      C.createIconsIn(document.body);
      C.pruneCaches();
      C.installGlobalErrorHandlers();
    }
  }

  // グローバル公開（HTMLの onclick から利用）
  window.saveApiKeys = saveApiKeys;
  window.resetApiKey = resetApiKey;
  window.switchMainTab = switchMainTab;
  window.startAutoPilotMultiStep = startAutoPilotMultiStep;
  window.scanMyPortfolio = scanMyPortfolio;
  window.openDeepScanModal = openDeepScanModal;
  window.closeDeepScanModal = closeDeepScanModal;

  bindUi();
})();
