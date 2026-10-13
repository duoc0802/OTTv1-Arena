# OTT Arena

Web thi đấu OTTv2: hai người lạ bấm **Tìm trận**, được ghép ngẫu nhiên; hai đoạn code (JavaScript) do họ nộp được server chạy luân phiên và đấu với nhau, người xem theo dõi realtime.

## Chạy

Cần Node.js >= 18. Không cần `npm install`.

```bash
node server.js          # http://localhost:3000
node test.js            # smoke test luật + ghép trận + chạy bot thật
```

Thử một mình: mở 1 cửa sổ thường + 1 cửa sổ ẩn danh (cookie khác nhau = 2 người), cả hai bấm "Tìm trận".
Xem trận: `http://localhost:3000/#m=<matchId>`.

Biến môi trường: `PORT`, `HOST`, `MAX_MATCHES` (mặc định 20), `MOVE_DELAY_MS` (mặc định 600).

## Luật (giả định – chỉnh trong `game.js`)

Các file FRS bạn gửi không chứa FRS-L01 (luật chi tiết) nên mình dùng bộ luật sau:

- Bàn 9x9, mỗi bên 9 quân (3 Búa, 3 Kéo, 3 Bao), đặt ngẫu nhiên ở 2 hàng đầu, đối xứng xoay 180° cho công bằng. RED đi trước.
- Mỗi quân đi 1 ô theo 8 hướng. Đi vào ô địch chỉ được khi thắng (Búa>Kéo>Bao>Búa); cùng loại hoặc thua thì không đi vào được.
- Thắng khi: loại hết quân địch, địch hết nước đi, hoặc sau 200 nước (nhiều quân hơn thắng, hòa → RED).
- Trả nước sai / lỗi code / quá 1 giây = thua.

## Viết bot

```js
function move(state) {
  // state.you: 'RED'|'BLUE'; state.turn; state.ply
  // state.board[r][c] = null | {owner:'me'|'enemy', type:'R'|'P'|'S'}
  // state.legalMoves = [{from:[r,c], to:[r,c], capture:bool}]
  return state.legalMoves[0];
}
```

Bot không giữ trạng thái giữa các nước (mỗi nước chạy một worker mới), và thấy toàn bộ bàn cờ.

## Kiến trúc (theo các FRS)

| File | Vai trò |
|---|---|
| `game.js` | Luật, nước hợp lệ, kết quả (thuần, dễ test) |
| `botRunner.js` | Chạy code người chơi trong `worker_threads` + `vm`, timeout, không có `require/process`, tắt `eval` |
| `server.js` | Session guest, hàng chờ ghép ngẫu nhiên, vòng lặp trận (server là authority), HTTP + SSE, giới hạn hữu hạn |
| `public/index.html` | Editor + bàn cờ realtime + xem trận |

Đã làm theo spec: HTTP + SSE, header `X-OTT-Request` chống CSRF, hàng chờ có lease 30s, preflight chạy thử code trước khi vào hàng, giới hạn kích thước code/hàng chờ/số trận, backpressure SSE (đóng stream chậm), code bị xóa khỏi RAM sau trận và không bao giờ gửi cho đối thủ, hủy-vs-ghép trả về trận đã ghép.

## Giới hạn hiện tại / việc nên làm tiếp

- **An toàn**: `vm` + worker chỉ là lớp bảo vệ cơ bản, KHÔNG đủ để chạy code người lạ trên Internet. Trước khi public, chạy bot trong container/VM không có mạng, giới hạn CPU/RAM (Docker, gVisor, Firecracker…).
- Dữ liệu đang lưu trong RAM (mất khi restart). Theo FRS-L06 cần PostgreSQL + command ledger + replay.
- Chưa có tài khoản, Elo, Ranked, Referee, rematch, hỗ trợ Python.
- Chạy nhiều instance cần chuyển hàng chờ/trận sang kho chung (Redis/Postgres).
