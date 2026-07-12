// ==========================================
// 株価調査アプリ - コア通信＆推論ロジック (完全結合版・修正版)
// ==========================================

const CACHE_TIME = 15 * 60 * 1000;
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite'];

async function startAnalysis(ticker) {
    // 1. APIキーチェックロジック（ここが確実に実行されるように修正）
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
                alert(`⚠️ ${k.name} がないため分析できません。`);
                return;
            }
        }
    }

    // 2. 銘柄取得
    if (typeof ticker !== 'string') {
        const inputEl = document.querySelector('input[type="text"]');
        if (inputEl) ticker = inputEl.value;
    }
    
    if (!ticker || ticker.trim() === "") {
        alert("銘柄を入力してください");
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

    } catch (error) {
        console.error(error);
        alert(`エラー: ${error.message}`);
    } finally {
        hideLoadingIndicator();
    }
}

// --- 以下、既存のAPI関数および推論・UI生成ロジックはそのまま維持 ---

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
    for (const model of GEMINI_MODELS) {
        try {
            return await callGeminiEndpoint(model, key, contextText);
        } catch (e) {
            if (e.message.includes('429') || e.message.includes('503')) continue;
            throw e;
        }
    }
}

async function callGeminiEndpoint(model, apiKey, contextText) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: `以下のデータに基づき、指定のJSON形式で出力せよ。\n\n${contextText}\n\n{"correlationRisk": "診断", "individualVerdicts": [{"ticker": "${ticker}", "verdict": "BUY/HOLD/SELL", "advice": "アドバイス"}]}` }] }],
            systemInstruction: { parts: [{ text: "回答はJSONのみ。" }] },
            generationConfig: { responseMimeType: "application/json" }
        })
    });
    const data = await response.json();
    return JSON.parse(data.candidates[0].content.parts[0].text);
}

function showLoadingIndicator() {
    let loader = document.getElementById('ai-loader-overlay');
    if (!loader) {
        loader = document.createElement('div'); loader.id = 'ai-loader-overlay';
        loader.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); display:flex; justify-content:center; align-items:center; color:white; z-index:9999;';
        loader.innerHTML = '分析中...'; document.body.appendChild(loader);
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
        resultDiv = document.createElement('div'); resultDiv.id = 'ai-result-display';
        document.body.appendChild(resultDiv);
    }
    resultDiv.innerHTML = `<pre>${JSON.stringify(data, null, 2)}</pre>`;
}
