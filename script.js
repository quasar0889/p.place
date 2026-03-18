// DOM Elements
const container = document.getElementById('canvas-container');
const wrapper = document.getElementById('canvas-wrapper');
const canvas = document.getElementById('place-canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const previewCanvas = document.getElementById('preview-canvas');
const previewCtx = previewCanvas.getContext('2d', { alpha: true });

// キャンバス設定 (5000x5000のキャンバス上に、1マスの大きさを10で描画＝500x500グリッド=25万マス)
const CANVAS_SIZE = 5000;
const GRID_SIZE = 500;
const PIXEL_SIZE = CANVAS_SIZE / GRID_SIZE; // 1マス10px

// αチャンネルOFF時のデフォルト黒画面を防ぐため、スクリプト実行直後に白く塗る
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

// Supabase Configuration
const SUPABASE_URL = 'https://lwuaavonmiwmxtthjtju.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx3dWFhdm9ubWl3bXh0dGhqdGp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzQ1NTQsImV4cCI6MjA4OTE1MDU1NH0.bs35thHMO50xoi7lz_7adeqg6yOeHmh_jKlfR0xDsQ0';
let supabase = null;
try {
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (err) {
  setTimeout(() => alert("【💡ヒント】\nSupabaseのURLが初期値のままか、間違っているため通信エラーが発生しました。\nscript.js の中の SUPABASE_URL と ANON_KEY を正しくセットしてください！"), 500);
}

// アプリケーションの状態
let myColor = '#000000';
let activeTool = 'draw'; // 'draw', 'move', or 'image'
let stampPixels = null; // 画像変換後のピクセル情報、管理者専用

// 管理者フラグ (?admin=true で起動)
const isAdmin = new URLSearchParams(window.location.search).get('admin') === 'true';

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

  if (!supabase) return; // Supabase設定エラー時は通信を行わない

  const { data: pixels, error } = await supabase.from('pixels').select('id, x, y, color');
  if (error) {
    console.error('データの取得に失敗しました:', error);
  } else if (pixels) {
    pixels.forEach(p => drawPixelLocal(p.x, p.y, p.color));
  }

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
  if (!supabase) return; // 未設定時は何もしない
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

// --- イベントリスナー管理 --- //
const activePointers = new Map();
let isDrawingPhase = false;
let isPanningPhase = false;
let lastLogicalX = null;
let lastLogicalY = null;
let lastPanX = 0;
let lastPanY = 0;
let lastPinchCenter = null;
let lastPinchDistance = null;

function renderPreviewOverlay(clientX, clientY) {
  previewCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  if (activeTool !== 'image' || !stampPixels) return;

  const { x: gridX, y: gridY } = getLogicalPos(clientX, clientY);
  stampPixels.forEach(p => {
    const px = gridX + p.dx;
    const py = gridY + p.dy;
    if (px >= 0 && px < GRID_SIZE && py >= 0 && py < GRID_SIZE) {
      previewCtx.fillStyle = p.color;
      previewCtx.fillRect(px * PIXEL_SIZE, py * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE);
    }
  });
}

function handlePointerDown(e) {
  // UI上の操作はキャンバスイベントとして発火しない
  if (e.target.closest('#ui-container')) return;
  
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 1) {
    // 【1本指・クリック】
    const isForcePan = e.button === 1 || e.button === 2;
    if (activeTool === 'move' || isForcePan) {
      isPanningPhase = true;
      isDrawingPhase = false;
      lastPanX = e.clientX;
      lastPanY = e.clientY;
    } else if (activeTool === 'image' && stampPixels) {
      // 一括画像スタンプの配置処理
      const { x: gridX, y: gridY } = getLogicalPos(e.clientX, e.clientY);
      const newRows = [];
      
      stampPixels.forEach(p => {
        const px = gridX + p.dx;
        const py = gridY + p.dy;
        if (px >= 0 && px < GRID_SIZE && py >= 0 && py < GRID_SIZE) {
          drawPixelLocal(px, py, p.color);
          newRows.push({ id: `${px}_${py}`, x: px, y: py, color: p.color });
        }
      });

      if (newRows.length > 0 && supabase) {
        // バルクインサート（一括送信）
        supabase.from('pixels').upsert(newRows).then(({ error }) => {
          if (error) console.error('スタンプレースに失敗:', error);
        });
      }
      isDrawingPhase = false;
      isPanningPhase = false;

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
    isDrawingPhase = false;
    isPanningPhase = false;
    
    const ptrs = Array.from(activePointers.values());
    const [p1, p2] = ptrs;
    
    lastPinchDistance = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    lastPinchCenter = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  }
}

function handlePointerMove(e) {
  // マウスホバー処理（プレビューを描画する）
  if (!activePointers.has(e.pointerId)) {
    if (activeTool === 'image') renderPreviewOverlay(e.clientX, e.clientY);
    return;
  }
  
  // ポインター位置の更新
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 1) {
    // 【1本指】
    if (isPanningPhase) {
      const dx = e.clientX - lastPanX;
      const dy = e.clientY - lastPanY;
      translateX += dx;
      translateY += dy;
      lastPanX = e.clientX;
      lastPanY = e.clientY;
      updateTransform();
    } else if (isDrawingPhase) {
      const { x, y } = getLogicalPos(e.clientX, e.clientY);
      if (x !== lastLogicalX || y !== lastLogicalY) {
        if (lastLogicalX !== null && lastLogicalY !== null) {
          drawLine(lastLogicalX, lastLogicalY, x, y); 
        } else {
          putPixel(x, y);
        }
        lastLogicalX = x;
        lastLogicalY = y;
      }
    } else if (activeTool === 'image') {
       // ドラッグ中にも一応プレビューを更新する
       renderPreviewOverlay(e.clientX, e.clientY);
    }

  } else if (activePointers.size === 2) {
    // 【2本指】
    e.preventDefault(); 
    
    const ptrs = Array.from(activePointers.values());
    const [p1, p2] = ptrs;
    
    const currentDistance = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const currentCenter = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

    if (lastPinchCenter && lastPinchDistance) {
      const dx = currentCenter.x - lastPinchCenter.x;
      const dy = currentCenter.y - lastPinchCenter.y;
      translateX += dx;
      translateY += dy;

      if (lastPinchDistance > 0) {
        const zoomFactor = currentDistance / lastPinchDistance;
        let newScale = scale * zoomFactor;
        newScale = Math.max(MIN_SCALE, Math.min(newScale, MAX_SCALE));
        translateX = currentCenter.x - (currentCenter.x - translateX) * (newScale / scale);
        translateY = currentCenter.y - (currentCenter.y - translateY) * (newScale / scale);
        scale = newScale;
      }
      
      updateTransform();
    }
    
    lastPinchDistance = currentDistance;
    lastPinchCenter = currentCenter;
  }
}

function handlePointerUpOrCancel(e) {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) {
    lastPinchCenter = null;
    lastPinchDistance = null;
  }
  if (activePointers.size === 0 || activePointers.size === 1) {
    isDrawingPhase = false;
    isPanningPhase = false;
    lastLogicalX = null;
    lastLogicalY = null;
  }
}

function handleWheel(evt) {
  if (evt.target.closest('#ui-container')) return;
  evt.preventDefault();
  
  const zoomSensitivity = 0.0015;
  const delta = -evt.deltaY * zoomSensitivity;
  
  let newScale = scale * Math.exp(delta);
  newScale = Math.max(MIN_SCALE, Math.min(newScale, MAX_SCALE));

  const mouseX = evt.clientX;
  const mouseY = evt.clientY;
  
  translateX = mouseX - (mouseX - translateX) * (newScale / scale);
  translateY = mouseY - (mouseY - translateY) * (newScale / scale);
  scale = newScale;
  
  updateTransform();

  // ズーム後もプレビューを正しい位置へ描画
  if (activeTool === 'image') renderPreviewOverlay(mouseX, mouseY);
}

// イベントリスナー登録
container.addEventListener('pointerdown', handlePointerDown);
window.addEventListener('pointermove', handlePointerMove, { passive: false });
window.addEventListener('pointerup', handlePointerUpOrCancel);
window.addEventListener('pointercancel', handlePointerUpOrCancel);
container.addEventListener('wheel', handleWheel, { passive: false });
container.addEventListener('contextmenu', e => {
  if (!e.target.closest('#ui-container')) e.preventDefault(); 
});

// --- UI セットアップ --- //
function setupUI() {
  const btnDraw = document.getElementById('btn-draw');
  const btnMove = document.getElementById('btn-move');
  const btnImage = document.getElementById('btn-image');
  const imageUpload = document.getElementById('image-upload');
  
  // ?admin=true なら管理者ツールを表示
  if (isAdmin) {
    btnImage.style.display = 'block';
  }

  function switchTool(tool) {
    activeTool = tool;
    btnDraw.classList.toggle('active', tool === 'draw');
    btnMove.classList.toggle('active', tool === 'move');
    btnImage.classList.toggle('active', tool === 'image');
    
    if (tool === 'move') {
      container.style.cursor = 'grab';
    } else if (tool === 'draw') {
      container.style.cursor = 'crosshair';
    } else if (tool === 'image') {
      // スタンププレビューを見やすくするためカーソルを非表示
      container.style.cursor = 'none';
    }
    
    if (tool !== 'image') {
      previewCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    }
  }

  btnDraw.addEventListener('click', () => switchTool('draw'));
  btnMove.addEventListener('click', () => switchTool('move'));
  btnImage.addEventListener('click', () => imageUpload.click());

  // 画像アップロード・変換処理
  imageUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      
      // データベース負荷軽減のため、最大50x50ピクセルまで強制的に圧縮
      const MAX_STAMP_SIZE = 50; 
      let w = img.width;
      let h = img.height;
      if (w > MAX_STAMP_SIZE || h > MAX_STAMP_SIZE) {
        const ratio = Math.min(MAX_STAMP_SIZE / w, MAX_STAMP_SIZE / h);
        w = Math.floor(w * ratio);
        h = Math.floor(h * ratio);
      }
      
      const offCanvas = document.createElement('canvas');
      offCanvas.width = w;
      offCanvas.height = h;
      const offCtx = offCanvas.getContext('2d');
      offCtx.drawImage(img, 0, 0, w, h);
      
      const imgData = offCtx.getImageData(0, 0, w, h).data;
      stampPixels = [];
      
      // 画像ピクセルを相対座標ドット一覧に変換
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = imgData[i];
          const g = imgData[i+1];
          const b = imgData[i+2];
          const a = imgData[i+3];
          
          if (a > 128) { // 半透明以下のピクセルは無視
            const hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
            // マウスカーソルが中心になるよう dx, dy をオフセット
            stampPixels.push({ dx: x - Math.floor(w/2), dy: y - Math.floor(h/2), color: hex });
          }
        }
      }
      switchTool('image');
      imageUpload.value = ''; // 同じ画像でも繰り返し選択できるようにリセット
    };
    img.src = url;
  });
  
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName.toLowerCase() === 'input') return;
    if (e.key.toLowerCase() === 'p') switchTool('draw');
    if (e.key.toLowerCase() === 'h') switchTool('move');
  });

  const swatches = document.querySelectorAll('.color-swatch');
  const colorPicker = document.getElementById('color-picker');

  function setColor(color, triggerEl) {
    myColor = color;
    swatches.forEach(s => s.classList.remove('active'));
    if (triggerEl && triggerEl.classList.contains('color-swatch')) {
      triggerEl.classList.add('active');
    }
    colorPicker.value = color; 
    switchTool('draw'); 
  }

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
