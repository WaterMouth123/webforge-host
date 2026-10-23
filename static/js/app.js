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
        const response = await fetch('/api/publish', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                html: htmlContent,
                title: title,
                slug: slug
            })
        });

        const data = await response.json();

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

        // 若有離線二維碼繪製庫，動態生成 SVG 二維碼
        if (qrContainer && window.WebForgeQR) {
            qrContainer.innerHTML = window.WebForgeQR.renderSvg(fullAccessUrl, 4, 1);
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
    }
}

// 註冊至全域 window，確保 HTML inline onclick 呼叫相容
window.clearEditor = clearEditor;
window.refreshPreview = refreshPreview;
window.setViewport = setViewport;
window.switchTab = switchTab;
window.publishSite = publishSite;
window.copyModalUrl = copyModalUrl;
window.closeShareModal = closeShareModal;

/* ==========================================================================
   四、 頁面生命週期初始化
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // 1. 初始化網絡資訊
    fetchNetworkInfo();

    // 2. 初始化 HTML 編輯器監聽與即時預覽
    initEditorEvents();

    // 3. 綁定發布按鈕點擊事件
    const publishBtn = document.getElementById('publishBtn');
    if (publishBtn) {
        publishBtn.addEventListener('click', publishSite);
    }

    // 4. 點擊彈窗遮罩背景或按 ESC 鍵可關閉彈窗
    const shareModal = document.getElementById('shareModal');
    if (shareModal) {
        shareModal.addEventListener('click', (e) => {
            if (e.target === shareModal) {
                closeShareModal();
            }
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeShareModal();
        }
    });
});

