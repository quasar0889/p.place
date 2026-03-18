// Supabase Configuration
// TODO: あなたのSupabaseプロジェクトのURLとAnon Keyに書き換えてください。
const SUPABASE_URL = 'YOUR_SUPABASE_PROJECT_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

// グローバルスコープからsupabaseを取り出す（CDN読み込みの場合）
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const canvas = document.getElementById('place-canvas');
const ctx = canvas.getContext('2d');

// キャンバス設定 (1000x1000のキャンバス上に、1マスの大きさを10で描画＝100x100グリッド)
const CANVAS_SIZE = 1000;
const GRID_SIZE = 100;
const PIXEL_SIZE = CANVAS_SIZE / GRID_SIZE; // 1マス10px

// パレットなし要望のため、ページ読み込み時にユーザーごとにランダムな1色を決定する
const myColor = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');

let isDrawing = false;
let lastLogicalX = null;
let lastLogicalY = null;

// 初期化とデータ取得
async function init() {
  // キャンバスを白で初期化
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // 初期の描画データを取得
  const { data: pixels, error } = await supabase
    .from('pixels')
    .select('*');

  if (error) {
    console.error('データの取得に失敗しました:', error);
  } else if (pixels) {
    pixels.forEach(p => drawPixelLocal(p.x, p.y, p.color));
  }

  // リアルタイム変更の購読
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

// 自分のキャンバス上だけに描画
function drawPixelLocal(x, y, color) {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
  ctx.fillStyle = color;
  ctx.fillRect(x * PIXEL_SIZE, y * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE);
}

// 描画とデータベースへの保存要求
function putPixel(x, y) {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
  
  // リアルタイム反映の遅延をふせぐため、まずローカルで描く
  drawPixelLocal(x, y, myColor);
  
  // 識別用ID
  const id = `${x}_${y}`;
  
  // SupabaseへUpsert（更新か挿入）を実行
  supabase.from('pixels').upsert({ id, x, y, color: myColor }).then(({ error }) => {
    if (error) console.error('ドットの配置に失敗:', error);
  });
}

// なぞったときに隙間ができないように線分上を埋める（Bresenhamの線分描画アルゴリズム）
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

// 実際の画面のクリック・タッチ位置から、論理上の `100x100` グリッドの座標を取り出す
function getLogicalPos(evt) {
  const rect = canvas.getBoundingClientRect();
  // 画面上でのCSSサイズと、内部解像度（1000x1000）の比率
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  
  // 要素内でのX, Y
  let x = (evt.clientX - rect.left) * scaleX;
  let y = (evt.clientY - rect.top) * scaleY;
  
  return {
    x: Math.floor(x / PIXEL_SIZE),
    y: Math.floor(y / PIXEL_SIZE)
  };
}

function handlePointerDown(evt) {
  isDrawing = true;
  const { x, y } = getLogicalPos(evt);
  lastLogicalX = x;
  lastLogicalY = y;
  putPixel(x, y);
}

function handlePointerMove(evt) {
  if (!isDrawing) return;
  const { x, y } = getLogicalPos(evt);
  
  // 動いた時だけ実行
  if (x !== lastLogicalX || y !== lastLogicalY) {
    if (lastLogicalX !== null && lastLogicalY !== null) {
      drawLine(lastLogicalX, lastLogicalY, x, y);
    } else {
      putPixel(x, y);
    }
    lastLogicalX = x;
    lastLogicalY = y;
  }
}

function handlePointerUp() {
  isDrawing = false;
  lastLogicalX = null;
  lastLogicalY = null;
}

// マウス・タッチイベントの両方に対応できる pointer イベントを使用
canvas.addEventListener('pointerdown', handlePointerDown);
canvas.addEventListener('pointermove', handlePointerMove);
window.addEventListener('pointerup', handlePointerUp);

// 最初に処理開始
init();
