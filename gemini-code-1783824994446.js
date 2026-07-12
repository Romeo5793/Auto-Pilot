// ==========================================
// 株価調査アプリ - コア通信＆推論ロジック (100%完全結合版)
// ==========================================

// --- 設定値 ---
const CACHE_TIME = 15 * 60 * 1000; // 15分（ミリ秒）
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite']; 

// ==========================================
// 1. メイン処理
// ==========================================
async function startAnalysis(ticker) {
    // --------------------------------------------------
    // 🔑 追加：足りないAPIキーを自動で要求して保存する機能
    // --------------------------------------------------
    const requiredKeys = [
        { id: 'gemini_api_key', name: 'Gemini (AIの頭脳)' },
        { id: 'finnhub_api_key', name: 'Finnhub (米国株データ)' },
        { id: 'alphavantage_api_key', name: 'Alpha Vantage (日本株データ)' },
        { id: 'tavily_api_key', name: 'Tavily (最新ニュース)' }
    ];

    for (const k of requiredKeys) {
        if (!localStorage.getItem(k.id)) {
            // おじいさまにも分かりやすいようにポップアップで要求
            const userInput = prompt(`【初回設定】\n${k.name} の専用パスワード(APIキー)を入力してください。\n（一度入力すれば次回から要求されません）`);
            if (userInput && userInput.trim() !== "") {
                localStorage.setItem(k.id, userInput.trim());
            } else {
                alert(`⚠️ ${k.name} のパスワードがないため、分析をストップしました。`);
                return; // キーがない場合はここで安全に停止
            }
        }
    }
    // --------------------------------------------------

    if (typeof ticker !== 'string') {
        const inputEl = document.querySelector('input[type="text"]');
        if (inputEl) ticker = inputEl.value;
    }
    
    if (!ticker || ticker.trim() === "") {
        alert("銘柄を入力してください（例: AAPL または 7203）");
        return;
    }
    
    ticker = ticker.trim().toUpperCase();
    
    // UI: 自動ローディング画面の表示
    showLoadingIndicator();

    try {
        // ① 15分キャッシュの確認
        const cacheKey = `cache_${ticker}`;
        const cachedData = localStorage.getItem(cacheKey);
        if (cachedData) {
            const parsedCache = JSON.parse(cachedData);
            if (Date.now() - parsedCache.timestamp < CACHE_TIME) {
                console.log("15分以内のためキャッシュから推論します");
                const result = await analyzeWithGemini(ticker, parsedCache.data);
                displayFinalResult(result); 
                return;
            }
        }

        // ② 日米ハイブリッド・ルーティングと並列データ収集
        let stockData = "";
        let newsData = "";
        const isJapaneseStock = /^\d{4}$/.test(ticker); 

        if (isJapaneseStock) {
            console.log("日本株モードでデータ取得中...");
            const [stockResult, newsResult] = await Promise.all([
                fetchAlphaVantageData(ticker),
                fetchTavilyNews(`${ticker} 株価 最新ニュース`)
            ]);
            stockData = `【株価・財務データ】\n${stockResult}`;
            newsData = `【最新ニュース】\n${newsResult}`;
        } else {
            console.log("米国株モードでデータ取得中...");
            const [stockResult, newsResult] = await Promise.all([
                fetchFinnhubData(ticker),
                fetchTavilyNews(`${ticker} stock latest news`)
            ]);
            stockData = `【株価・財務データ】\n${stockResult}`;
            newsData = `【最新ニュース】\n${newsResult}`;
        }

        const combinedContext = `${stockData}\n\n${newsData}`;
        
        // ③ キャッシュの保存
        localStorage.setItem(cacheKey, JSON.stringify({
            timestamp: Date.now(),
            data: combinedContext
        }));

        // ④ Gemini APIでの推論実行
        const finalResult = await analyzeWithGemini(ticker, combinedContext);
        
        // ⑤ 画面への結果描画
        displayFinalResult(finalResult);

    } catch (error) {
        console.error("エラー:", error);
        alert(`処理に失敗しました: ${error.message}\n時間をおいて再試行してください。`);
    } finally {
        hideLoadingIndicator();
    }
}

// ==========================================
// 2. 外部API データ取得関数群
// ==========================================
async function fetchFinnhubData(ticker) {
    const key = localStorage.getItem('finnhub_api_key');
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${key}`);
    if (!res.ok) throw new Error("株価データの取得に失敗しました");
    const data = await res.json();
    if (data.c === 0 && data.d === null) return "銘柄データが見つかりませんでした。";
    return `現在値: $${data.c}, 前日比: $${data.d} (${data.dp}%)`;
}

async function fetchAlphaVantageData(ticker) {
    const key = localStorage.getItem('alphavantage_api_key');
    const res = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}.TOK&apikey=${key}`);
    if (!res.ok) throw new Error("株価データの取得に失敗しました");
    const data = await res.json();
    const quote = data["Global Quote"];
    if (!quote || Object.keys(quote).length === 0) return "詳細な株価データは取得できませんでした。";
    return `現在値: ¥${quote["05. price"]}, 前日比: ${quote["09. change"]} (${quote["10. change percent"]})`;
}

async function fetchTavilyNews(query) {
    const key = localStorage.getItem('tavily_api_key');
    const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api_key: key,
            query: query,
            search_depth: "basic",
            include_answer: true,
            days_back: 3
        })
    });
    if (!res.ok) throw new Error("ニュースデータの取得に失敗しました");
    const data = await res.json();
    return data.answer || data.results.map(r => `- ${r.title}: ${r.content}`).join('\n');
}

// ==========================================
// 3. Gemini API サーキットブレーカー
// ==========================================
async function analyzeWithGemini(ticker, contextText) {
    const key = localStorage.getItem('gemini_api_key');
    const MAX_LOOPS = 2; 
    for (let loop = 0; loop < MAX_LOOPS; loop++) {
        for (const model of GEMINI_MODELS) {
            console.log(`AI呼び出し中: ${model}`);
            try {
                return await callGeminiEndpoint(model, key, contextText);
            } catch (error) {
                console.warn(`モデル ${model} でエラー:`, error.message);
                if (error.message.includes('429') || error.message.includes('503')) {
                    continue; 
                } else {
                    throw new Error(`AIの処理中に致命的なエラーが発生しました: ${error.message}`);
                }
            }
        }
    }
    throw new Error("現在AIモデルが大変混み合っています。しばらく時間をおいてから再度お試しください。");
}

// ==========================================
// 4. Gemini APIへの推論リクエスト
// ==========================================
async function callGeminiEndpoint(model, apiKey, contextText) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const requestBody = {
        contents: [{
            role: "user",
            parts: [{
                text: `以下の最新データに基づき、指定のJSON形式で出力せよ。\n\n【収集データ】\n${contextText}\n\n1. ポートフォリオ全体の「相関性・偏りリスク」の診断\n2. 各個別銘柄の最新アクション判定（BUY/HOLD/SELL）と簡潔なアドバイス\n【出力形式】\n必ず以下のJSONフォーマットのみを出力してください。\n{\n  "correlationRisk": "string (ポートフォリオ全体のリスク診断テキスト)",\n  "individualVerdicts": [\n    {\n      "ticker": "string",\n      "verdict": "BUY/HOLD/SELL",\n      "advice": "string"\n    }\n  ]\n}`
            }]
        }],
        systemInstruction: { parts: [{ text: "プロのマネージャーとして出力。回答はJSONのみ。" }] },
        generationConfig: { responseMimeType: "application/json" }
    };
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });
    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
    const data = await response.json();
    return JSON.parse(data.candidates[0].content.parts[0].text);
}

// ==========================================
// 5. 自動UI生成機能
// ==========================================
function showLoadingIndicator() {
    let loader = document.getElementById('ai-loader-overlay');
    if (!loader) {
        loader = document.createElement('div');
        loader.id = 'ai-loader-overlay';
        loader.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(255,255,255,0.9); display: flex; justify-content: center; align-items: center; z-index: 9999; font-size: 1.5rem; font-weight: bold; color: #2c3e50;';
        loader.innerHTML = '⏳ AIが各種データを集めて分析中です。<br>数十秒お待ちください...';
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
        resultDiv.style.cssText = 'max-width: 800px; margin: 30px auto; padding: 20px; font-family: sans-serif;';
        document.body.appendChild(resultDiv);
    }
    let html = `
        <div style="background: #e8f8f5; padding: 20px; border-radius: 12px; margin-bottom: 25px; border-left: 6px solid #1abc9c;">
            <h3 style="margin-top: 0; font-size: 1.4rem; color: #2c3e50;">📊 全体の相関性・偏りリスク</h3>
            <p style="font-size: 1.2rem; line-height: 1.6; color: #333;">${data.correlationRisk}</p>
        </div>
        <h3 style="font-size: 1.4rem; border-bottom: 2px solid #bdc3c7; padding-bottom: 10px;">🏢 個別銘柄の診断</h3>
    `;
    data.individualVerdicts.forEach(v => {
        const color = v.verdict === 'BUY' ? '#c0392b' : (v.verdict === 'SELL' ? '#2980b9' : '#f39c12');
        html += `
        <div style="background: #ffffff; padding: 20px; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border: 1px solid #ecf0f1;">
            <h4 style="margin: 0 0 15px 0; font-size: 1.5rem;">
                ${v.ticker} : <span style="color: ${color}; font-weight: bold;">${v.verdict}</span>
            </h4>
            <p style="margin: 0; font-size: 1.2rem; line-height: 1.6; color: #555;">${v.advice}</p>
        </div>
        `;
    });
    resultDiv.innerHTML = html;
}
