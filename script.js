// Supabase Configuration
// TODO: あなたのSupabaseプロジェクトのURLとAnon Keyに書き換えてください。
const SUPABASE_URL = 'https://lwuaavonmiwmxtthjtju.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx3dWFhdm9ubWl3bXh0dGhqdGp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzQ1NTQsImV4cCI6MjA4OTE1MDU1NH0.bs35thHMO50xoi7lz_7adeqg6yOeHmh_jKlfR0xDsQ0';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// DOM Elements
const container = document.getElementById('canvas-container');
const wrapper = document.getElementById('canvas-wrapper');
const canvas = document.getElementById('place-canvas');
const ctx = canvas.getContext('2d', { alpha: false });

// キャンバス設定 (5000x5000のキャンバス上に、1マスの大きさを10で描画＝500x500グリッド=25万マス)
const CANVAS_SIZE = 5000;
const GRID_SIZE = 500;
const PIXEL_SIZE = CANVAS_SIZE / GRID_SIZE; // 1マス10px

// アプリケーションの状態
let myColor = '#000000';
let activeTool = 'draw'; // 'draw' または 'move'

// ビューポート（移動・ズーム）の状態
let scale = 1;
if (window.innerWidth < 1000) scale = 0.2; // スマホなどでは最初引いて全体を見せる
else scale = 0.5;

const MIN_SCALE = 0.05; // 最大まで引く
const MAX_SCALE = 10;   // 最大まで寄る

// 画面中央にキャンバスの中心を配置
let translateX = (window.innerWidth - CANVAS_SIZE * scale) / 2;
let translateY = (window.innerHeight - CANVAS_SIZE * scale) / 2;

// --- CSS Transform による移動・ズーム --- //
function updateTransform() {
  wrapper.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
}

// 実際の画面のクリック位置から、ズームと移動を加味したキャンバス上のグリッド座標を割り出す
function getLogicalPos(screenX, screenY) {
  const canvasLocalX = (screenX - translateX) / scale;
  const canvasLocalY = (screenY - translateY) / scale;
  return {
    x: Math.floor(canvasLocalX / PIXEL_SIZE),
    y: Math.floor(canvasLocalY / PIXEL_SIZE)
  };
}

// --- 初期化とSupabase通信 --- //
async function init() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  updateTransform();
  setupUI();

  // 既存のドットをロード
  const { data: pixels, error } = await supabase.from('pixels').select('id, x, y, color');
  if (error) {
    console.error('データの取得に失敗しました:', error);
  } else if (pixels) {
    pixels.forEach(p => drawPixelLocal(p.x, p.y, p.color));
  }

  // リアルタイム購読
  supabase
    .channel('public:pixels')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pixels' }, payload => {
      const p = payload.new;
      if (p && p.x !== undefined && p.y !== undefined) {
        drawPixelLocal(p.x, p.y, p.color);
      }
    })
    .subscribe();
}

// --- 描画ロジック --- //
function drawPixelLocal(x, y, color) {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
  ctx.fillStyle = color;
  ctx.fillRect(x * PIXEL_SIZE, y * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE);
}

function putPixel(x, y) {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
  drawPixelLocal(x, y, myColor);
  
  const id = `${x}_${y}`;
  // 非同期で送信。待たずに次へ
  supabase.from('pixels').upsert({ id, x, y, color: myColor }).then(({ error }) => {
    if (error) console.error('ドットの配置に失敗:', error);
  });
}

function drawLine(x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  let sx = (x0 < x1) ? 1 : -1;
  let sy = (y0 < y1) ? 1 : -1;
  let err = dx - dy;

  while(true) {
    putPixel(x0, y0);
    if ((x0 === x1) && (y0 === y1)) break;
    let e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

// --- 高度なマルチタッチ・マウスイベントリスナー管理 --- //
// 画面に触れている指（またはマウス）の情報を管理・追跡する
const activePointers = new Map();

// シングルタップ（1本指）での描画・パン用の状態
let isDrawingPhase = false;
let isPanningPhase = false;
let lastLogicalX = null;
let lastLogicalY = null;
let lastPanX = 0;
let lastPanY = 0;

// マルチタッチ（2本指以上）でのパン・ズーム状態
let lastPinchCenter = null;
let lastPinchDistance = null;

function handlePointerDown(e) {
  // UI上の操作はキャンバスイベントとして発火しない
  if (e.target.closest('#ui-container')) return;
  
  // ポインターを記録（Chrome等のマルチタッチ対応）
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 1) {
    // 【1本指・クリック】
    // 中/右クリック、または「移動ツール」が選択されている場合
    const isForcePan = e.button === 1 || e.button === 2;
    if (activeTool === 'move' || isForcePan) {
      isPanningPhase = true;
      isDrawingPhase = false;
      lastPanX = e.clientX;
      lastPanY = e.clientY;
    } else {
      isPanningPhase = false;
      isDrawingPhase = true;
      const { x, y } = getLogicalPos(e.clientX, e.clientY);
      lastLogicalX = x;
      lastLogicalY = y;
      putPixel(x, y);
    }
  } else if (activePointers.size === 2) {
    // 【2本指】
    // 描画モード中であっても2本目の指が置かれたらすべてキャンセリングし、ズーム＆パンに移行
    isDrawingPhase = false;
    isPanningPhase = false;
    
    const ptrs = Array.from(activePointers.values());
    const [p1, p2] = ptrs;
    
    lastPinchDistance = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    lastPinchCenter = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  }
}

function handlePointerMove(e) {
  if (!activePointers.has(e.pointerId)) return;
  
  // ポインター位置の更新
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 1) {
    // 【1本指】
    if (isPanningPhase) {
      // 画面の移動処理
      const dx = e.clientX - lastPanX;
      const dy = e.clientY - lastPanY;
      translateX += dx;
      translateY += dy;
      lastPanX = e.clientX;
      lastPanY = e.clientY;
      updateTransform();
    } else if (isDrawingPhase) {
      // 描画処理
      const { x, y } = getLogicalPos(e.clientX, e.clientY);
      if (x !== lastLogicalX || y !== lastLogicalY) {
        if (lastLogicalX !== null && lastLogicalY !== null) {
          drawLine(lastLogicalX, lastLogicalY, x, y); // スキマを埋める
        } else {
          putPixel(x, y);
        }
        lastLogicalX = x;
        lastLogicalY = y;
      }
    }
  } else if (activePointers.size === 2) {
    // 【2本指】
    e.preventDefault(); // デフォルトのスクロールなどを必ず防ぐ
    
    const ptrs = Array.from(activePointers.values());
    const [p1, p2] = ptrs;
    
    const currentDistance = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const currentCenter = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

    if (lastPinchCenter && lastPinchDistance) {
      // 1. 移動（パン）
      const dx = currentCenter.x - lastPinchCenter.x;
      const dy = currentCenter.y - lastPinchCenter.y;
      translateX += dx;
      translateY += dy;

      // 2. ズーム（拡大・縮小）
      if (lastPinchDistance > 0) {
        const zoomFactor = currentDistance / lastPinchDistance;
        let newScale = scale * zoomFactor;
        newScale = Math.max(MIN_SCALE, Math.min(newScale, MAX_SCALE));
        
        // 2本指の中心を基準にズーム
        translateX = currentCenter.x - (currentCenter.x - translateX) * (newScale / scale);
        translateY = currentCenter.y - (currentCenter.y - translateY) * (newScale / scale);
        scale = newScale;
      }
      
      updateTransform();
    }
    
    // 次回の基準として保存
    lastPinchDistance = currentDistance;
    lastPinchCenter = currentCenter;
  }
}

function handlePointerUpOrCancel(e) {
  // 離れたポインターを削除
  activePointers.delete(e.pointerId);

  // 指の数が減ったらマルチタッチ状態をリセット
  if (activePointers.size < 2) {
    lastPinchCenter = null;
    lastPinchDistance = null;
  }

  // もし1本の指が離れ、もう1本が残っているとしても一旦リセットする（不自然な挙動を防ぐ）
  if (activePointers.size === 0 || activePointers.size === 1) {
    isDrawingPhase = false;
    isPanningPhase = false;
    lastLogicalX = null;
    lastLogicalY = null;
  }
}

// マウスホイールでのズーム
function handleWheel(evt) {
  if (evt.target.closest('#ui-container')) return;
  evt.preventDefault();
  
  const zoomSensitivity = 0.0015;
  const delta = -evt.deltaY * zoomSensitivity;
  
  let newScale = scale * Math.exp(delta);
  newScale = Math.max(MIN_SCALE, Math.min(newScale, MAX_SCALE));

  // マウスカーソルの位置を中心にズームする計算
  const mouseX = evt.clientX;
  const mouseY = evt.clientY;
  
  translateX = mouseX - (mouseX - translateX) * (newScale / scale);
  translateY = mouseY - (mouseY - translateY) * (newScale / scale);
  scale = newScale;
  
  updateTransform();
}

// イベントリスナー登録 (Pointer Events APIを使用)
container.addEventListener('pointerdown', handlePointerDown);
// move, up, cancel は画面外でも追従できるように window にバインド
window.addEventListener('pointermove', handlePointerMove, { passive: false });
window.addEventListener('pointerup', handlePointerUpOrCancel);
window.addEventListener('pointercancel', handlePointerUpOrCancel);
container.addEventListener('wheel', handleWheel, { passive: false });

container.addEventListener('contextmenu', e => {
  if (!e.target.closest('#ui-container')) e.preventDefault(); // キャンバス上の右クリックメニューを無効化（移動に使うため）
});

// --- UI セットアップ --- //
function setupUI() {
  const btnDraw = document.getElementById('btn-draw');
  const btnMove = document.getElementById('btn-move');
  
  function switchTool(tool) {
    activeTool = tool;
    btnDraw.classList.toggle('active', tool === 'draw');
    btnMove.classList.toggle('active', tool === 'move');
    container.style.cursor = tool === 'draw' ? 'crosshair' : 'grab';
  }

  btnDraw.addEventListener('click', () => switchTool('draw'));
  btnMove.addEventListener('click', () => switchTool('move'));
  
  // ショートカットキー対応 (P = Draw, H = Move)
  window.addEventListener('keydown', (e) => {
    // インプット中に発火しないよう制御
    if (e.target.tagName.toLowerCase() === 'input') return;
    
    if (e.key.toLowerCase() === 'p') switchTool('draw');
    if (e.key.toLowerCase() === 'h') switchTool('move');
  });

  // 色パレットとピッカー
  const swatches = document.querySelectorAll('.color-swatch');
  const colorPicker = document.getElementById('color-picker');

  // 色変更処理
  function setColor(color, triggerEl) {
    myColor = color;
    swatches.forEach(s => s.classList.remove('active'));
    if (triggerEl && triggerEl.classList.contains('color-swatch')) {
      triggerEl.classList.add('active');
    }
    colorPicker.value = color; // ピッカーの色も同期
    switchTool('draw'); // 色を変えたら自動的に描画ツールに切り替え
  }

  // デフォルト色を選択状態に
  setColor('#000000', swatches[0]);

  swatches.forEach(swatch => {
    swatch.addEventListener('click', (e) => setColor(swatch.dataset.color, e.target));
  });

  colorPicker.addEventListener('input', (e) => {
    setColor(e.target.value, null);
  });
}

// アプリ開始
init();
