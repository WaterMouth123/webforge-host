"""
WebForge - HTML 即刻發布與網站代碼託管系統
支援：讀取 HTML 代碼、一鍵發布獨立網址、局域網/公網分享、即時預覽、瀏覽計數與站點管理
"""

import os
import sys
import re
import time
import uuid
import sqlite3
import random
import string
import socket
from datetime import datetime
from collections import defaultdict
from flask import Flask, request, jsonify, render_template, send_file, Response, abort, send_from_directory
import io

# 確保在 Windows 繁體中文終端機 (cp950) 下輸出 emoji 與中文不拋出 UnicodeEncodeError
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

app = Flask(__name__)

# 安全限制 1：全域最大請求內容上限設為 2MB，防止惡意超大檔案攻擊
MAX_PAYLOAD_SIZE = 2 * 1024 * 1024  # 2MB
app.config['MAX_CONTENT_LENGTH'] = MAX_PAYLOAD_SIZE

DB_PATH = os.path.join(os.path.dirname(__file__), 'database.db')
PUBLISHED_DIR = os.path.join(os.path.dirname(__file__), 'published_sites')
os.makedirs(PUBLISHED_DIR, exist_ok=True)

# 安全限制 2：記憶體滑動視窗防刷記錄器 (IP -> [timestamp])
rate_limit_records = defaultdict(list)

@app.errorhandler(413)
def request_entity_too_large(error):
    """處理超出 2MB 大小限制的錯誤"""
    return jsonify({
        'success': False,
        'message': '檔案過大！內容超出系統 2MB 上限限制 (413 Payload Too Large)。'
    }), 413

@app.errorhandler(500)
def internal_server_error(error):
    """處理伺服器 500 內部錯誤，API 路由一律回傳 JSON 格式"""
    if request.path.startswith('/api/'):
        return jsonify({
            'success': False,
            'message': '伺服器內部發生異常，請稍候重試。'
        }), 500
    return "伺服器內部異常", 500

@app.errorhandler(404)
def not_found_error(error):
    """處理 404 錯誤，API 路由一律回傳 JSON 格式"""
    if request.path.startswith('/api/'):
        return jsonify({
            'success': False,
            'message': '找不到該 API 端點 (404 Not Found)'
        }), 404
    return error

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sites (
            id TEXT PRIMARY KEY,
            slug TEXT UNIQUE,
            title TEXT NOT NULL,
            html_content TEXT NOT NULL,
            description TEXT,
            view_count INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            is_active INTEGER DEFAULT 1
        )
    ''')
    conn.commit()
    conn.close()

init_db()

def generate_secure_id(length=8):
    """安全生成不可預測的唯一隨機雜湊 ID（基於 UUID4），防範推測與枚舉攻擊"""
    # 產生安全隨機 hex 字串
    token = uuid.uuid4().hex[:length]
    return token

def check_rate_limit(client_ip):
    """
    基於記憶體滑動視窗的頻率防刷限制：
    - 限制單一 IP 在 10 秒內最多發布 3 次
    - 限制單一 IP 在 60 秒內最多發布 12 次
    """
    now = time.time()
    timestamps = rate_limit_records[client_ip]
    # 清理超過 60 秒的過期記錄
    timestamps = [t for t in timestamps if now - t < 60]
    rate_limit_records[client_ip] = timestamps

    # 1. 檢查 10 秒內的短時間爆發連擊
    recent_10s = [t for t in timestamps if now - t < 10]
    if len(recent_10s) >= 3:
        return False, "發布操作過於頻繁（防刷保護），請稍候 10 秒後再試！"

    # 2. 檢查 60 秒內累計次數
    if len(timestamps) >= 12:
        return False, "您在 1 分鐘內發布網站次數過多，請稍候再試！"

    timestamps.append(now)
    return True, None

def get_local_ip():
    """取得電腦在局域網（Wi-Fi 或有線網絡）的 IP 地址，方便其他人訪問"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # 連接到外部常用 DNS 探測本機出站 IP，不需要真的發送資料
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def find_index_html():
    """智慧尋找 index.html，支援 templates/、大小寫不同或根目錄上傳的情況"""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(base_dir, 'templates', 'index.html'),
        os.path.join(base_dir, 'Templates', 'index.html'),
        os.path.join(base_dir, 'index.html'),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
            
    # 全專案遞迴搜尋（排除 .venv）
    for root, dirs, files in os.walk(base_dir):
        if '.venv' in root or '.git' in root or 'published_sites' in root:
            continue
        for file in files:
            if file.lower() == 'index.html':
                return os.path.join(root, file)
    return None

@app.route('/')
def index():
    """首頁管理儀表板（具備雲端 Linux 智慧路徑容錯機制）"""
    index_file = find_index_html()
    if index_file:
        try:
            with open(index_file, 'r', encoding='utf-8') as f:
                return Response(f.read(), mimetype='text/html; charset=utf-8')
        except Exception as e:
            return f"讀取 index.html 發生錯誤: {e}", 500

    base_dir = os.path.dirname(os.path.abspath(__file__))
    existing_files = os.listdir(base_dir)
    return f"""
    <!DOCTYPE html>
    <html lang="zh-TW">
    <head><meta charset="utf-8"><title>WebForge - 找不到首頁</title></head>
    <body style="font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; text-align: center;">
        <div style="background: rgba(255,255,255,0.05); max-width: 600px; margin: 40px auto; padding: 32px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.1);">
            <h2 style="color: #f43f5e; margin-bottom: 16px;">⚠️ 找不到 index.html 首頁檔案</h2>
            <p style="color: #94a3b8; line-height: 1.6;">伺服器已在雲端成功啟動，但在專案目錄中未找到 <code>index.html</code>。</p>
            <p style="color: #cbd5e1; font-size: 0.9rem; margin-top: 16px;">目前根目錄檔案清單：<code>{existing_files}</code></p>
            <p style="color: #38bdf8; margin-top: 20px;">請至 GitHub 儲存庫確認是否已將 <code>templates/index.html</code> 或 <code>index.html</code> 上傳上去！</p>
        </div>
    </body>
    </html>
    """, 404

@app.route('/api/network-info', methods=['GET'])
def network_info():
    """回傳伺服器網絡資訊（本機 IP 與 PORT）"""
    port = request.environ.get('SERVER_PORT', 5000)
    local_ip = get_local_ip()
    host_header = request.host
    return jsonify({
        'local_ip': local_ip,
        'port': port,
        'current_host': host_header,
        'lan_url': f"http://{local_ip}:{port}",
        'local_url': f"http://localhost:{port}"
    })

@app.route('/api/sites', methods=['GET'])
def list_sites():
    """取得所有已發布網站清單"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT id, slug, title, description, view_count, created_at, updated_at FROM sites WHERE is_active = 1 ORDER BY created_at DESC')
    rows = cursor.fetchall()
    sites = [dict(row) for row in rows]
    conn.close()
    return jsonify({'success': True, 'sites': sites})

@app.route('/api/publish', methods=['POST'])
@app.route('/api/save', methods=['POST'])
@app.route('/api/sites', methods=['POST'])
@app.route('/api/generate', methods=['POST'])
def create_site():
    """接收 HTML 代碼並生成發布站點，儲存至 published_sites/ 目錄與 SQLite，回傳唯一 ID 與完整訪問連結"""
    # 安全防護 1：簡單防刷頻率限制（Rate Limiting）
    client_ip = request.headers.get('X-Forwarded-For', request.remote_addr or '127.0.0.1').split(',')[0].strip()
    allowed, limit_msg = check_rate_limit(client_ip)
    if not allowed:
        return jsonify({'success': False, 'message': limit_msg}), 429

    data = request.get_json(force=True, silent=True) or {}
    # 同時相容 html 與 html_content 欄位
    html_content = (data.get('html') or data.get('html_content') or '').strip()
    title = (data.get('title') or '').strip() or '未命名網站'
    description = (data.get('description') or '').strip()
    custom_slug = (data.get('slug') or '').strip()

    if not html_content:
        return jsonify({'success': False, 'message': '請提供 HTML 代碼內容！'}), 400

    # 安全防護 2：檔案大小限制（嚴格限制 2MB 上限）
    content_bytes = html_content.encode('utf-8')
    if len(content_bytes) > MAX_PAYLOAD_SIZE:
        size_mb = len(content_bytes) / (1024 * 1024)
        return jsonify({
            'success': False,
            'message': f'HTML 檔案過大 ({size_mb:.2f}MB)，已超出 2MB 系統限制 (413 Payload Too Large)！'
        }), 413

    conn = get_db()
    cursor = conn.cursor()

    # 安全防護 3：生成安全的不可預測雜湊唯一 ID（基於 UUID4），確保唯一性
    site_id = generate_secure_id(8)
    while True:
        cursor.execute('SELECT id FROM sites WHERE id = ?', (site_id,))
        if not cursor.fetchone():
            break
        site_id = generate_secure_id(8)

    slug = site_id
    if custom_slug:
        # 嚴格正則白名單過濾自訂別名（只允許小寫英數字與破折號、底線，嚴格防範目錄遍歷路徑字符如 .. 或 / 等）
        sanitized_slug = re.sub(r'[^a-zA-Z0-9_-]', '', custom_slug).lower().strip('-_')
        # 限制長度與系統保留字
        if sanitized_slug and sanitized_slug not in ('api', 'site', 'published', 'download', 'static', 'con', 'prn', 'aux', 'nul'):
            sanitized_slug = sanitized_slug[:32]
            cursor.execute('SELECT id FROM sites WHERE slug = ?', (sanitized_slug,))
            if cursor.fetchone():
                conn.close()
                return jsonify({'success': False, 'message': f'自訂網址別名「{sanitized_slug}」已被使用，請換一個！'}), 400
            slug = sanitized_slug

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    # 安全防護 4：實體儲存檔名與路徑防範目錄遍歷（Directory Traversal）
    file_name = f"{slug}.html"
    file_path = os.path.abspath(os.path.join(PUBLISHED_DIR, file_name))
    base_published_dir = os.path.abspath(PUBLISHED_DIR)

    # 確保最終檔案絕對路徑嚴格在 published_sites 目錄內
    if not file_path.startswith(base_published_dir + os.sep):
        conn.close()
        return jsonify({'success': False, 'message': '非法的路徑或檔名！'}), 400

    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(html_content)
    except Exception as e:
        conn.close()
        return jsonify({'success': False, 'message': f'檔案儲存失敗：{str(e)}'}), 500

    # 同步寫入 SQLite 資料庫進行管理與計數
    cursor.execute('''
        INSERT INTO sites (id, slug, title, html_content, description, view_count, created_at, updated_at, is_active)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1)
    ''', (site_id, slug, title, html_content, description, now, now))
    conn.commit()
    conn.close()

    port = request.environ.get('SERVER_PORT', 5000)
    if ':' in request.host:
        try:
            port = int(request.host.split(':')[-1])
        except Exception:
            pass

    # 判斷連線協定與 Public URL (支援 Render / Railway 等雲端反向代理的 HTTPS)
    proto = request.headers.get('X-Forwarded-Proto', request.scheme)
    base_host_url = f"{proto}://{request.host}".rstrip('/')
    public_access_url = f"{base_host_url}/site/{slug}"

    local_ip = get_local_ip()
    lan_url = f"http://{local_ip}:{port}/site/{slug}"
    local_url = f"http://localhost:{port}/site/{slug}"

    # 若當前是公網訪問（非 localhost 或 127.0.0.1），優先以公網 URL 作為主要分享連結
    is_public = not ('localhost' in request.host or '127.0.0.1' in request.host or local_ip in request.host)
    primary_url = public_access_url if is_public else lan_url

    # 包含一級欄位（方便直接取用）與 site 物件（相容既有架構）
    return jsonify({
        'success': True,
        'message': '網站已成功生成並發布！',
        'id': site_id,
        'slug': slug,
        'title': title,
        'url': primary_url,         # 雲端公網或區域網路訪問的完整網址
        'lan_url': lan_url,
        'local_url': local_url,
        'current_access_url': public_access_url,
        'path': f"/site/{slug}",    # 公開訪問路徑
        'file_path': f"published_sites/{file_name}",
        'site': {
            'id': site_id,
            'slug': slug,
            'title': title,
            'description': description,
            'view_count': 0,
            'created_at': now,
            'url': lan_url,
            'lan_url': lan_url,
            'local_url': local_url,
            'current_access_url': public_access_url,
            'path': f"/site/{slug}",
            'file_path': f"published_sites/{file_name}"
        }
    })

@app.route('/api/sites/<site_id>', methods=['GET'])
def get_site_detail(site_id):
    """取得單一網站詳情（含 HTML 代碼）供編輯使用"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM sites WHERE (id = ? OR slug = ?) AND is_active = 1', (site_id, site_id))
    row = cursor.fetchone()
    conn.close()
    if not row:
        return jsonify({'success': False, 'message': '找不到該站點'}), 404
    return jsonify({'success': True, 'site': dict(row)})

@app.route('/api/sites/<site_id>', methods=['PUT'])
def update_site(site_id):
    """更新網站內容"""
    data = request.get_json(force=True, silent=True) or {}
    html_content = data.get('html_content', '').strip()
    title = data.get('title', '').strip()
    description = data.get('description', '').strip()

    if not html_content:
        return jsonify({'success': False, 'message': 'HTML 代碼不能為空'}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT id FROM sites WHERE id = ? AND is_active = 1', (site_id,))
    if not cursor.fetchone():
        conn.close()
        return jsonify({'success': False, 'message': '找不到該站點'}), 404

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    cursor.execute('''
        UPDATE sites 
        SET title = COALESCE(NULLIF(?, ''), title),
            html_content = ?,
            description = ?,
            updated_at = ?
        WHERE id = ?
    ''', (title, html_content, description, now, site_id))
    conn.commit()
    conn.close()

    return jsonify({'success': True, 'message': '站點更新成功！'})

@app.route('/api/sites/<site_id>', methods=['DELETE'])
def delete_site(site_id):
    """刪除網站（軟刪除）"""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('UPDATE sites SET is_active = 0 WHERE id = ? OR slug = ?', (site_id, site_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'message': '站點已成功刪除！'})

@app.route('/site/<slug>')
@app.route('/published/<slug>')
@app.route('/s/<slug>')
def serve_site(slug):
    """直接呈現在線網站，優先讀取 published_sites/ 中的實體 HTML 檔案，回傳 text/html; charset=utf-8"""
    # 支援傳入可能帶有 .html 的情況
    clean_slug = slug[:-5] if slug.endswith('.html') else slug

    # 安全防護：嚴格校驗 slug 格式，防範目錄遍歷攻擊
    if not clean_slug or not re.match(r'^[a-zA-Z0-9_-]+$', clean_slug):
        abort(404, description="抱歉，無效的網站識別代碼。")

    # 1. 優先從 published_sites/ 目錄讀取實體 HTML 檔案
    file_path = os.path.abspath(os.path.join(PUBLISHED_DIR, f"{clean_slug}.html"))
    base_published_dir = os.path.abspath(PUBLISHED_DIR)

    # 確保最終路徑必然落在 published_sites/ 目錄內
    if not file_path.startswith(base_published_dir + os.sep):
        abort(403, description="禁止存取非法路徑。")

    html_content = None

    if os.path.exists(file_path):
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                html_content = f.read()
        except Exception as e:
            print(f"讀取實體檔案異常: {e}")

    # 2. 資料庫查詢與 fallback
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT id, html_content FROM sites WHERE (slug = ? OR id = ?) AND is_active = 1', (clean_slug, clean_slug))
    row = cursor.fetchone()

    if not html_content and not row:
        conn.close()
        abort(404, description="抱歉，此網站不存在或已被移除。")

    if not html_content and row:
        html_content = row['html_content']
        # 自動修復/同步寫入實體檔案
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(html_content)
        except Exception:
            pass

    # 累計瀏覽次數
    if row:
        cursor.execute('UPDATE sites SET view_count = view_count + 1 WHERE id = ?', (row['id'],))
        conn.commit()
    conn.close()

    # 3. 確保回傳標頭明確為 text/html; charset=utf-8
    return Response(
        html_content,
        mimetype='text/html',
        content_type='text/html; charset=utf-8'
    )

@app.route('/download/<slug>')
def download_site(slug):
    """下載 HTML 檔案"""
    clean_slug = slug[:-5] if slug.endswith('.html') else slug
    if not clean_slug or not re.match(r'^[a-zA-Z0-9_-]+$', clean_slug):
        abort(404, description="站點不存在")

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT title, html_content FROM sites WHERE (slug = ? OR id = ?) AND is_active = 1', (clean_slug, clean_slug))
    row = cursor.fetchone()
    conn.close()

    if not row:
        abort(404, description="站點不存在")

    filename = f"{slug}.html"
    return Response(
        row['html_content'],
        mimetype="text/html",
        headers={"Content-disposition": f"attachment; filename={filename}"}
    )

@app.route('/published_sites/<path:filename>')
def serve_published_file(filename):
    """直接訪問 published_sites/ 目錄中的靜態 HTML 檔案"""
    return send_from_directory(PUBLISHED_DIR, filename)

if __name__ == '__main__':
    local_ip = get_local_ip()
    # 支援雲端平台環境變數 PORT（例如 Render 或 Railway 動態分配的 PORT），本機預設 5000
    port = int(os.environ.get('PORT', 5000))
    # 依環境變數判斷是否開啟除錯模式（預設本機開啟，雲端可關閉）
    debug_mode = os.environ.get('FLASK_DEBUG', 'true').lower() in ('true', '1')

    print("=" * 60)
    print("🚀 WebForge HTML 即刻發布器伺服器已啟動！")
    print(f"👉 本機管理控制台:  http://localhost:{port}")
    print(f"👉 區域網路訪問網址: http://{local_ip}:{port}")
    print("   (在同一 Wi-Fi 或內網下的同事/手機皆可透過上方區域網路網址存取！)")
    print("=" * 60)
    app.run(host='0.0.0.0', port=port, debug=debug_mode)
