'use strict';
const { parentPort, workerData } = require('worker_threads');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Tạo file tạm ở thư mục hệ thống
const tmpDir = os.tmpdir();
const fileId = crypto.randomBytes(8).toString('hex');

const { code, lang, input, timeoutMs } = workerData;
let tmpFile = '';
let execCmd = '';

try {
  if (lang === 'python') {
    // WRAPPER CHO PYTHON
    tmpFile = path.join(tmpDir, `bot_${fileId}.py`);
    const pyWrapper = `
import sys, json
${code}

if __name__ == "__main__":
    state = json.loads(sys.stdin.read())
    # Gọi hàm move của người chơi và in ra stdout
    print(json.dumps(move(state)))
`;
    fs.writeFileSync(tmpFile, pyWrapper);
    execCmd = `python3 ${tmpFile}`;
    
  } else if (lang === 'cpp') {
    // WRAPPER CHO C++ (Yêu cầu người dùng viết hàm int main() và tự đọc cin)
    tmpFile = path.join(tmpDir, `bot_${fileId}.cpp`);
    const binFile = path.join(tmpDir, `bot_${fileId}`);
    fs.writeFileSync(tmpFile, code);
    
    // Biên dịch (cho phép tối đa 3 giây để build)
    execSync(`g++ ${tmpFile} -o ${binFile}`, { timeout: 3000 });
    execCmd = binFile;
    
  } else {
    // MẶC ĐỊNH LÀ JAVASCRIPT (Wrapper cho Node.js)
    tmpFile = path.join(tmpDir, `bot_${fileId}.js`);
    const jsWrapper = `
${code}
const fs = require('fs');
const state = JSON.parse(fs.readFileSync(0, 'utf-8'));
console.log(JSON.stringify(move(state)));
`;
    fs.writeFileSync(tmpFile, jsWrapper);
    execCmd = `node ${tmpFile}`;
  }

  // CHẠY TIẾN TRÌNH VÀ TRUYỀN DỮ LIỆU QUA STDIN
  const out = execSync(execCmd, { 
    input: input, // Đẩy state cờ dạng chuỗi JSON vào tiến trình
    timeout: timeoutMs || 1000, 
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'] // ignore stderr để tránh rác log
  });

  // Trả kết quả về cho server.js
  parentPort.postMessage({ ok: true, move: JSON.parse(out) });

} catch (e) {
  let errMsg = 'RUNTIME_ERROR: ';
  if (e.code === 'ETIMEDOUT') errMsg = 'TIMEOUT: Code chạy quá thời gian.';
  else if (e.status !== undefined) errMsg += `Lỗi thực thi (Exit code: ${e.status})`;
  else errMsg += String((e && e.message) || e).slice(0, 200);
  
  parentPort.postMessage({ ok: false, error: errMsg });
} finally {
  // Dọn dẹp file rác sau khi chạy xong
  try { if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (e) {}
  try { 
      const binFile = path.join(tmpDir, `bot_${fileId}`);
      if (lang === 'cpp' && fs.existsSync(binFile)) fs.unlinkSync(binFile); 
  } catch (e) {}
}