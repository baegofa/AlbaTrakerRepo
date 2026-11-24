// 실행: node --test
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('저장 API: 첫 실행 이전, 저장, 충돌, 형식 오류, 호스트 차단', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alba-'));
  const PORT = 18787;
  const legacy = { version: 1, workplaces: [{ id: 'a', name: '카페', wage: 10000 }], shifts: [], active: null };
  fs.writeFileSync(path.join(dir, 'alba-backup.json'), JSON.stringify(legacy));

  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, BACKUP_DIR: dir },
  });
  t.after(() => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve) => srv.stdout.once('data', resolve));

  const url = `http://localhost:${PORT}/api/data`;
  const put = (body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const first = await (await fetch(url)).json();
  assert.deepStrictEqual(first, { rev: 0, data: legacy }, '예전 백업으로 시작');

  const ok = await put({ rev: 0, data: legacy });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await ok.json()).rev, 1);
  assert.ok(fs.existsSync(path.join(dir, 'alba-data.json')), '데이터 파일 생성');

  const stale = await put({ rev: 0, data: legacy });
  assert.strictEqual(stale.status, 409, '옛 rev 저장 거절');
  assert.strictEqual((await stale.json()).rev, 1, '거절 시 최신 데이터 반환');

  assert.strictEqual((await put({ rev: 1, data: { shifts: 'x' } })).status, 400, '형식 오류 거절');

  const status = await new Promise((resolve) => http.get({ port: PORT, path: '/api/data', headers: { Host: 'evil.example' } },
    (r) => { r.resume(); resolve(r.statusCode); }));
  assert.strictEqual(status, 403, '모르는 호스트 차단');
});
