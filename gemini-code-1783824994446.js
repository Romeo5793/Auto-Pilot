/**
 * 単銘柄分析エントリ（互換レイヤ）
 * 共通処理は autopilot-core.js を利用
 */
(function () {
  "use strict";

  const C = window.AutoPilotCore;
  if (!C) {
    console.error("AutoPilotCore が読み込まれていません。autopilot-core.js を先に読み込んでください。");
    return;
  }

  function showLoadingIndicator() {
    let loader = document.getElementById("ai-loader-overlay");
    if (!loader) {
      loader = document.createElement("div");
      loader.id = "ai-loader-overlay";
      loader.style.cssText =
        "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);display:flex;justify-content:center;align-items:center;color:white;z-index:9999;font-size:1.25rem;font-weight:700;";
      loader.textContent = "分析中...";
      document.body.appendChild(loader);
    }
    loader.style.display = "flex";
  }

  function hideLoadingIndicator() {
    const loader = document.getElementById("ai-loader-overlay");
    if (loader) loader.style.display = "none";
  }

  function displayFinalResult(data) {
    let resultDiv = document.getElementById("ai-result-display");
    if (!resultDiv) {
      resultDiv = document.createElement("div");
      resultDiv.id = "ai-result-display";
      resultDiv.style.cssText =
        "padding:1.5rem;font-size:1.05rem;line-height:1.6;color:#f1f5f9;";
      document.body.appendChild(resultDiv);
    }

    resultDiv.textContent = "";
    const riskTitle = document.createElement("div");
    riskTitle.style.cssText = "font-size:1.15rem;font-weight:700;color:#f8fafc;margin-bottom:0.75rem;";
    riskTitle.textContent = "リスク診断";
    resultDiv.appendChild(riskTitle);

    const riskBody = document.createElement("p");
    riskBody.style.cssText = "font-size:1.05rem;color:#e2e8f0;line-height:1.7;";
    riskBody.textContent = (data && data.correlationRisk) || "";
    resultDiv.appendChild(riskBody);

    const verdictTitle = document.createElement("div");
    verdictTitle.style.cssText =
      "font-size:1.15rem;font-weight:700;color:#f8fafc;margin:1.25rem 0 0.5rem;";
    verdictTitle.textContent = "判定結果";
    resultDiv.appendChild(verdictTitle);

    const verdicts = data && Array.isArray(data.individualVerdicts) ? data.individualVerdicts : [];
    if (verdicts.length === 0) {
      const pre = document.createElement("pre");
      pre.style.cssText = "white-space:pre-wrap;font-size:1rem;";
      pre.textContent = JSON.stringify(data, null, 2);
      resultDiv.appendChild(pre);
      return;
    }

    verdicts.forEach((v) => {
      const color =
        v.verdict === "BUY" ? "#6ee7b7" : v.verdict === "SELL" ? "#fca5a5" : "#e2e8f0";
      const box = document.createElement("div");
      box.style.cssText =
        "margin:1rem 0;padding:1rem;border:2px solid " + color + ";border-radius:0.75rem;";
      const head = document.createElement("div");
      head.style.cssText = "font-size:1.5rem;font-weight:900;color:" + color + ";";
      head.textContent = (v.ticker || "") + "：" + (v.verdict || "");
      const advice = document.createElement("div");
      advice.style.cssText = "margin-top:0.5rem;font-size:1.05rem;color:#e2e8f0;";
      advice.textContent = v.advice || "";
      box.appendChild(head);
      box.appendChild(advice);
      resultDiv.appendChild(box);
    });
  }

  async function ensureKeysInteractive() {
    const required = [
      { get: () => C.getGeminiApiKey(), set: (v) => C.setGeminiApiKey(v), name: "Gemini (AIの頭脳)" },
      {
        get: () => C.getStorage(C.STORAGE_KEYS.finnhub, ""),
        set: (v) => C.setStorage(C.STORAGE_KEYS.finnhub, v),
        name: "Finnhub (米国株データ)",
      },
      {
        get: () => C.getStorage(C.STORAGE_KEYS.alpha, ""),
        set: (v) => C.setStorage(C.STORAGE_KEYS.alpha, v),
        name: "Alpha Vantage (日本株データ)",
      },
      {
        get: () => C.getStorage(C.STORAGE_KEYS.tavily, ""),
        set: (v) => C.setStorage(C.STORAGE_KEYS.tavily, v),
        name: "Tavily (最新ニュース)",
      },
    ];

    for (let i = 0; i < required.length; i++) {
      const k = required[i];
      if (k.get()) continue;
      const userInput = prompt("【設定が必要です】\n" + k.name + " のパスワード(APIキー)を入力してください。");
      if (userInput && userInput.trim()) {
        k.set(userInput.trim());
      } else {
        C.showToast(k.name + " がないため分析できません。設定後に再度お試しください。", "error");
        return false;
      }
    }
    return true;
  }

  async function analyzeWithGemini(ticker, contextText, signal) {
    const payload = {
      contents: [
        {
          parts: [
            {
              text:
                '以下のデータに基づき、銘柄「' +
                ticker +
                '」を分析してください。\n\n' +
                contextText +
                "\n\n【指示】\n1. 相関・偏りリスクを correlationRisk に簡潔に記述\n2. individualVerdicts に当該銘柄の判定(BUY/HOLD/SELL)とアドバイスを1件含める",
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
        responseSchema: C.ANALYSIS_RESPONSE_SCHEMA,
      },
    };
    const data = await C.callGeminiAPI(payload, {
      apiKey: C.getGeminiApiKey(),
      signal: signal,
    });
    return C.parseStructuredResponse(data);
  }

  async function startAnalysis(ticker) {
    if (!(await ensureKeysInteractive())) return;

    try {
      C.assertOnline();
    } catch (error) {
      C.showToast(C.friendlyErrorMessage(error), "error");
      return;
    }

    if (typeof ticker !== "string") {
      const inputEl = document.querySelector('input[type="text"]');
      if (inputEl) ticker = inputEl.value;
    }
    if (!ticker || !String(ticker).trim()) {
      C.showToast("銘柄コードを入力してください。（例: 7203 または AAPL）", "error");
      return;
    }

    ticker = String(ticker).trim().toUpperCase();
    const job = C.createAbortBundle();
    showLoadingIndicator();

    try {
      const cached = C.readTickerCache(ticker);
      let combinedContext = cached;

      if (!combinedContext) {
        let stockData = "";
        let newsData = "";
        if (C.isJapaneseTicker(ticker)) {
          const pair = await Promise.all([
            C.fetchAlphaVantageData(ticker, null, job.signal),
            C.fetchTavilyNews(ticker + " 株価 最新ニュース", null, job.signal),
          ]);
          stockData = "【株価・財務データ】\n" + pair[0];
          newsData = "【最新ニュース】\n" + pair[1];
        } else {
          const pair = await Promise.all([
            C.fetchFinnhubData(ticker, null, job.signal),
            C.fetchTavilyNews(ticker + " stock latest news", null, job.signal),
          ]);
          stockData = "【株価・財務データ】\n" + pair[0];
          newsData = "【最新ニュース】\n" + pair[1];
        }
        combinedContext = stockData + "\n\n" + newsData;
        C.writeTickerCache(ticker, combinedContext);
      }

      const finalResult = await analyzeWithGemini(ticker, combinedContext, job.signal);
      displayFinalResult(finalResult);
      C.showToast("分析が完了しました。", "success");
    } catch (error) {
      console.error(error);
      if (!(error && C.isAbortError(error))) {
        C.showToast(C.friendlyErrorMessage(error), "error");
      }
    } finally {
      hideLoadingIndicator();
    }
  }

  window.startAnalysis = startAnalysis;
})();
