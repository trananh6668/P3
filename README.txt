Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# 1. Cài đặt dependencies (tự động copy stockfish.js, stockfish.wasm, stockfish.worker.js vào public/engine/)
npm install

# 2. Chạy môi trường phát triển (đã bật sẵn header COOP/COEP)
npm run dev

# 3. Kiểm tra kiểu TypeScript & đóng gói bản Production Offline vào thư mục dist/
npm run build

# 4. Chạy thử bản Production Offline
npm run preview
