// 알바 기록장 서버: index.html 제공 + 데이터 JSON 파일 하나 읽기/쓰기. 외부 의존성 없음.
// 실행: node server.js  →  http://localhost:8787  (원격 접속은 tailscale serve 로 HTTPS 연결)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backup');
const DATA_FILE = path.join(DATA_DIR, 'alba-data.json');
const MAX_BODY = 2 * 1024 * 1024;

function isValidData(d) {
  return !!d && Array.isArray(d.workplaces) && Array.isArray(d.shifts) &&
    d.workplaces.every((w) => w && typeof w.id === 'string' && typeof w.name === 'string' && Number.isFinite(w.wage)) &&
    d.shifts.every((s) => s && typeof s.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) &&
      /^\d{2}:\d{2}$/.test(s.start) && /^\d{2}:\d{2}$/.test(s.end));
}

// 데이터 파일이 깨져 있으면 덮어쓰지 않도록 여기서 예외로 멈춘다.
function readStore() {
  if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  // 첫 실행: 브라우저 시절 내보낸 백업이 있으면 그걸로 시작
  const legacy = path.join(BACKUP_DIR, 'alba-backup.json');
  if (fs.existsSync(legacy)) {
    const d = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    if (isValidData(d)) return { rev: 0, data: d };
  }
  return { rev: 0, data: { version: 1, workplaces: [], shifts: [], active: null } };
}

let store = readStore();

function writeStore(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const json = JSON.stringify(next, null, 2);
  fs.writeFileSync(DATA_FILE + '.tmp', json);
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); // 쓰는 도중 꺼져도 원본이 깨지지 않게
  // shortcut: 같은 디스크에 날짜별 스냅샷만 남김, 디스크 고장 대비는 backup 폴더를 클라우드 드라이브로 복사할 때
  fs.writeFileSync(path.join(BACKUP_DIR, `alba-${new Date().toLocaleDateString('sv-SE')}.json`), JSON.stringify(next.data, null, 2));
  store = next;
}

const server = http.createServer((req, res) => {
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  // DNS 리바인딩 차단: 내 PC(localhost)나 Tailscale 주소로 들어온 요청만 받는다
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!(host === 'localhost' || host === '127.0.0.1' || host.endsWith('.ts.net'))) return send(403, { error: 'forbidden host' });

  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return send(200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
  }
  if (url !== '/api/data') return send(404, { error: 'not found' });
  if (req.method === 'GET') return send(200, store);
  if (req.method !== 'PUT') return send(405, { error: 'method not allowed' });

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { send(413, { error: '데이터가 너무 큽니다' }); req.destroy(); } else chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let msg;
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: '잘못된 JSON' }); }
    if (!msg || !isValidData(msg.data)) return send(400, { error: '데이터 형식이 올바르지 않습니다' });
    // 다른 기기가 먼저 저장했으면 거절하고 최신 데이터를 돌려준다
    if (msg.rev !== store.rev) return send(409, store);
    try { writeStore({ rev: store.rev + 1, data: msg.data }); } catch (e) { return send(500, { error: '파일 저장 실패: ' + e.message }); }
    send(200, { rev: store.rev });
  });
});

// 내 PC 안에서만 열고, 외부 접속은 tailscale serve 가 HTTPS로 중계한다 (방화벽 개방 불필요)
server.listen(PORT, '127.0.0.1', () => console.log(`알바 기록장 서버 실행 중: http://localhost:${PORT}`));
