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

// 描画・パン用の状態
let isPointerDown = false;
let isPanning = false;
let lastLogicalX = null;
let lastLogicalY = null;
let lastPanX = 0;
let lastPanY = 0;

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
function getLogicalPos(evt) {
  const canvasLocalX = (evt.clientX - translateX) / scale;
  const canvasLocalY = (evt.clientY - translateY) / scale;
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

// --- マウス・タッチイベントリスナー --- //
function handlePointerDown(evt) {
  // UI上のクリックは除外
  if (evt.target.closest('#ui-container')) return;
  
  isPointerDown = true;
  lastPanX = evt.clientX;
  lastPanY = evt.clientY;

  // 右クリック、中クリック、または移動ツールの場合はパン（移動）モード
  isPanning = activeTool === 'move' || evt.button === 1 || evt.button === 2;

  if (!isPanning && activeTool === 'draw') {
    const { x, y } = getLogicalPos(evt);
    lastLogicalX = x;
    lastLogicalY = y;
    putPixel(x, y);
  }
}

function handlePointerMove(evt) {
  if (!isPointerDown) return;

  if (isPanning) {
    // 画面の移動処理
    const dx = evt.clientX - lastPanX;
    const dy = evt.clientY - lastPanY;
    translateX += dx;
    translateY += dy;
    lastPanX = evt.clientX;
    lastPanY = evt.clientY;
    updateTransform();
  } else if (activeTool === 'draw') {
    // 描画処理
    const { x, y } = getLogicalPos(evt);
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
}

function handlePointerUp() {
  isPointerDown = false;
  isPanning = false;
  lastLogicalX = null;
  lastLogicalY = null;
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

// スマホのピンチ操作対応
let initialPinchDistance = null;
let initialScale = 1;
container.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    e.preventDefault();
    initialPinchDistance = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    initialScale = scale;
  }
}, {passive: false});

container.addEventListener('touchmove', e => {
  if (e.touches.length === 2 && initialPinchDistance) {
    e.preventDefault();
    const currentDistance = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const zoomFactor = currentDistance / initialPinchDistance;
    let newScale = initialScale * zoomFactor;
    newScale = Math.max(MIN_SCALE, Math.min(newScale, MAX_SCALE));
    
    // ピンチの中心点を計算
    const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    
    translateX = centerX - (centerX - translateX) * (newScale / scale);
    translateY = centerY - (centerY - translateY) * (newScale / scale);
    scale = newScale;
    updateTransform();
  }
}, {passive: false});

container.addEventListener('touchend', e => {
  if (e.touches.length < 2) initialPinchDistance = null;
});

// イベントリスナー登録
container.addEventListener('pointerdown', handlePointerDown);
window.addEventListener('pointermove', handlePointerMove, { passive: false });
window.addEventListener('pointerup', handlePointerUp);
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
