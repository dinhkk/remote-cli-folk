# Các thay đổi tùy chỉnh

Fork: [dinhkk/remote-cli-folk](https://github.com/dinhkk/remote-cli-folk). Base đã kiểm thử: upstream `tunghuynh/remote-cli`, commit `01a97619d93279895488f01f0308e2327c25e8fa`, phiên bản 1.0.10.

## Giao diện và quản lý phiên

- Gom các workspace kiểm thử cũ vào nhóm thu gọn; không đổi vị trí hay xóa project.
- Bộ lọc Conversations: **Tất cả / Claude / Codex**. Logo và nhãn của từng conversation lấy từ provider thực tế.
- Reload trang giữ tab Host đang chọn và conversation đang mở. Host được nhớ theo browser tab; đường dẫn conversation được lưu riêng từng Host qua storage bridge hiện có. Chọn New Session xóa đường dẫn cũ; logout xóa trạng thái này.
- Khi danh sách Host tạm lỗi mạng, không ghi đè lựa chọn đã lưu bằng Local. Nếu Host thật sự đã bị xóa khỏi danh sách trả về thành công, trở lại Local.

## Reload trong khi CLI đang trả lời

Hai lỗi frontend được sửa:

1. `websocket_connected` là sự kiện kết nối, không có ID transcript. Trước đây nó có thể bị thêm vào message store khi socket mở sau khi conversation được restore, làm phép gộp lịch sử ném lỗi `startsWith` và ngừng cập nhật các câu trả lời tiếp theo. Handler bỏ qua sự kiện này như một sự kiện điều khiển.
2. Message store do component cha sở hữu được truyền ổn định vào component chat dùng `React.memo`. Thay đổi store cần thông báo trực tiếp tới chat, không chỉ render lại component cha. Chat hiện subscribe theo session bằng `useSyncExternalStore`; session khác và tab chat ẩn không buộc transcript đang xem render lại.

Kiểm chứng ngày 2026-11-19:

- 493 kiểm thử chat qua 65 file; TypeScript frontend và production build đạt.
- Phát lại các frame Codex đã ghi để tái hiện lỗi và kiểm tra bản sửa mà không chạy thêm CLI.
- Kiểm thử thật qua Controller HTTPS → Worker relay → Host WSL: Claude ở viewport desktop, Codex ở viewport điện thoại 390×844.
- Reload sau khi đã thấy lời trả lời mở đầu và công cụ đang chạy. Không bấm chọn lại Host/conversation và không bấm gửi lại.
- Cả hai nhận đủ lời trả lời cuối trên socket mới, giữ native session ID và workspace. Lịch sử lưu một prompt, một lần thực thi lệnh kiểm thử; không tạo session mới, không gửi thêm `chat.send` sau reload.
- Reload lần nữa sau khi hoàn tất vẫn có đầy đủ nội dung. Đây là mô phỏng viewport điện thoại bằng Edge, chưa phải kiểm tra trên điện thoại vật lý.

Lưu ý hiện còn: Codex có thể hiện nhiều thẻ cho cùng một tool trong lượt realtime (badge nhóm như `Bash ×3`) vì ID tool của stream và lịch sử khác nhau. Kiểm tra lịch sử native/API xác nhận đây là các bản thể hiện UI của một lần chạy, không phải lệnh thực thi ba lần. Tải lại sau khi hoàn tất lấy lịch sử chuẩn. Bản sửa này tập trung giữ nội dung và ngăn lỗi nhận kết quả; chưa chuẩn hóa ID tool giữa hai nguồn.

## Thêm Host

Xem [hướng dẫn kết nối Host Linux](connect-new-host.vi.md). Host mới dùng backend RemoteCLI và credentials CLI riêng; Controller đã cập nhật cung cấp frontend cho các tab Host. Không cần thêm relay hay mở public port của Host.

## Build source

```bash
git clone https://github.com/dinhkk/remote-cli-folk.git
cd remote-cli-folk
npm ci
npm run test:client -- src/modules/chat/tests src/modules/remote/tests src/modules/sidebar/tests
npx tsc --noEmit -p tsconfig.json
npm run build
```

`npm run build` build cả frontend và server; `npm run build:client` chỉ tạo frontend. Gói npm upstream không tự chứa thay đổi của fork. Muốn deploy fork phải build source hoặc phát hành artifact riêng; không chạy `remotecli update` rồi kỳ vọng giữ các chỉnh sửa này.

Trên bản Controller hiện tại, frontend được đóng vào image kế thừa backend 1.0.10 đã kiểm thử; volume dữ liệu và cấu hình relay giữ nguyên. Các Dockerfile triển khai nội bộ dùng image base có sẵn trên VPS, không phải image công khai có thể pull từ máy mới.

Không đưa `.secrets`, token GitHub, relay secret, master key, file môi trường thật, cơ sở dữ liệu, credentials provider hoặc transcript kiểm thử có dữ liệu thật lên fork. Các bằng chứng browser/CLI của môi trường vận hành được giữ ngoài cây source.
