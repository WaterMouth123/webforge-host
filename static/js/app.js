/**
 * WebForge - 前端主控制程式
 * 模組包含：
 * 1. 網絡狀態與伺服器資訊同步 (/api/network-info)
 * 2. HTML 編輯器即時監聽、行數統計與 iframe 渲染預覽
 * 3. 視圖尺寸切換與編輯輔助（Tab 鍵支援、拖曳載入、強制刷新）
 */

// 伺服器網絡資訊快取物件，方便後續模組共用
let serverNetworkInfo = null;

// 防抖定時器
let previewDebounceTimer = null;

/**
 * 簡易浮動提示 (Toast) 輔助函式
 * @param {string} message - 提示文字
 * @param {string} type - 類型 ('success' | 'error' | 'info')
 */
function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'toast-error' : 'toast-success'}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

/* ==========================================================================
   一、 伺服器與局域網資訊模組
   ========================================================================== */

/**
 * 向後端 /api/network-info 端點請求伺服器與區域網路資訊
 */
async function fetchNetworkInfo() {
    const lanDisplayEl = document.getElementById('lanIpDisplay');
    const networkBadgeEl = document.getElementById('networkBadge');

    try {
        const response = await fetch('/api/network-info');
        if (!response.ok) {
            throw new Error(`伺服器回應異常碼: ${response.status}`);
        }

        const data = await response.json();
        serverNetworkInfo = data;

        // 1. 更新頂部導航列的局域網 IP:PORT 標籤
        if (lanDisplayEl) {
            lanDisplayEl.textContent = `${data.local_ip}:${data.port}`;
        }

        // 2. 更新徽章提示資訊並賦予點擊快速複製功能
        if (networkBadgeEl) {
            networkBadgeEl.title = `同 Wi-Fi 或局域網內裝置可透過此網址訪問：\n${data.lan_url}\n(點擊可直接複製網址)`;
            networkBadgeEl.style.cursor = 'pointer';

            networkBadgeEl.onclick = async () => {
                if (data.lan_url) {
                    try {
                        await navigator.clipboard.writeText(data.lan_url);
                        showToast(`已複製區域網路網址：${data.lan_url}`, 'success');
                    } catch (err) {
                        console.warn('剪貼簿權限受限，網址為：', data.lan_url);
                    }
                }
            };
        }

        console.log('🚀 WebForge 後端網絡連線資訊取得成功:', data);
    } catch (error) {
        console.error('❌ 無法取得網絡連線資訊:', error);

        if (lanDisplayEl) {
            lanDisplayEl.textContent = '離線 / 僅本機存取';
            lanDisplayEl.style.color = 'var(--text-muted, #94a3b8)';
        }

        if (networkBadgeEl) {
            networkBadgeEl.title = '無法取得局域網 IP，伺服器可能處於完全離線模式';
            const dot = networkBadgeEl.querySelector('.status-dot');
            if (dot) {
                dot.classList.remove('pulsing');
                dot.style.background = '#94a3b8';
                dot.style.boxShadow = 'none';
            }
        }
    }
}

/* ==========================================================================
   二、 HTML 編輯器監聽與即時預覽核心邏輯
   ========================================================================== */

/**
 * 預覽區空狀態提示範本
 */
const EMPTY_PREVIEW_HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <style>
        body {
            margin: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: #ffffff;
            color: #64748b;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif;
            text-align: center;
            padding: 20px;
            box-sizing: border-box;
        }
        .icon-box {
            font-size: 2.6rem;
            margin-bottom: 12px;
            animation: floatIcon 3s ease-in-out infinite;
        }
        h3 {
            margin: 0 0 8px 0;
            font-size: 1.15rem;
            color: #1e293b;
            font-weight: 600;
        }
        p {
            margin: 0;
            font-size: 0.88rem;
            color: #94a3b8;
            line-height: 1.5;
            max-width: 320px;
        }
        @keyframes floatIcon {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-6px); }
        }
    </style>
</head>
<body>
    <div class="icon-box">⚡</div>
    <h3>即時效果預覽區</h3>
    <p>請在左側輸入或貼上 HTML / CSS / JS 代碼，此處將以毫秒級速度即時呈現效果！</p>
</body>
</html>`;

/**
 * 更新預覽畫面與編輯器行數、字元統計
 * @param {boolean} immediate - 是否跳過防抖立即更新
 */
function updatePreview(immediate = false) {
    const editor = document.getElementById('htmlEditor');
    const previewFrame = document.getElementById('previewFrame');
    const codeStatsEl = document.getElementById('codeStats');

    if (!editor || !previewFrame) return;

    const htmlContent = editor.value;

    // 1. 即時計算並更新程式碼統計資訊
    if (codeStatsEl) {
        if (!htmlContent.trim()) {
            codeStatsEl.textContent = '0 行 | 0 字元';
        } else {
            const lines = htmlContent.split('\n').length;
            const chars = htmlContent.length;
            codeStatsEl.textContent = `${lines} 行 | ${chars.toLocaleString()} 字元`;
        }
    }

    // 2. 防抖更新 iframe 內容（避免打字高頻重繪造成卡頓，並注入預覽彈窗攔截保護）
    const executeRender = () => {
        if (!htmlContent.trim()) {
            previewFrame.srcdoc = EMPTY_PREVIEW_HTML;
            return;
        }

        // 預覽安全防護腳本：攔截阻塞主視窗的 alert / confirm / prompt / print 等彈窗與頂層重定向
        const modalDefenseScript = `<script>
(function() {
    window.alert = function(msg) { console.warn('[WebForge 預覽環境已攔截 alert]:', msg); };
    window.confirm = function(msg) { console.warn('[WebForge 預覽環境已攔截 confirm]:', msg); return true; };
    window.prompt = function(msg) { console.warn('[WebForge 預覽環境已攔截 prompt]:', msg); return null; };
    window.print = function() { console.warn('[WebForge 預覽環境已攔截 print 調用]'); };
    window.open = function(url) { console.warn('[WebForge 預覽環境已攔截 window.open]:', url); return null; };
    try {
        Object.defineProperty(window, 'top', { get: function() { return window; } });
        Object.defineProperty(window, 'parent', { get: function() { return window; } });
    } catch(e) {}
})();
<\/script>`;

        let renderContent = htmlContent;
        if (/<head[^>]*>/i.test(renderContent)) {
            renderContent = renderContent.replace(/<head[^>]*>/i, match => match + modalDefenseScript);
        } else {
            renderContent = modalDefenseScript + renderContent;
        }

        previewFrame.srcdoc = renderContent;
    };

    if (immediate) {
        clearTimeout(previewDebounceTimer);
        executeRender();
    } else {
        clearTimeout(previewDebounceTimer);
        previewDebounceTimer = setTimeout(executeRender, 150);
    }
}

/**
 * 清空編輯器內容
 */
function clearEditor() {
    const editor = document.getElementById('htmlEditor');
    if (!editor) return;

    if (editor.value.trim() && !confirm('確定要清空目前編輯器中的所有程式碼嗎？')) {
        return;
    }

    editor.value = '';
    updatePreview(true);
    editor.focus();
    showToast('編輯器已清空', 'info');
}

/**
 * 強制重新整理目前預覽
 */
function refreshPreview() {
    updatePreview(true);
    showToast('預覽已強制重新整理', 'success');
}

/**
 * 切換預覽視口寬度（全寬 / 平板 768px / 手機 375px）
 * @param {string} width - 容器寬度例如 '100%', '768px', '375px'
 */
function setViewport(width) {
    const container = document.getElementById('previewContainer');
    if (!container) return;

    container.style.width = width;

    // 更新視窗按鈕狀態
    const buttons = {
        '100%': document.getElementById('vpDesktop'),
        '768px': document.getElementById('vpTablet'),
        '375px': document.getElementById('vpMobile')
    };

    Object.keys(buttons).forEach(key => {
        const btn = buttons[key];
        if (btn) {
            if (key === width) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }
    });
}

/**
 * 初始化 HTML 編輯器各項事件監聽（鍵盤輸入、Tab 縮排、檔案拖曳等）
 */
function initEditorEvents() {
    const editor = document.getElementById('htmlEditor');
    const dropZone = document.getElementById('editorDropZone');

    if (!editor) return;

    // 1. 監聽文字輸入 (input 事件) 即時更新預覽
    editor.addEventListener('input', () => {
        updatePreview(false);
    });

    // 2. 貼心程式碼編輯優化：支援按 Tab 鍵插入 2 個空格，避免跳出焦點
    editor.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            const indent = '  '; // 2 格縮排

            editor.value = editor.value.substring(0, start) + indent + editor.value.substring(end);
            editor.selectionStart = editor.selectionEnd = start + indent.length;

            updatePreview(false);
        }
    });

    // 3. 支援檔案拖曳進編輯器區域直接載入
    if (dropZone) {
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.add('dragover');
            });
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.remove('dragover');
            });
        });

        dropZone.addEventListener('drop', (e) => {
            const files = e.dataTransfer?.files;
            if (files && files.length > 0) {
                const file = files[0];
                if (file.name.endsWith('.html') || file.name.endsWith('.htm') || file.type.includes('text')) {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        editor.value = event.target.result;
                        updatePreview(true);
                        showToast(`已載入檔案：${file.name}`, 'success');

                        // 若標題輸入框存在且為預設值，自動填入檔案名稱
                        const titleInput = document.getElementById('siteTitleInput');
                        if (titleInput && (!titleInput.value || titleInput.value === '我的新網站')) {
                            titleInput.value = file.name.replace(/\.[^/.]+$/, '');
                        }
                    };
                    reader.readAsText(file);
                } else {
                    showToast('請拖曳 .html 或純文字格式檔案！', 'error');
                }
            }
        });
    }

    // 初始渲染一次（呈現友善空狀態或預設值）
    updatePreview(true);
}

/* ==========================================================================
   三、 網站發布與網址分享模組
   ========================================================================== */

/**
 * 點擊「立即生成並發布網站」核心邏輯
 */
async function publishSite() {
    const publishBtn = document.getElementById('publishBtn');
    const editor = document.getElementById('htmlEditor');
    const titleInput = document.getElementById('siteTitleInput');
    const slugInput = document.getElementById('siteSlugInput');

    if (!editor) return;

    // 0. 強制 Google 帳戶登入檢查：必須登入才能發布網站
    const currentUser = getLoggedInUser();
    if (!currentUser || !currentUser.id) {
        showToast('🔒 本系統需要使用 Google 帳戶登入後方可發布網站！', 'error');
        triggerGoogleLogin();
        return;
    }

    // 1. 嚴格空值檢查：代碼是否為空或僅包含空白字元
    const rawContent = editor.value || '';
    const htmlContent = rawContent.trim();
    if (!htmlContent) {
        showToast('⚠️ 代碼內容不能為空，請在編輯器中輸入或貼上 HTML 代碼！', 'error');
        editor.focus();
        // 編輯器框短暫醒目紅光提示
        const originalBoxShadow = editor.style.boxShadow;
        editor.style.boxShadow = '0 0 0 2px var(--accent-rose, #f43f5e)';
        setTimeout(() => {
            editor.style.boxShadow = originalBoxShadow;
        }, 1500);
        return;
    }

    // 2. 自訂網址別名格式檢查（若使用者有輸入自訂 slug）
    const rawSlug = slugInput ? slugInput.value.trim() : '';
    if (rawSlug && !/^[a-zA-Z0-9_-]+$/.test(rawSlug)) {
        showToast('⚠️ 自訂網址別名只允許英文字母、數字、破折號 (-) 與底線 (_)！', 'error');
        slugInput.focus();
        return;
    }

    const title = titleInput ? titleInput.value.trim() || '未命名網站' : '未命名網站';
    const slug = rawSlug;

    // 防重複點擊：切換為 Loading 狀態並停用按鈕
    const originalBtnHtml = publishBtn.innerHTML;
    publishBtn.disabled = true;
    publishBtn.innerHTML = `
        <svg class="btn-spinner" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.5" fill="none" style="animation: spin 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path></svg>
        <span>正在生成網站...</span>
    `;

    try {
        const creatorId = getOrCreateCreatorId();
        const response = await fetch('/api/publish', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                html: htmlContent,
                title: title,
                slug: slug,
                creator_id: creatorId
            })
        });

        // 安全檢查 Content-Type 是否為 JSON，防範任何伺服器 HTML 錯誤頁面導致解析崩潰
        let data;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            data = await response.json();
        } else {
            const rawText = await response.text();
            throw new Error(`伺服器回應異常 (${response.status})，請確認網路或稍後再試！`);
        }

        if (!response.ok || !data.success) {
            throw new Error(data.message || '網站發布失敗，請稍後重試');
        }

        console.log('🎉 網站發布成功:', data);

        // 取得回傳的完整 URL（優先取局域網公開網址，所有人皆可存取）
        const fullAccessUrl = data.url || data.lan_url;
        const localAccessUrl = data.local_url || fullAccessUrl;

        // 填充發布彈窗內容
        const modalTitle = document.getElementById('modalSiteTitle');
        const modalLanUrl = document.getElementById('modalLanUrl');
        const modalLocalUrl = document.getElementById('modalLocalUrl');
        const modalOpenBtn = document.getElementById('modalOpenBtn');
        const qrContainer = document.getElementById('qrContainer');
        const shareModal = document.getElementById('shareModal');

        if (modalTitle) modalTitle.textContent = `「${data.title}」已成功發布！`;
        if (modalLanUrl) modalLanUrl.value = fullAccessUrl;
        if (modalLocalUrl) modalLocalUrl.value = localAccessUrl;
        if (modalOpenBtn) modalOpenBtn.href = fullAccessUrl;

        // 動態生成高精確度標準二維碼（任何手機鏡頭秒讀）
        if (qrContainer) {
            renderQrCode(qrContainer, fullAccessUrl, 120);
        }

        // 彈出成功分享對話框
        if (shareModal) {
            shareModal.classList.add('show');
        }

        showToast('🎉 網站生成成功！完整網址已就緒', 'success');

    } catch (error) {
        console.error('❌ 發布網站失敗:', error);
        showToast(error.message || '網站生成發生錯誤', 'error');
    } finally {
        // 恢復按鈕狀態
        if (publishBtn) {
            publishBtn.disabled = false;
            publishBtn.innerHTML = originalBtnHtml;
        }
    }
}

/**
 * 複製指定輸入框的網址至剪貼簿
 * @param {string} inputId - 存放網址的 input 元素 ID
 */
async function copyModalUrl(inputId) {
    const inputEl = document.getElementById(inputId);
    if (!inputEl || !inputEl.value) return;

    try {
        await navigator.clipboard.writeText(inputEl.value);
        showToast('已複製網址到剪貼簿！', 'success');
    } catch (err) {
        // 備用方案
        inputEl.select();
        document.execCommand('copy');
        showToast('已複製網址到剪貼簿！', 'success');
    }
}

/**
 * 關閉發布分享彈窗
 */
function closeShareModal() {
    const shareModal = document.getElementById('shareModal');
    if (shareModal) {
        shareModal.classList.remove('show');
    }
}

/**
 * 頁面分頁切換（新建與發布 / 已發布網站清單）
 * @param {string} tabName - 'create' | 'manage'
 */
function switchTab(tabName) {
    const tabCreateBtn = document.getElementById('tabCreateBtn');
    const tabManageBtn = document.getElementById('tabManageBtn');
    const viewCreate = document.getElementById('viewCreate');
    const viewManage = document.getElementById('viewManage');

    if (tabName === 'create') {
        tabCreateBtn?.classList.add('active');
        tabManageBtn?.classList.remove('active');
        viewCreate?.classList.add('active');
        viewManage?.classList.remove('active');
    } else if (tabName === 'manage') {
        tabCreateBtn?.classList.remove('active');
        tabManageBtn?.classList.add('active');
        viewCreate?.classList.remove('active');
        viewManage?.classList.add('active');
        // 切換到管理分頁時，自動抓取最新站點清單
        loadSitesList();
    }
}

/* ==========================================================================
   四、 範本選單、檔案上傳與 QR Code 輔助模組
   ========================================================================== */

/**
 * 示範範本庫資料
 */
const TEMPLATES = {
    construction: {
        title: '工地裝修進度與自主檢查表',
        slug: 'interior-check',
        html: `<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>富宇大亨 A8 戶裝修進度與自主查驗看板</title>
    <style>
        :root { --primary: #0284c7; --bg: #f8fafc; --text: #0f172a; --card: #ffffff; }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif; background: var(--bg); color: var(--text); padding: 20px; line-height: 1.6; }
        .container { max-width: 800px; margin: 0 auto; }
        header { background: linear-gradient(135deg, #0f172a, #1e293b); color: #fff; padding: 24px; border-radius: 14px; margin-bottom: 24px; }
        h1 { margin: 0 0 8px 0; font-size: 1.4rem; }
        .meta-tag { display: inline-block; background: rgba(56, 189, 248, 0.2); color: #38bdf8; font-size: 0.8rem; padding: 2px 10px; border-radius: 99px; }
        .card { background: var(--card); border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        h2 { font-size: 1.15rem; margin-top: 0; margin-bottom: 14px; color: #1e293b; display: flex; align-items: center; justify-content: space-between; }
        .progress-bar-wrap { background: #e2e8f0; height: 10px; border-radius: 99px; overflow: hidden; margin-bottom: 8px; }
        .progress-bar { background: linear-gradient(90deg, #0284c7, #38bdf8); height: 100%; border-radius: 99px; }
        .step-list { list-style: none; padding: 0; margin: 0; }
        .step-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px dashed #e2e8f0; }
        .step-item:last-child { border-bottom: none; }
        .badge { font-size: 0.75rem; padding: 3px 8px; border-radius: 6px; font-weight: 600; }
        .badge-done { background: #dcfce7; color: #15803d; }
        .badge-ing { background: #e0f2fe; color: #0369a1; }
        .badge-pending { background: #f1f5f9; color: #64748b; }
        .checklist label { display: block; padding: 8px 0; cursor: pointer; }
        .checklist input { margin-right: 10px; transform: scale(1.1); }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <span class="meta-tag">工程編號：PRJ-2026-042</span>
            <h1>富宇大亨 A8 戶裝修進度與自主查驗</h1>
            <p style="margin: 6px 0 0; font-size: 0.85rem; color: #94a3b8;">監工主管：吳工程師 ｜ 施工階段：泥作打底與水電配管</p>
        </header>

        <div class="card">
            <h2><span>總工期排程進度</span><span style="font-size: 0.9rem; color: var(--primary);">45%</span></h2>
            <div class="progress-bar-wrap">
                <div class="progress-bar" style="width: 45%;"></div>
            </div>
            <ul class="step-list">
                <li class="step-item"><span>1. 保護工程與拆除清運</span><span class="badge badge-done">已完成 (100%)</span></li>
                <li class="step-item"><span>2. 給排水冷熱水管重配 & 試水壓 24hr</span><span class="badge badge-done">合格 (100%)</span></li>
                <li class="step-item"><span>3. 浴室泥作打底、雙層防水塗刷 (高至樑底)</span><span class="badge badge-ing">施作中 (60%)</span></li>
                <li class="step-item"><span>4. 矽酸鈣天花板角材防焰防蟲與防潮封板</span><span class="badge badge-pending">排程中</span></li>
                <li class="step-item"><span>5. 系統櫃進場組裝 & 燈具開孔收邊</span><span class="badge badge-pending">排程中</span></li>
            </ul>
        </div>

        <div class="card">
            <h2>本日現場查驗重點 (自主檢查)</h2>
            <div class="checklist">
                <label><input type="checkbox" checked> 冷熱水管試壓 10kg/cm² 持壓 24 小時無掉壓</label>
                <label><input type="checkbox" checked> 衛浴乾濕分離門檻止水墩確實施作</label>
                <label><input type="checkbox"> 地磚排水坡度實測，洩水坡度達 1/100</label>
                <label><input type="checkbox"> 插座地線三孔接地阻抗檢測小於 100 歐姆</label>
            </div>
        </div>
    </div>
</body>
</html>`
    },
    landing: {
        title: '極簡現代科技首頁',
        slug: 'modern-landing',
        html: `<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AeroSync - 新世代雲端協作平台</title>
    <style>
        body { margin: 0; background: #0b0f19; color: #f8fafc; font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; text-align: center; padding: 20px; box-sizing: border-box; }
        .hero { max-width: 650px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 24px; padding: 48px 32px; backdrop-filter: blur(20px); box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
        .pill { display: inline-block; background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); color: #a5b4fc; font-size: 0.8rem; font-weight: 600; padding: 4px 14px; border-radius: 99px; margin-bottom: 20px; }
        h1 { font-size: 2.4rem; font-weight: 800; margin: 0 0 16px; background: linear-gradient(135deg, #fff 40%, #94a3b8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        p { color: #94a3b8; font-size: 1.05rem; line-height: 1.6; margin-bottom: 32px; }
        .btn-cta { display: inline-block; background: linear-gradient(135deg, #6366f1, #06b6d4); color: #fff; text-decoration: none; padding: 14px 32px; font-weight: 700; border-radius: 12px; transition: transform 0.2s, box-shadow 0.2s; box-shadow: 0 4px 20px rgba(99,102,241,0.4); }
        .btn-cta:hover { transform: translateY(-2px); box-shadow: 0 6px 25px rgba(99,102,241,0.6); }
    </style>
</head>
<body>
    <div class="hero">
        <span class="pill">🚀 全新 2.0 正式上線</span>
        <h1>將您的創意，毫秒化為現實</h1>
        <p>告別複雜的伺服器維護與設定。無論是原型設計、客戶展示還是臨時交付，隨時一鍵生成專屬在線網站。</p>
        <a href="javascript:alert('歡迎加入 AeroSync 體驗！')" class="btn-cta">立即免費開始體驗 →</a>
    </div>
</body>
</html>`
    },
    calculator: {
        title: '室內裝修坪數與估價計算器',
        slug: 'interior-calc',
        html: `<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>裝修坪數與工料預算快速試算小工具</title>
    <style>
        body { margin: 0; background: #0f172a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px 16px; display: flex; justify-content: center; }
        .calc-card { background: #1e293b; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; max-width: 480px; width: 100%; padding: 28px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        h2 { margin: 0 0 6px; font-size: 1.3rem; }
        p.sub { font-size: 0.85rem; color: #94a3b8; margin: 0 0 20px; }
        .form-row { margin-bottom: 16px; }
        label { display: block; font-size: 0.85rem; color: #cbd5e1; margin-bottom: 6px; }
        input, select { width: 100%; box-sizing: border-box; background: #090d16; border: 1px solid #334155; padding: 10px 14px; border-radius: 8px; color: #fff; font-size: 0.95rem; }
        .result-box { background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 10px; padding: 18px; margin-top: 20px; text-align: center; }
        .result-val { font-size: 1.8rem; font-weight: 800; color: #38bdf8; margin: 6px 0; }
    </style>
</head>
<body>
    <div class="calc-card">
        <h2>🧮 裝修坪數與預算速算</h2>
        <p class="sub">輸入長度與寬度（公尺），即時換算地坪與裝修預算估值</p>
        <div class="form-row">
            <label>空間長度 (公尺)：</label>
            <input type="number" id="len" value="6.5" step="0.1" oninput="calc()">
        </div>
        <div class="form-row">
            <label>空間寬度 (公尺)：</label>
            <input type="number" id="wid" value="4.2" step="0.1" oninput="calc()">
        </div>
        <div class="form-row">
            <label>裝修項目基準單價 (每坪)：</label>
            <select id="price" onchange="calc()">
                <option value="4500">超耐磨木地板 (連工帶料約 $4,500/坪)</option>
                <option value="7500">平頂矽酸鈣天花板 + 批土油漆 ($7,500/坪)</option>
                <option value="60000">標準全室輕裝修估算 ($60,000/坪)</option>
            </select>
        </div>
        <div class="result-box">
            <div style="font-size: 0.85rem; color: #cbd5e1;">換算總面積：<strong id="ping">0</strong> 坪</div>
            <div class="result-val" id="total">$0</div>
            <div style="font-size: 0.75rem; color: #94a3b8;">*本試算為參考估算，實際報價以現場丈量與施工圖說為準。</div>
        </div>
    </div>
    <script>
        function calc() {
            const l = parseFloat(document.getElementById('len').value) || 0;
            const w = parseFloat(document.getElementById('wid').value) || 0;
            const p = parseFloat(document.getElementById('price').value) || 0;
            const ping = (l * w * 0.3025).toFixed(2);
            const total = Math.round(ping * p);
            document.getElementById('ping').textContent = ping;
            document.getElementById('total').textContent = '$' + total.toLocaleString();
        }
        calc();
    <\/script>
</body>
</html>`
    },
    portfolio: {
        title: '設計師個人作品展示',
        slug: 'designer-works',
        html: `<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Wuhe Studio ｜ 空間設計與 AI 系統整合</title>
    <style>
        body { margin: 0; background: #090d16; color: #f8fafc; font-family: system-ui, sans-serif; padding: 40px 20px; line-height: 1.6; }
        .wrap { max-width: 900px; margin: 0 auto; }
        .hero { margin-bottom: 40px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 24px; }
        h1 { font-size: 2rem; margin: 0 0 10px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; }
        .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 20px; transition: transform 0.2s; }
        .card:hover { transform: translateY(-3px); border-color: rgba(99,102,241,0.4); }
        .card h3 { margin: 0 0 8px; font-size: 1.15rem; color: #fff; }
        .card p { margin: 0; font-size: 0.88rem; color: #94a3b8; }
    </style>
</head>
<body>
    <div class="wrap">
        <div class="hero">
            <h1>Wuhe Studio</h1>
            <p style="color: #94a3b8;">專注於建築與室內空間工程、智慧化自動派工與 AI Agent 系統整合研發。</p>
        </div>
        <div class="grid">
            <div class="card">
                <h3>🏗️ 智能工務驗收系統</h3>
                <p>整合行動端現場拍照與即時瑕疵歸檔，縮短 50% 查驗交屋流程。</p>
            </div>
            <div class="card">
                <h3>⚡ WebForge 託管器</h3>
                <p>毫秒級將 HTML 代碼發布為線上站點，支援局域網自動廣播與 QR Code 掃描。</p>
            </div>
            <div class="card">
                <h3>📐 裝修坪數與估價引擎</h3>
                <p>標準工料分析模型，即時產出符合台灣建築常規之報價單與甘特圖。</p>
            </div>
        </div>
    </div>
</body>
</html>`
    }
};

/**
 * 切換示範範本下拉選單顯示/隱藏
 */
function toggleTemplateMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('templateMenu');
    if (menu) {
        menu.classList.toggle('show');
    }
}

/**
 * 載入指定類型的示範範本
 * @param {string} type - 'construction' | 'landing' | 'calculator' | 'portfolio'
 */
function loadTemplate(type) {
    const template = TEMPLATES[type];
    if (!template) return;

    const editor = document.getElementById('htmlEditor');
    const titleInput = document.getElementById('siteTitleInput');
    const slugInput = document.getElementById('siteSlugInput');
    const menu = document.getElementById('templateMenu');

    if (editor) {
        editor.value = template.html;
        updatePreview(true);
    }

    if (titleInput) {
        titleInput.value = template.title;
    }

    if (slugInput) {
        slugInput.value = `${template.slug}-${Math.floor(Math.random() * 900 + 100)}`;
    }

    if (menu) {
        menu.classList.remove('show');
    }

    showToast(`已載入「${template.title}」範本！`, 'success');
}

/**
 * 處理檔案選取器上傳
 */
function handleFileUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const editor = document.getElementById('htmlEditor');
        const titleInput = document.getElementById('siteTitleInput');

        if (editor) {
            editor.value = e.target.result;
            updatePreview(true);
        }

        if (titleInput && (!titleInput.value || titleInput.value === '我的新網站')) {
            titleInput.value = file.name.replace(/\.[^/.]+$/, '');
        }

        showToast(`已成功載入本地檔案：${file.name}`, 'success');
    };
    reader.readAsText(file);
}

/**
 * 取得當前已登入的 Google 使用者資訊
 */
function getLoggedInUser() {
    try {
        const str = localStorage.getItem('webforge_user');
        return str ? JSON.parse(str) : null;
    } catch (e) {
        return null;
    }
}

/**
 * 取得或初始化當前使用者的專屬身分碼 (Creator ID)
 * 若已登入 Google 帳號，優先採用 Google 唯一 ID；否則使用本地專屬訪客碼
 */
function getOrCreateCreatorId() {
    const user = getLoggedInUser();
    if (user && user.id) {
        return user.id;
    }
    const STORAGE_KEY = 'webforge_creator_id';
    let creatorId = localStorage.getItem(STORAGE_KEY);
    if (!creatorId) {
        creatorId = 'usr_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
        localStorage.setItem(STORAGE_KEY, creatorId);
    }
    return creatorId;
}

// 站點檢視範圍：預設為 'mine'（只看自己發布的），可切換為 'all'（全站公開）
let currentSiteScope = 'mine';

/**
 * 切換網站清單檢視範圍 (mine | all)
 */
function setSiteScope(scope) {
    currentSiteScope = scope;
    const btnMine = document.getElementById('scopeMineBtn');
    const btnAll = document.getElementById('scopeAllBtn');
    const titleEl = document.getElementById('manageTitle');
    const subtitleEl = document.getElementById('manageSubtitle');

    if (scope === 'mine') {
        btnMine?.classList.add('active');
        btnAll?.classList.remove('active');
        if (titleEl) titleEl.textContent = '我的在線網站';
        if (subtitleEl) subtitleEl.textContent = '此處僅列出由您目前瀏覽器或裝置所發布的網站，其他訪客無法查看或刪除您的專屬站點。';
    } else {
        btnMine?.classList.remove('active');
        btnAll?.classList.add('active');
        if (titleEl) titleEl.textContent = '全站公開網站清單';
        if (subtitleEl) subtitleEl.textContent = '展示伺服器上所有已發布並分享的公開網站。';
    }

    loadSitesList();
}

// 站點清單快取（供即時搜尋過濾用）
let cachedSites = [];

/**
 * 載入網站清單（支援 creator_id 專屬隔離）
 */
async function loadSitesList() {
    const user = getLoggedInUser();
    if (!user || !user.id) {
        return; // 未登入 Google 帳戶前不載入私人清單
    }

    const grid = document.getElementById('sitesGrid');
    const countPill = document.getElementById('siteCountPill');
    const creatorId = getOrCreateCreatorId();

    try {
        const queryParams = new URLSearchParams({
            creator_id: creatorId,
            scope: currentSiteScope
        });

        const res = await fetch(`/api/sites?${queryParams.toString()}`);
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            throw new Error('伺服器未回傳有效 JSON');
        }

        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.message || '無法取得站點清單');
        }

        cachedSites = data.sites || [];

        // 頂部導航列徽章只反映「我的網站」數量（若當前在 mine 模式下）
        if (currentSiteScope === 'mine' && countPill) {
            countPill.textContent = cachedSites.length;
        }

        renderSitesGrid(cachedSites);

    } catch (err) {
        console.error('❌ 載入站點清單失敗:', err);
        if (grid) {
            grid.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon" style="color: var(--accent-rose);">⚠️</div>
                    <h3>載入站點清單時發生問題</h3>
                    <p>${err.message}</p>
                    <button class="btn btn-secondary" onclick="loadSitesList()">重試</button>
                </div>
            `;
        }
    }
}

/**
 * 渲染網站卡片網格（精確標記個人站點與刪除保護）
 */
function renderSitesGrid(sites) {
    const grid = document.getElementById('sitesGrid');
    if (!grid) return;

    const myCreatorId = getOrCreateCreatorId();

    if (!sites || sites.length === 0) {
        const emptyMsg = currentSiteScope === 'mine' 
            ? '您尚未在此瀏覽器發布過任何網站。'
            : '目前全站尚未有公開發布的網站。';
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📂</div>
                <h3>${currentSiteScope === 'mine' ? '您的專屬清單目前為空' : '尚無公開網站'}</h3>
                <p>${emptyMsg} 快切換到「新建與發布」分頁，貼上您的第一段 HTML 代碼吧！</p>
                <button class="btn btn-primary" onclick="switchTab('create')">現在開始生成</button>
            </div>
        `;
        return;
    }

    grid.innerHTML = sites.map(site => {
        const siteUrl = `/site/${site.slug}`;
        const fullUrl = `${window.location.origin}${siteUrl}`;
        const isMySite = !site.creator_id || site.creator_id === myCreatorId;

        // 只有自己的網站才允許刪除按鈕，避免誤刪他人發布的內容
        const deleteBtnHtml = isMySite 
            ? `<button class="btn btn-secondary btn-icon-danger" onclick="deleteSite('${site.id}', '${escapeHtml(site.title)}')">刪除</button>`
            : '';

        const badgeHtml = isMySite
            ? `<span class="site-card-badge" style="background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.3); color: #6ee7b7;">👤 我的發布</span>`
            : `<span class="site-card-badge">🌐 公開站點</span>`;

        return `
            <div class="site-card">
                <div>
                    <div class="site-card-header">
                        <h4 class="site-card-title">${escapeHtml(site.title)}</h4>
                        ${badgeHtml}
                    </div>
                    <div class="site-card-slug">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                        <span>/site/${site.slug}</span>
                    </div>
                    <div class="site-card-meta">
                        <span>👁️ ${site.view_count || 0} 次瀏覽</span>
                        <span>發布於：${site.created_at || '剛才'}</span>
                    </div>
                </div>
                <div class="site-card-actions">
                    <a href="${siteUrl}" target="_blank" class="btn btn-primary" style="text-decoration:none;">開啟網站</a>
                    <button class="btn btn-secondary" onclick="openQrModal('${fullUrl}', '${escapeHtml(site.title)}')">QR碼</button>
                    ${deleteBtnHtml}
                </div>
            </div>
        `;
    }).join('');
}

/**
 * 搜尋篩選站點清單
 */
function filterSitesList() {
    const input = document.getElementById('searchSitesInput');
    const query = (input?.value || '').toLowerCase().trim();

    if (!query) {
        renderSitesGrid(cachedSites);
        return;
    }

    const filtered = cachedSites.filter(s => 
        (s.title && s.title.toLowerCase().includes(query)) ||
        (s.slug && s.slug.toLowerCase().includes(query))
    );

    renderSitesGrid(filtered);
}

/**
 * 刪除指定網站（安全附帶 creator_id 驗證）
 */
async function deleteSite(siteId, siteTitle) {
    if (!confirm(`確定要刪除「${siteTitle}」嗎？刪除後該網址將無法再存取。`)) {
        return;
    }

    const creatorId = getOrCreateCreatorId();

    try {
        const res = await fetch(`/api/sites/${siteId}?creator_id=${encodeURIComponent(creatorId)}`, { 
            method: 'DELETE' 
        });
        const data = await res.json();
        if (data.success) {
            showToast('網站已成功刪除', 'info');
            loadSitesList();
        } else {
            showToast(data.message || '刪除失敗', 'error');
        }
    } catch (err) {
        showToast('刪除請求失敗', 'error');
    }
}

/**
 * 開啟獨立 QR Code 彈窗
 */
/**
 * 繪製高辨識率標準二維碼（任何手機鏡頭秒讀）
 * @param {HTMLElement} container - 存放二維碼的 DOM 容器
 * @param {string} url - 欲編碼的完整網址
 * @param {number} size - 圖片像素尺寸
 */
function renderQrCode(container, url, size = 120) {
    if (!container) return;
    container.innerHTML = '';

    if (!url) {
        container.innerHTML = '<div style="color:#64748b;font-size:0.75rem;">無有效網址</div>';
        return;
    }

    // 1. 首選：使用權威標準 QRCode.js (生成 Canvas / Img，糾錯等級 M，任何相機秒辨識)
    if (typeof QRCode !== 'undefined') {
        try {
            new QRCode(container, {
                text: url,
                width: size,
                height: size,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
            return;
        } catch (err) {
            console.warn('QRCode.js 繪製失敗，切換至備援方案:', err);
        }
    }

    // 2. 備援方案：純前端高相容性 QR 圖片渲染
    const img = document.createElement('img');
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=1&data=${encodeURIComponent(url)}`;
    img.alt = 'QR Code';
    img.width = size;
    img.height = size;
    img.style.display = 'block';
    img.style.borderRadius = '4px';
    container.appendChild(img);
}

/**
 * 開啟獨立 QR Code 彈窗
 */
function openQrModal(url, title) {
    const modal = document.getElementById('qrOnlyModal');
    const titleEl = document.getElementById('qrModalTitle');
    const urlInput = document.getElementById('qrModalUrl');
    const container = document.getElementById('qrOnlyContainer');

    if (titleEl) titleEl.textContent = title || '手機掃描二維碼';
    if (urlInput) urlInput.value = url;

    if (container) {
        renderQrCode(container, url, 172);
    }

    if (modal) modal.classList.add('show');
}

/**
 * 關閉獨立 QR Code 彈窗
 */
function closeQrModal() {
    const modal = document.getElementById('qrOnlyModal');
    if (modal) modal.classList.remove('show');
}

/**
 * HTML 跳脫防 XSS 輔助
 */
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ==========================================================================
   五、 Google 帳戶登入與個人空間管理模組 (Google Identity Services)
   ========================================================================== */

let googleAuthClientId = '';

/**
 * 解析 Google 回傳的 JWT Credential Token
 */
function parseJwt(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(c => {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (e) {
        console.warn('JWT 解析失敗:', e);
        return null;
    }
}

/**
 * 初始化 Google Identity Services 官方登入庫
 */
async function initGoogleAuth() {
    // 優先讀取伺服器端環境變數配置，其次讀取瀏覽器覆寫設定
    try {
        const res = await fetch('/api/auth/config');
        const data = await res.json();
        if (data.google_client_id) {
            googleAuthClientId = data.google_client_id;
        }
    } catch (e) {
        console.warn('無法取得後端 Google Client ID 配置');
    }

    const localOverride = localStorage.getItem('webforge_google_client_id');
    if (localOverride) {
        googleAuthClientId = localOverride;
    }

    // 更新介面身分狀態
    updateUserAuthUI();

    // 如果已有 Client ID 且 Google GSI 腳本就緒，完成授權初始化
    if (googleAuthClientId && window.google?.accounts?.id) {
        try {
            google.accounts.id.initialize({
                client_id: googleAuthClientId,
                callback: handleGoogleCredentialResponse,
                auto_select: false,
                cancel_on_tap_outside: true
            });

            // 渲染隱藏按鈕備用
            const hiddenBox = document.getElementById('g_id_signin_hidden');
            if (hiddenBox) {
                google.accounts.id.renderButton(hiddenBox, { theme: 'outline', size: 'large' });
            }

            // 若目前為未登入狀態，同步在登入門檻卡片中渲染官方登入按鈕
            renderGoogleGateButton();
        } catch (err) {
            console.warn('Google 帳戶初始化警告:', err);
        }
    }
}

/**
 * 在登入驗證門檻卡片中渲染 Google 官方安全按鈕
 */
function renderGoogleGateButton() {
    const gateBox = document.getElementById('g_id_signin_gate');
    if (gateBox && window.google?.accounts?.id && googleAuthClientId) {
        try {
            gateBox.innerHTML = '';
            google.accounts.id.renderButton(gateBox, {
                theme: 'filled_blue',
                size: 'large',
                text: 'signin_with',
                shape: 'rectangular',
                width: 280
            });
        } catch (e) {
            console.warn('無法渲染官方 Google Gate 按鈕:', e);
        }
    }
}

/**
 * Google 登入成功回調函式
 */
function handleGoogleCredentialResponse(response) {
    if (!response || !response.credential) {
        showToast('Google 登入未完成', 'error');
        return;
    }

    const payload = parseJwt(response.credential);
    if (!payload || !payload.sub) {
        showToast('無效的 Google 身分憑證', 'error');
        return;
    }

    const googleUser = {
        id: 'google_' + payload.sub,
        name: payload.name || payload.given_name || 'Google 使用者',
        email: payload.email || '',
        picture: payload.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(payload.name || 'G')}&background=6366f1&color=fff`,
        type: 'google'
    };

    localStorage.setItem('webforge_user', JSON.stringify(googleUser));
    updateUserAuthUI();
    closeGoogleConfigModal();
    showToast(`🎉 歡迎回來，${googleUser.name}！已解鎖進入您的專屬空間`, 'success');

    // 重新載入屬於該 Google 帳號的網站清單
    loadSitesList();
}

/**
 * 更新全站登入狀態 UI（強制 Google 帳戶登入門檻）
 */
function updateUserAuthUI() {
    const user = getLoggedInUser();
    const guestBox = document.getElementById('authGuestBox');
    const userBox = document.getElementById('authUserBox');
    const avatarImg = document.getElementById('userAvatarImg');
    const nameText = document.getElementById('userNameText');
    const ddName = document.getElementById('userDropdownName');
    const ddEmail = document.getElementById('userDropdownEmail');
    const manageTitle = document.getElementById('manageTitle');
    const manageSubtitle = document.getElementById('manageSubtitle');

    const loginGate = document.getElementById('loginGate');
    const mainAppContent = document.getElementById('mainAppContent');
    const navTabs = document.getElementById('navTabs');

    if (user && user.id) {
        // 已登入狀態：隱藏登入門檻，解鎖顯示主工作區域與導航分頁
        if (loginGate) loginGate.style.display = 'none';
        if (mainAppContent) mainAppContent.style.display = 'block';
        if (navTabs) navTabs.style.display = 'flex';

        if (guestBox) guestBox.style.display = 'none';
        if (userBox) userBox.style.display = 'inline-flex';

        if (avatarImg) avatarImg.src = user.picture || 'https://ui-avatars.com/api/?name=User&background=6366f1&color=fff';
        if (nameText) nameText.textContent = user.name || '我的帳號';
        if (ddName) ddName.textContent = user.name || 'Google 使用者';
        if (ddEmail) ddEmail.textContent = user.email || '專屬帳號已連接';

        if (manageTitle) manageTitle.textContent = `「${user.name}」的專屬在線網站`;
        if (manageSubtitle) manageSubtitle.textContent = `已綁定 Google 帳號（${user.email || user.name}），無論手機或任何電腦登入皆能完整同步與管理！`;
    } else {
        // 未登入狀態：強制顯示登入門檻卡片，鎖定主要工作區與分頁
        if (loginGate) loginGate.style.display = 'flex';
        if (mainAppContent) mainAppContent.style.display = 'none';
        if (navTabs) navTabs.style.display = 'none';

        if (guestBox) guestBox.style.display = 'inline-flex';
        if (userBox) userBox.style.display = 'none';

        renderGoogleGateButton();
    }
}

/**
 * 點擊「Google 登入」按鈕
 */
function triggerGoogleLogin() {
    // 檢查是否有配置 Client ID
    if (!googleAuthClientId) {
        openGoogleConfigModal();
        return;
    }

    if (window.google?.accounts?.id) {
        try {
            google.accounts.id.prompt((notification) => {
                if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
                    // 若 One Tap 浮窗受阻，嘗試點擊隱藏按鈕
                    const hiddenBtn = document.querySelector('#g_id_signin_hidden div[role=button]');
                    if (hiddenBtn) {
                        hiddenBtn.click();
                    } else {
                        openGoogleConfigModal();
                    }
                }
            });
        } catch (e) {
            openGoogleConfigModal();
        }
    } else {
        openGoogleConfigModal();
    }
}

/**
 * 儲存使用者自訂的 Google Client ID
 */
function saveGoogleClientId() {
    const input = document.getElementById('googleClientIdInput');
    const val = (input?.value || '').trim();

    if (!val) {
        showToast('請輸入有效的 Google OAuth Client ID！', 'error');
        return;
    }

    if (!val.includes('.apps.googleusercontent.com')) {
        showToast('Client ID 格式通常應為 xxxx.apps.googleusercontent.com', 'error');
    }

    localStorage.setItem('webforge_google_client_id', val);
    googleAuthClientId = val;

    showToast('✅ Google Client ID 儲存成功，正在重新初始化...', 'success');
    closeGoogleConfigModal();

    // 重新載入授權
    initGoogleAuth();
    setTimeout(() => {
        triggerGoogleLogin();
    }, 500);
}

/**
 * 快速切換自訂身分（讓使用者在尚未建立 Client ID 時也能立刻體驗獨立空間）
 */
function simulateGoogleLogin() {
    const input = document.getElementById('customUserEmailInput');
    const email = (input?.value || '').trim();

    if (!email || !email.includes('@')) {
        showToast('請輸入有效的電子郵件格式！', 'error');
        return;
    }

    const name = email.split('@')[0];
    const user = {
        id: 'google_sim_' + btoa(email.toLowerCase()).replace(/=/g, ''),
        name: name.charAt(0).toUpperCase() + name.slice(1),
        email: email.toLowerCase(),
        picture: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=6366f1&color=fff`,
        type: 'google'
    };

    localStorage.setItem('webforge_user', JSON.stringify(user));
    updateUserAuthUI();
    closeGoogleConfigModal();
    showToast(`🎉 已成功切換至帳號「${user.email}」專屬空間！`, 'success');
    loadSitesList();
}

/**
 * 登出 Google 帳戶（重新鎖定並返回登入門檻）
 */
function logoutGoogleUser() {
    if (confirm('確定要登出目前帳號嗎？登出後將返回 Google 帳號登入畫面。')) {
        localStorage.removeItem('webforge_user');
        closeUserMenu();
        updateUserAuthUI();
        showToast('已安全登出 Google 帳戶，請登入後繼續使用', 'info');
    }
}

/**
 * 使用者下拉選單開關
 */
function toggleUserMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('userDropdownMenu');
    if (menu) {
        menu.classList.toggle('show');
    }
}

function closeUserMenu() {
    const menu = document.getElementById('userDropdownMenu');
    if (menu) menu.classList.remove('show');
}

function openGoogleConfigModal() {
    const modal = document.getElementById('googleConfigModal');
    const input = document.getElementById('googleClientIdInput');
    if (input && googleAuthClientId) {
        input.value = googleAuthClientId;
    }
    if (modal) modal.classList.add('show');
}

function closeGoogleConfigModal() {
    const modal = document.getElementById('googleConfigModal');
    if (modal) modal.classList.remove('show');
}

// 註冊至全域 window，確保 HTML inline onclick 呼叫相容
window.clearEditor = clearEditor;
window.refreshPreview = refreshPreview;
window.setViewport = setViewport;
window.switchTab = switchTab;
window.publishSite = publishSite;
window.copyModalUrl = copyModalUrl;
window.closeShareModal = closeShareModal;
window.toggleTemplateMenu = toggleTemplateMenu;
window.loadTemplate = loadTemplate;
window.handleFileUpload = handleFileUpload;
window.loadSitesList = loadSitesList;
window.filterSitesList = filterSitesList;
window.deleteSite = deleteSite;
window.openQrModal = openQrModal;
window.closeQrModal = closeQrModal;
window.renderQrCode = renderQrCode;
window.setSiteScope = setSiteScope;
window.triggerGoogleLogin = triggerGoogleLogin;
window.openGoogleConfigModal = openGoogleConfigModal;
window.closeGoogleConfigModal = closeGoogleConfigModal;
window.saveGoogleClientId = saveGoogleClientId;
window.simulateGoogleLogin = simulateGoogleLogin;
window.toggleUserMenu = toggleUserMenu;
window.closeUserMenu = closeUserMenu;
window.logoutGoogleUser = logoutGoogleUser;

/* ==========================================================================
   六、 頁面生命週期初始化
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // 1. 初始化網絡資訊
    fetchNetworkInfo();

    // 2. 初始化 HTML 編輯器監聽與即時預覽
    initEditorEvents();

    // 3. 初始化 Google 帳戶登入狀態與配置
    initGoogleAuth();

    // 4. 預先抓取已發布網站數量
    loadSitesList();

    // 5. 綁定發布按鈕點擊事件
    const publishBtn = document.getElementById('publishBtn');
    if (publishBtn) {
        publishBtn.addEventListener('click', publishSite);
    }

    // 6. 點擊頁面其他空白處時關閉選單（範本選單 & 使用者下拉選單）
    document.addEventListener('click', (e) => {
        const selector = document.querySelector('.template-selector');
        const templateMenu = document.getElementById('templateMenu');
        if (templateMenu && selector && !selector.contains(e.target)) {
            templateMenu.classList.remove('show');
        }

        const userSection = document.getElementById('userAuthSection');
        const userDropdown = document.getElementById('userDropdownMenu');
        if (userDropdown && userSection && !userSection.contains(e.target)) {
            userDropdown.classList.remove('show');
        }
    });

    // 7. 點擊彈窗遮罩背景或按 ESC 鍵可關閉彈窗
    const shareModal = document.getElementById('shareModal');
    const qrOnlyModal = document.getElementById('qrOnlyModal');
    const googleModal = document.getElementById('googleConfigModal');

    [shareModal, qrOnlyModal, googleModal].forEach(modal => {
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    closeShareModal();
                    closeQrModal();
                    closeGoogleConfigModal();
                }
            });
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeShareModal();
            closeQrModal();
            closeGoogleConfigModal();
        }
    });
});


