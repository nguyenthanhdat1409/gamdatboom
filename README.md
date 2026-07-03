# 💣 IT Nhiều Chuyện · Game Đặt Boom

Game đặt boom (kiểu Bomberman) web, chơi được **offline với máy** và **online tạo phòng chờ bạn bè**.

## ✨ Tính năng

- 🏠 **Trang chủ GenZ 2026**: tiêu đề **"IT nhiều chuyện"** có dải màu cầu vồng xoay + các đốm sáng nhiều màu chạy quanh chữ.
- 🧑‍🎤 **Bắt buộc nhập tên** + **chọn nhân vật** (12 nhân vật emoji) trước khi vào chơi.
- 🤖 **Đấu với máy**: chơi 1 mình với 1 / 2 / 3 máy (bot biết né bom, phá thùng, truy đuổi).
- 🌐 **Tạo phòng / Vào phòng**: chia sẻ mã 4 ký tự cho bạn bè vào chơi chung.
- ➕ **Thêm máy vào phòng người**: chủ phòng thêm/xoá bot tuỳ ý để đủ tay (tối đa 8 người + máy).
- 🗺️ **Bản đồ bự**: 4 cỡ (Nhỏ / Vừa / Bự / Siêu bự) với camera cuộn theo nhân vật.
- 🎮 Điều khiển: **WASD / phím mũi tên** để đi, **Space** để đặt boom. Có sẵn **nút cảm ứng** cho điện thoại.
- 🔥 Vật phẩm: 💣 thêm bom · 🔥 tăng tầm nổ · 👟 tăng tốc.

## 🚀 Cách chạy

Cần cài **Node.js 18+** (tải tại https://nodejs.org).

Mở terminal (PowerShell / CMD) trong thư mục này rồi chạy:

```bash
npm install
npm start
```

Sau đó mở trình duyệt tại: **http://localhost:3000**

### Chơi với bạn bè cùng mạng LAN / Wi-Fi

Bạn bè mở `http://<địa-chỉ-IP-máy-bạn>:3000` (ví dụ `http://192.168.1.10:3000`), nhập mã phòng bạn tạo là vào chơi chung được.

> Muốn chơi qua Internet: dùng công cụ tunnel như `ngrok http 3000` rồi chia sẻ link.

## ☁️ Deploy lên Render (chơi qua Internet, miễn phí)

Dự án đã có sẵn file `render.yaml` nên deploy rất nhanh.

### Bước 1 — Đưa code lên GitHub
Trong thư mục dự án, chạy:

```bash
git init
git add .
git commit -m "Game dat boom - IT nhieu chuyen"
git branch -M main
git remote add origin https://github.com/<tên-github>/<tên-repo>.git
git push -u origin main
```

### Bước 2 — Tạo service trên Render
1. Vào https://render.com → đăng nhập (có thể dùng tài khoản GitHub).
2. Bấm **New +** → **Web Service** (hoặc **Blueprint** nếu muốn Render tự đọc `render.yaml`).
3. Chọn repo GitHub vừa push.
4. Render sẽ tự nhận cấu hình:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. Bấm **Create Web Service** và chờ build xong (~1–2 phút).

### Bước 3 — Chơi
Render cấp link dạng `https://<tên-app>.onrender.com`. Chia sẻ link này cho bạn bè, ai cũng vào tạo/nhập phòng chơi chung được (Socket.IO chạy tự động qua WebSocket bảo mật).

> ⚠️ Gói Free của Render sẽ "ngủ" sau ~15 phút không có ai truy cập, nên lần mở đầu tiên sau khi ngủ có thể chờ ~30 giây để server thức dậy. Đây là bình thường với gói miễn phí.

## 🗂️ Cấu trúc

```
game_dat_boom/
├─ package.json
├─ server/index.js        # Server Express + Socket.IO, quản lý phòng, chạy vòng lặp online + bot
├─ shared/                # Logic dùng chung cho cả client (offline) và server (online)
│  ├─ constants.js        # Hằng số, danh sách nhân vật, cỡ bản đồ
│  ├─ engine.js           # Engine game: di chuyển, bom, nổ, vật phẩm, thắng/thua
│  └─ bot.js              # AI bot (né bom, đặt bom, truy đuổi)
└─ public/                # Giao diện
   ├─ index.html
   ├─ css/style.css
   └─ js/
      ├─ main.js          # Điều khiển màn hình, menu, kết nối online, vòng lặp game
      └─ render.js        # Vẽ canvas + camera + HUD
```
