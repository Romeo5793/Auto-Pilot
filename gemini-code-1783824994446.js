// ==========================================
// 株価調査アプリ - コア通信＆推論ロジック
// Gemini Structured Outputs + シニア向け Toast 対応版
// ==========================================

const CACHE_TIME = 15 * 60 * 1000;
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];

// --- Gemini Structured Outputs 用スキーマ定義 ---
const ANALYSIS_RESPONSE_SCHEMA = {
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
                        enum: ["BUY", "HOLD", "SELL"]
                    },
                    advice: { type: "STRING" }
                },
                required: ["ticker", "verdict", "advice"]
            }
        }
    },
    required: ["correlationRisk", "individualVerdicts"]
};

// Structured Outputs で保証された JSON を安全にパースする（文字列切り出しは行わない）
function parseStructuredResponse(apiResult) {
    const text = apiResult?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("AIからの応答が空です。");
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error("Structured Output の JSON パースに失敗しました: " + e.message);
    }
}

let toastTimer = null;

function ensureToastContainer() {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('aria-atomic', 'true');
        container.style.cssText = 'position:fixed;top:1rem;left:50%;transform:translateX(-50%);z-index:10000;width:min(92vw,36rem);display:flex;flex-direction:column;gap:0.75rem;pointer-events:none;';
        document.body.appendChild(container);
    }
    return container;
}

function friendlyErrorMessage(error) {
    const msg = (error && error.message) ? String(error.message) : String(error || '');
    if (/429|503|混み合|RETRY|busy|quota|rate limit/i.test(msg)) {
        return '現在データ取得元が混み合っています。少し待ってから再度お試しください。';
    }
    if (/Failed to fetch|network|通信|NetworkError/i.test(msg)) {
        return '通信に失敗しました。インターネット接続を確認して、もう一度お試しください。';
    }
    if (/API Error|APIキー|api key|401|403/i.test(msg)) {
        return 'データ取得に失敗しました。APIキー設定をご確認のうえ、再度お試しください。';
    }
    if (/JSON|Structured|パース|応答が空/i.test(msg)) {
        return '結果の読み取りに失敗しました。少し時間をおいて再度お試しください。';
    }
    return msg || 'うまく処理できませんでした。もう一度お試しください。';
}

function showToast(message, type = 'info', durationMs = 5500) {
    const container = ensureToastContainer();
    const banner = document.createElement('div');
    const bg = type === 'error'
        ? 'linear-gradient(135deg, rgba(127,29,29,0.95), rgba(15,23,42,0.98)); border:1px solid rgba(248,113,113,0.55);'
        : type === 'success'
            ? 'linear-gradient(135deg, rgba(6,78,59,0.95), rgba(15,23,42,0.98)); border:1px solid rgba(52,211,153,0.55);'
            : 'linear-gradient(135deg, rgba(30,58,138,0.95), rgba(15,23,42,0.98)); border:1px solid rgba(96,165,250,0.55);';
    banner.style.cssText = `pointer-events:auto;display:flex;align-items:flex-start;gap:0.75rem;padding:1rem 1.25rem;border-radius:1rem;${bg}box-shadow:0 12px 40px rgba(0,0,0,0.55);color:#f8fafc;font-size:1.05rem;line-height:1.55;font-weight:700;opacity:0;transform:translateY(-12px);transition:opacity 0.35s ease, transform 0.35s ease;`;
    banner.innerHTML = `
        <span style="flex-grow:1;">${message}</span>
        <button type="button" aria-label="閉じる" style="margin-left:auto;background:transparent;border:none;color:#e2e8f0;cursor:pointer;font-size:1.25rem;line-height:1;">×</button>
    `;
    const close = () => {
        banner.style.opacity = '0';
        banner.style.transform = 'translateY(-12px)';
        setTimeout(() => banner.remove(), 350);
    };
    banner.querySelector('button').addEventListener('click', close);
    container.appendChild(banner);
    requestAnimationFrame(() => {
        banner.style.opacity = '1';
        banner.style.transform = 'translateY(0)';
    });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(close, durationMs);
}

async function startAnalysis(ticker) {
    const requiredKeys = [
        { id: 'gemini_api_key', name: 'Gemini (AIの頭脳)' },
        { id: 'finnhub_api_key', name: 'Finnhub (米国株データ)' },
        { id: 'alphavantage_api_key', name: 'Alpha Vantage (日本株データ)' },
        { id: 'tavily_api_key', name: 'Tavily (最新ニュース)' }
    ];

    for (const k of requiredKeys) {
        if (!localStorage.getItem(k.id)) {
            const userInput = prompt(`【設定が必要です】\n${k.name} のパスワード(APIキー)を入力してください。`);
            if (userInput && userInput.trim() !== "") {
                localStorage.setItem(k.id, userInput.trim());
            } else {
                showToast(`${k.name} がないため分析できません。設定後に再度お試しください。`, 'error');
                return;
            }
        }
    }

    if (typeof ticker !== 'string') {
        const inputEl = document.querySelector('input[type="text"]');
        if (inputEl) ticker = inputEl.value;
    }

    if (!ticker || ticker.trim() === "") {
        showToast("銘柄コードを入力してください。（例: 7203 または AAPL）", "error");
        return;
    }

    ticker = ticker.trim().toUpperCase();
    showLoadingIndicator();

    try {
        const cacheKey = `cache_${ticker}`;
        const cachedData = localStorage.getItem(cacheKey);

        if (cachedData) {
            const parsedCache = JSON.parse(cachedData);
            if (Date.now() - parsedCache.timestamp < CACHE_TIME) {
                const result = await analyzeWithGemini(ticker, parsedCache.data);
                displayFinalResult(result);
                showToast("分析が完了しました。", "success");
                hideLoadingIndicator();
                return;
            }
        }

        let stockData = "";
        let newsData = "";
        const isJapaneseStock = /^\d{4}$/.test(ticker);

        if (isJapaneseStock) {
            const [stockResult, newsResult] = await Promise.all([
                fetchAlphaVantageData(ticker),
                fetchTavilyNews(`${ticker} 株価 最新ニュース`)
            ]);
            stockData = `【株価・財務データ】\n${stockResult}`;
            newsData = `【最新ニュース】\n${newsResult}`;
        } else {
            const [stockResult, newsResult] = await Promise.all([
                fetchFinnhubData(ticker),
                fetchTavilyNews(`${ticker} stock latest news`)
            ]);
            stockData = `【株価・財務データ】\n${stockResult}`;
            newsData = `【最新ニュース】\n${newsResult}`;
        }

        const combinedContext = `${stockData}\n\n${newsData}`;
        localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data: combinedContext }));

        const finalResult = await analyzeWithGemini(ticker, combinedContext);
        displayFinalResult(finalResult);
        showToast("分析が完了しました。", "success");

    } catch (error) {
        console.error(error);
        showToast(friendlyErrorMessage(error), "error");
    } finally {
        hideLoadingIndicator();
    }
}

async function fetchFinnhubData(ticker) {
    const key = localStorage.getItem('finnhub_api_key');
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${key}`);
    const data = await res.json();
    return `現在値: $${data.c}, 前日比: $${data.d} (${data.dp}%)`;
}

async function fetchAlphaVantageData(ticker) {
    const key = localStorage.getItem('alphavantage_api_key');
    const res = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}.TOK&apikey=${key}`);
    const data = await res.json();
    const quote = data["Global Quote"];
    return quote ? `現在値: ¥${quote["05. price"]}, 前日比: ${quote["09. change"]}` : "データなし";
}

async function fetchTavilyNews(query) {
    const key = localStorage.getItem('tavily_api_key');
    const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query: query, include_answer: true, days_back: 3 })
    });
    const data = await res.json();
    return data.answer || "ニュースなし";
}

async function analyzeWithGemini(ticker, contextText) {
    const key = localStorage.getItem('gemini_api_key');
    let lastError = null;
    for (const model of GEMINI_MODELS) {
        try {
            return await callGeminiEndpoint(model, key, ticker, contextText);
        } catch (e) {
            lastError = e;
            if (e.message.includes('429') || e.message.includes('503')) continue;
            throw e;
        }
    }
    throw lastError || new Error("現在データ取得元が混み合っています。少し待ってから再度お試しください。");
}

async function callGeminiEndpoint(model, apiKey, ticker, contextText) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [{
                    text: `以下のデータに基づき、銘柄「${ticker}」を分析してください。\n\n${contextText}\n\n【指示】\n1. 相関・偏りリスクを correlationRisk に簡潔に記述\n2. individualVerdicts に当該銘柄の判定(BUY/HOLD/SELL)とアドバイスを1件含める`
                }]
            }],
            systemInstruction: {
                parts: [{ text: "プロのアナリストとして分析せよ。出力は Structured Outputs のスキーマに厳密に従うこと。" }]
            },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: ANALYSIS_RESPONSE_SCHEMA
            }
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API Error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    return parseStructuredResponse(data);
}

function showLoadingIndicator() {
    let loader = document.getElementById('ai-loader-overlay');
    if (!loader) {
        loader = document.createElement('div');
        loader.id = 'ai-loader-overlay';
        loader.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); display:flex; justify-content:center; align-items:center; color:white; z-index:9999; font-size:1.25rem; font-weight:700;';
        loader.innerHTML = '分析中...';
        document.body.appendChild(loader);
    }
    loader.style.display = 'flex';
}

function hideLoadingIndicator() {
    const loader = document.getElementById('ai-loader-overlay');
    if (loader) loader.style.display = 'none';
}

function displayFinalResult(data) {
    let resultDiv = document.getElementById('ai-result-display');
    if (!resultDiv) {
        resultDiv = document.createElement('div');
        resultDiv.id = 'ai-result-display';
        resultDiv.style.cssText = 'padding:1.5rem; font-size:1.05rem; line-height:1.6; color:#f1f5f9;';
        document.body.appendChild(resultDiv);
    }

    const verdicts = Array.isArray(data.individualVerdicts) ? data.individualVerdicts : [];
    const verdictHtml = verdicts.map(v => {
        const color = v.verdict === 'BUY' ? '#6ee7b7' : (v.verdict === 'SELL' ? '#fca5a5' : '#e2e8f0');
        return `<div style="margin:1rem 0;padding:1rem;border:2px solid ${color};border-radius:0.75rem;">
            <div style="font-size:1.5rem;font-weight:900;color:${color};">${v.ticker}：${v.verdict}</div>
            <div style="margin-top:0.5rem;font-size:1.05rem;color:#e2e8f0;">${v.advice || ''}</div>
        </div>`;
    }).join('');

    resultDiv.innerHTML = `
        <div style="font-size:1.15rem;font-weight:700;color:#f8fafc;margin-bottom:0.75rem;">リスク診断</div>
        <p style="font-size:1.05rem;color:#e2e8f0;line-height:1.7;">${data.correlationRisk || ''}</p>
        <div style="font-size:1.15rem;font-weight:700;color:#f8fafc;margin:1.25rem 0 0.5rem;">判定結果</div>
        ${verdictHtml || `<pre style="white-space:pre-wrap;font-size:1rem;">${JSON.stringify(data, null, 2)}</pre>`}
    `;
}
