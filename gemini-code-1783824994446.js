// ==========================================
// 株価調査アプリ - コア通信＆推論ロジック (100%完全結合版)
// ==========================================

// --- 設定値 ---
const CACHE_TIME = 15 * 60 * 1000; // 15分（ミリ秒）
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite']; 

// ==========================================
// 1. メイン処理（検索ボタンが押された時にこれを呼び出します）
// 例: <button onclick="startAnalysis('AAPL')">検索</button>
// ==========================================
async function startAnalysis(ticker) {
    if (typeof ticker !== 'string') {
        // もしHTML側から直接入力欄のIDを渡すのが難しい場合、自動で探すハック
        const inputEl = document.querySelector('input[type="text"]');
        if (inputEl) ticker = inputEl.value;
    }
    
    if (!ticker || ticker.trim() === "") {
        alert("銘柄を入力してください（例: AAPL または 7203）");
        return;
    }
    
    ticker = ticker.trim().toUpperCase();
    
    // UI: 自動ローディング画面の表示（エラー防止のため自動生成）
    showLoadingIndicator();

    try {
        // ① 15分キャッシュの確認 (API制限の防衛線)
        const cacheKey = `cache_${ticker}`;
        const cachedData = localStorage.getItem(cacheKey);
        if (cachedData) {
            const parsedCache = JSON.parse(cachedData);
            if (Date.now() - parsedCache.timestamp < CACHE_TIME) {
                console.log("15分以内のためキャッシュから推論します");
                const result = await analyzeWithGemini(ticker, parsedCache.data);
                displayFinalResult(result); // 画面に表示
                return;
            }
        }

        // ② 日米ハイブリッド・ルーティングと並列データ収集
        let stockData = "";
        let newsData = "";
        const isJapaneseStock = /^\d{4}$/.test(ticker); // 4桁の数字なら日本株と判定

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
        
        // ⑤ 画面への結果描画（省略なし）
        displayFinalResult(finalResult);

    } catch (error) {
        console.error("エラー:", error);
        alert(`処理に失敗しました: ${error.message}\n時間をおいて再試行してください。`);
    } finally {
        // UI: ローディング表示の終了
        hideLoadingIndicator();
    }
}

// ==========================================
// 2. 外部API データ取得関数群
// ==========================================
async function fetchFinnhubData(ticker) {
    const key = localStorage.getItem('finnhub_api_key');
    if (!key) throw new Error("FinnhubのAPIキーが設定されていません。ブラウザに保存してください。");
    
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${key}`);
    if (!res.ok) throw new Error("株価データの取得に失敗しました");
    
    const data = await res.json();
    if (data.c === 0 && data.d === null) return "銘柄データが見つかりませんでした。";
    return `現在値: $${data.c}, 前日比: $${data.d} (${data.dp}%)`;
}

async function fetchAlphaVantageData(ticker) {
    const key = localStorage.getItem('alphavantage_api_key');
    if (!key) throw new Error("Alpha VantageのAPIキーが設定されていません。");
    
    const res = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}.TOK&apikey=${key}`);
    if (!res.ok) throw new Error("株価データの取得に失敗しました");
    
    const data = await res.json();
    const quote = data["Global Quote"];
    if (!quote || Object.keys(quote).length === 0) return "詳細な株価データは取得できませんでした。";
    return `現在値: ¥${quote["05. price"]}, 前日比: ${quote["09. change"]} (${quote["10. change percent"]})`;
}

async function fetchTavilyNews(query) {
    const key = localStorage.getItem('tavily_api_key');
    if (!key) throw new Error("TavilyのAPIキーが設定されていません。");
    
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
// 3. Gemini API サーキットブレーカー（モデル自動切り替え）
// ==========================================
async function analyzeWithGemini(ticker, contextText) {
    const key = localStorage.getItem('gemini_api_key');
    if (!key) throw new Error("GeminiのAPIキーが設定されていません。");

    const MAX_LOOPS = 2; // 最大2周で諦める（無限ループ防止）
    for (let loop = 0; loop < MAX_LOOPS; loop++) {
        for (const model of GEMINI_MODELS) {
            console.log(`AI呼び出し中: ${model}`);
            try {
                return await callGeminiEndpoint(model, key, contextText);
            } catch (error) {
                console.warn(`モデル ${model} でエラー:`, error.message);
                // 429(制限) か 503(過負荷) の場合のみ次のモデルへ
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
// 4. Gemini APIへの推論リクエスト（ソースのJSON構造を完全再現）
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
        systemInstruction: { 
            parts: [{ text: "プロのマネージャーとして出力。回答はJSONのみ。" }] 
        },
        generationConfig: { 
            responseMimeType: "application/json" 
        }
        // 注意: googleSearch ツールは外部APIで代替したため安全に削除済みです
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status}`);
    }

    const data = await response.json();
    const jsonString = data.candidates[0].content.parts[0].text;
    
    return JSON.parse(jsonString);
}

// ==========================================
// 5. 自動UI生成機能（エラーを絶対に起こさないための画面描画）
// ==========================================

// データの読み込み中を表示する
function showLoadingIndicator() {
    let loader = document.getElementById('ai-loader-overlay');
    if (!loader) {
        // もしHTMLにローディング画面がなければ、JavaScriptが自動で作ります
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

// 分析結果を画面に表示する
function displayFinalResult(data) {
    let resultDiv = document.getElementById('ai-result-display');
    if (!resultDiv) {
        // もしHTMLに結果表示エリアがなければ、JavaScriptが自動で作ります
        resultDiv = document.createElement('div');
        resultDiv.id = 'ai-result-display';
        resultDiv.style.cssText = 'max-width: 800px; margin: 30px auto; padding: 20px; font-family: sans-serif;';
        document.body.appendChild(resultDiv);
    }

    // おじいさま向けに文字を大きく、色分けしたデザインで出力
    let html = `
        <div style="background: #e8f8f5; padding: 20px; border-radius: 12px; margin-bottom: 25px; border-left: 6px solid #1abc9c;">
            <h3 style="margin-top: 0; font-size: 1.4rem; color: #2c3e50;">📊 全体の相関性・偏りリスク</h3>
            <p style="font-size: 1.2rem; line-height: 1.6; color: #333;">${data.correlationRisk}</p>
        </div>
        <h3 style="font-size: 1.4rem; border-bottom: 2px solid #bdc3c7; padding-bottom: 10px;">🏢 個別銘柄の診断</h3>
    `;

    data.individualVerdicts.forEach(v => {
        // 判定によって色を変える
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