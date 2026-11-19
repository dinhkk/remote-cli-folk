# Thêm một Host Linux vào RemoteCLI

Hướng dẫn cho server Ubuntu/Debian có systemd. Mỗi Host cài **RemoteCLI backend và CLI cần dùng**, đăng nhập CLI bằng tài khoản của chính Host, rồi ghép vào Controller đang có. Điện thoại chỉ mở giao diện Controller bằng trình duyệt.

```text
Điện thoại / laptop (trình duyệt HTTPS)
                   |
           Controller trên VPS
                   |
             WSS + mã hóa E2E
                   |
       Cloudflare Worker Relay
          /                \
   WSS + E2E             WSS + E2E
       |                     |
   Host WSL hiện có       Host Linux mới
   RemoteCLI backend     RemoteCLI backend
   Claude / Codex CLI    Claude / Codex CLI
   Project trên WSL      Project trên server mới
```

Không cần tạo Worker mới hay domain mới khi thêm Host. Host chủ động kết nối ra relay bằng WSS/443; không cần công khai port 3001 hoặc cài Cloudflare Tunnel trên Host. Mỗi lần pair tạo liên kết riêng; Controller giữ nhiều Host, mỗi Host có workspace và phiên riêng. Một room relay có một Host và một Controller, không phải mọi Host dùng chung một room.

## 1. Chuẩn bị

- Một user Linux thường, ví dụ `developer`, có quyền đọc/sửa các project cần thao tác. Đăng nhập SSH bằng user này và dùng cùng user để cài CLI, đăng nhập CLI, chạy RemoteCLI.
- Node.js 24 và npm có trên PATH. RemoteCLI 1.0.10 khai báo Node >=22.5.0; hệ thống hiện tại đã chạy với Node 24. Kiểm tra bằng `node --version`, `npm --version`, `command -v node`.
- Git, curl, CA certificates; nếu thiếu: `sudo apt update && sudo apt install -y git curl ca-certificates`.
- URL Controller, URL relay và **relay secret đang dùng trên Controller** do quản trị viên cấp qua kênh riêng. Relay secret không phải mật khẩu đăng nhập RemoteCLI, GitHub token hay master key.
- Cho phép server truy cập HTTPS/WSS ra relay và các dịch vụ của provider. Firewall inbound chỉ cần giữ SSH và các dịch vụ vốn có; không thêm rule mở 3001.

Nên SSH trực tiếp bằng user chạy Host. Nếu đăng nhập root rồi dùng `su`/`sudo` chuyển user, shell có thể chưa có môi trường user bus của systemd. Dấu nhắc đang ở `/root` chỉ cho biết thư mục hiện tại, không đủ để xác nhận `$HOME` hoặc user bus đúng. Trước khi cài, kiểm tra:

```bash
id
printf 'HOME=%s\nXDG_RUNTIME_DIR=%s\n' "$HOME" "${XDG_RUNTIME_DIR:-}"
getent passwd "$(id -un)" | cut -d: -f1,3,6
ps -p 1 -o comm=
```

User và HOME phải tương ứng với tài khoản chạy Host; PID 1 phải là `systemd` cho cách dùng service dưới đây. Không cài vào `/root` rồi chạy service bằng user thường. Nếu chỉ có quyền SSH root, dùng `sudo -iu bcis` để cài/đăng nhập CLI trong home của `bcis` (thay tên theo máy); thao tác systemd theo mục 4a nếu user bus không hoạt động.

## 2. Cài và đăng nhập provider trên Host

Cài những provider thực sự cần dùng. Claude có trình cài native chính thức:

```bash
curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
claude --version
claude
```

Làm theo hướng dẫn đăng nhập của Claude trong terminal. Nếu cần mở trang đăng nhập, mở đường dẫn được CLI cung cấp trên máy có trình duyệt. Xem [hướng dẫn Claude Code](https://code.claude.com/docs/en/setup).

Codex có thể cài vào prefix của user, không cần `sudo npm`:

```bash
npm install -g --prefix "$HOME/.local" @openai/codex
export PATH="$HOME/.local/bin:$PATH"
codex --version
codex login --device-auth
```

Device login cần được bật trong tài khoản/workspace nếu hệ thống yêu cầu; mở link và nhập mã theo CLI. Xem [Codex CLI](https://developers.openai.com/codex/cli) và [đăng nhập server không có trình duyệt](https://developers.openai.com/codex/auth#login-on-headless-devices). Không đưa các file xác thực provider vào Git.

Kiểm tra từng CLI trực tiếp trong thư mục project trước khi ghép RemoteCLI. Chạy bằng root sẽ tạo bộ credentials/history khác với user chạy service.

## 3. Cài Host RemoteCLI

Cách này dùng gói npm **1.0.10**, cùng phiên bản backend với hệ thống đã kiểm thử. Các thay đổi giao diện của fork được triển khai trên Controller; tab Host từ điện thoại nhận frontend của Controller, không cần build frontend tùy chỉnh ở mọi Host.

```bash
mkdir -p "$HOME/.local/share/remotecli-host"
cd "$HOME/.local/share/remotecli-host"
npm init -y
npm install --save-exact @tunghuynh/remotecli@1.0.10
```

Không dùng `@latest` hoặc lệnh tự cập nhật trong quy trình này; nâng phiên bản sau khi kiểm thử tương thích Controller/Host.

## 4. Tạo cấu hình riêng và tự khởi động

Thực hiện phần tạo key **trước lần khởi động đầu tiên**. Key được sinh riêng cho Host mới, không cần giống Controller. Không thay key trên Host đã pair: dữ liệu pairing đang lưu được mã hóa bằng key đó.

```bash
mkdir -p "$HOME/.config/remotecli-host" "$HOME/.config/systemd/user"
chmod 700 "$HOME/.config/remotecli-host"
```

Tạo file môi trường một lần; lệnh sau từ chối ghi đè nếu file đã tồn tại và không in key ra terminal:

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const target = path.join(os.homedir(), '.config/remotecli-host/host.env');
const lines = [
  'HOST=127.0.0.1',
  'SERVER_PORT=3001',
  'CLAUDE_TOOL_APPROVAL_TIMEOUT_MS=300000',
  `REMOTECLI_MASTER_KEY=${randomBytes(32).toString('base64')}`,
  `PATH=${path.join(os.homedir(), '.local/bin')}:${process.env.PATH}`,
];
fs.writeFileSync(target, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log('Đã tạo host.env; không thay key sau khi pair.');
NODE
```

PATH ghi lại cả thư mục Node hiện tại, nên dùng được khi Node được cài bằng nvm. Khi đổi/xóa phiên bản Node, cập nhật PATH trong file này rồi restart service.

Tạo `~/.config/systemd/user/remotecli-host.service`:

```ini
[Unit]
Description=RemoteCLI Host
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.local/share/remotecli-host
EnvironmentFile=%h/.config/remotecli-host/host.env
ExecStart=/usr/bin/env node %h/.local/share/remotecli-host/node_modules/@tunghuynh/remotecli/dist-server/server/modules/cli/cli.js
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
```

Kích hoạt trong phiên SSH trực tiếp của user đã đăng nhập CLI. Mỗi dòng là một lệnh riêng, không thêm dấu `\` cuối dòng:

```bash
sudo loginctl enable-linger "$(id -un)"
systemctl --user daemon-reload
systemctl --user enable --now remotecli-host
systemctl --user status remotecli-host --no-pager
ss -ltn | grep ':3001'
```

Kết quả mong đợi: service `active (running)`, listener `127.0.0.1:3001`. `linger` giúp user service chạy sau reboot và sau khi thoát SSH. Nếu port 3001 đã có ứng dụng khác, đổi `SERVER_PORT` và port đích trong bước SSH bên dưới.

Service chạy trực tiếp trên Host để sử dụng đúng credentials và đường dẫn project. Không cần cài Docker cho cách cài Host này.

### 4a. Lỗi user bus khi chuyển từ root sang user khác

Ví dụ: shell `bcis@server:/root` báo `Failed to connect to user scope bus ... Operation not permitted` sau khi dùng `su` từ root. Lỗi nằm ở việc truy cập systemd user manager, chưa phải lỗi khởi động Node/RemoteCLI. `su` không đảm bảo khởi tạo một phiên đăng nhập systemd hoặc môi trường bus mới; cần kiểm tra thay vì kết luận từ dấu nhắc.

Cách xử lý từ tài khoản có sudo hoặc shell root, ví dụ Host chạy bằng **bcis**:

```bash
sudo loginctl enable-linger bcis
sudo systemctl start "user@$(id -u bcis).service"
sudo systemctl --user --machine=bcis@.host daemon-reload
sudo systemctl --user --machine=bcis@.host enable --now remotecli-host
sudo systemctl --user --machine=bcis@.host status remotecli-host --no-pager
ss -ltn | grep ':3001'
```

Nếu đã ở root có thể bỏ `sudo`. `--machine=bcis@.host` chỉ rõ user manager của **bcis trên chính server này**; không chuyển ứng dụng sang chạy root. `enable-linger` giữ user manager sau logout và khởi động ở boot; `systemctl start user@...` bảo đảm manager chạy ngay. Không dùng `sudo systemctl --user ...` thiếu user đích vì nó có thể chọn manager của root.

Nếu phiên bản/môi trường không hỗ trợ cách kết nối `.host`, sau khi đã start `user@...`, chỉ định runtime/bus đúng cho tiến trình chạy bằng user đích:

```bash
remotecli_host_user=bcis
remotecli_host_uid="$(id -u "$remotecli_host_user")"
remotecli_userctl() {
  sudo -H -u "$remotecli_host_user" env \
    XDG_RUNTIME_DIR="/run/user/$remotecli_host_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$remotecli_host_uid/bus" \
    systemctl --user "$@"
}
remotecli_userctl daemon-reload
remotecli_userctl enable --now remotecli-host
remotecli_userctl status remotecli-host --no-pager
```

Ở block hàm này, các dấu `\` nối dòng là có chủ đích. Không đặt các biến bus trên vào `/etc/environment` hoặc cấu hình toàn hệ thống. Không tự tạo/chmod/chown `/run/user`; thư mục này do systemd quản lý.

Nếu vẫn lỗi, thu các thông tin sau (không cần gửi nội dung `host.env` hay credentials):

```bash
id
printf 'HOME=%s\nXDG_RUNTIME_DIR=%s\nDBUS_SESSION_BUS_ADDRESS=%s\n' "$HOME" "${XDG_RUNTIME_DIR:-}" "${DBUS_SESSION_BUS_ADDRESS:-}"
ps -p 1 -o comm=
sudo systemctl status "user@$(id -u bcis).service" --no-pager
sudo loginctl show-user bcis -p Linger -p State -p RuntimePath
sudo stat -c '%U %a %n' "/run/user/$(id -u bcis)" "/run/user/$(id -u bcis)/bus"
sudo -H -u bcis sh -c 'printf "HOME=%s\n" "$HOME"; ls -l "$HOME/.config/systemd/user/remotecli-host.service"'
```

- `Unit remotecli-host.service not found` sau khi user bus đã kết nối: kiểm tra file unit trong home thật của `bcis`; có thể các bước cài trước đã chạy dưới root. Đối chiếu cả `WorkingDirectory` và vị trí `host.env`, không sinh lại key hoặc chuyển credentials một cách tự động.
- `user@...` không start được: xem `sudo journalctl -u "user@$(id -u bcis).service" -n 60 --no-pager`; cần sửa user manager trước. Máy tối giản có thể thiếu thành phần PAM/user D-Bus; xác nhận log và gói cài trước khi thêm gói.
- PID 1 không phải systemd (ví dụ container thường): cách service này chưa áp dụng; cần supervisor của container hoặc môi trường có systemd. Không thể chữa bằng cách đổi biến bus.

Cơ sở: [pam_systemd và runtime của user đăng nhập](https://www.freedesktop.org/software/systemd/man/latest/pam_systemd.html), [loginctl enable-linger](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html), [systemctl --machine=user@.host](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html).

## 5. Mở trang Host để onboarding và pair

Trên **laptop**, mở một terminal và giữ kết nối SSH forward:

```bash
ssh -N -L 127.0.0.1:13001:127.0.0.1:3001 developer@NEW_SERVER
```

Mở `http://127.0.0.1:13001` trên laptop. Đây chỉ là forward SSH để cấu hình ban đầu, không phải Cloudflare Tunnel và không cần giữ sau khi pair xong.

1. Tạo tài khoản chủ RemoteCLI của Host, hoàn tất onboarding/Git name/email nếu được yêu cầu. Tài khoản này độc lập với tài khoản Controller; không bắt buộc cùng mật khẩu.
2. Mở **Settings → Remote work → Relay**. Nhập URL relay và đúng relay secret đang dùng trên Controller, bấm **Save relay**. Nhập lại mật khẩu chủ của **Host** nếu được yêu cầu.
3. Bật **Accept remote connections**, tạo pairing code trên Host. Giữ trang này mở.
4. Mở URL **Controller** trên một tab khác, đăng nhập tài khoản Controller. Trong **Remote work**, xác nhận Controller dùng cùng relay. Chọn **Pair host**, nhập pairing code và tên phân biệt như `server-dev-02`.
5. Controller hiển thị mã xác minh **SAS**. Quay lại trang Host, nhập mã SAS đó và xác nhận. Đây là bước riêng sau pairing code; chỉ nhập pairing code chưa hoàn tất ghép nối.
6. Đợi Host xuất hiện với trạng thái online trên Controller. Mở tab Host mới. Có thể đóng SSH forward sau đó.

Pairing code dùng một lần, có thời hạn 5 phút theo relay của phiên bản này. Nếu hết hạn, tạo mã mới. Không sao chép auth.db/master key từ WSL sang server mới để “nhân bản Host”; mỗi Host tạo danh tính và pairing riêng.

## 6. Chọn project và kiểm tra từ điện thoại

Trên Controller, chọn **đúng tab Host mới**, sau đó mở/chọn đường dẫn project có thật trên server đó. Nếu Projects chưa có thư mục, dùng luồng mở/thêm project của Host; đường dẫn WSL không tự tồn tại trên server mới.

Với mỗi provider đã cài, tạo một conversation kiểm thử trong project và gửi:

> Chạy pwd, trả lại đường dẫn hiện tại và nhớ mã HOST-NEW-OK. Không sửa file.

Kiểm tra đường dẫn đúng, icon/provider đúng. Reload trang rồi gửi:

> Nhắc lại mã của lượt đầu và chạy pwd lần nữa. Không đổi thư mục.

Cuối cùng thử reload khi đang trả lời: nhận đủ kết quả ở conversation cũ, không bấm Send lại. Mỗi lần Send là một yêu cầu mới. Frontend fork có bản sửa giữ tab/phiên và nhận tiếp kết quả sau reload; nếu Controller vẫn dùng frontend upstream thì chưa có các sửa này.

Điện thoại dùng 4G/5G mở Controller, không mở địa chỉ `127.0.0.1` hay IP private của Host. Nếu chọn Bypass Permissions, CLI có thể thao tác trong phạm vi quyền của user service; đây là lựa chọn cho phiên, không phải yêu cầu để kết nối relay.

## 7. Vận hành và xử lý lỗi

```bash
systemctl --user restart remotecli-host
journalctl --user -u remotecli-host -n 100 --no-pager
loginctl show-user "$(id -un)" -p Linger
```

| Hiện tượng | Kiểm tra |
|---|---|
| Host offline | Service, DNS/HTTPS ra relay, relay URL/secret; không mở inbound 3001 để chữa lỗi |
| Pair đứng chờ | Mã chưa hết hạn và đã nhập SAS trên Host |
| Không thấy Claude/Codex | CLI cài cho cùng user service, PATH trong host.env, đăng nhập provider còn hiệu lực |
| Không mở được project | Đường dẫn thuộc Host đang chọn và user service có quyền truy cập |
| Reboot xong không lên | `is-enabled`, `Linger=yes`, Node còn tồn tại tại PATH đã ghi |
| Master key mismatch | Khôi phục đúng key gốc; không sinh key mới để thử |
| Approval hết hạn | Env 300000 ms đã được service nạp sau restart |

Backup dữ liệu RemoteCLI mặc định `~/.remotecli` cùng `~/.config/remotecli-host/host.env`; giữ key trong nơi bảo mật riêng. Credentials/lịch sử CLI nằm trong home của user (`~/.claude`, `~/.codex` và cơ chế lưu credential của provider), không nằm trên relay. Thay hoặc thu hồi Host tại Remote work khi không còn dùng.

## Nguồn và phạm vi kiểm chứng

- Giao thức và giới hạn relay: [relay/README.md](../relay/README.md).
- UI pair/SAS: `src/modules/remote/modals/PairHostDialog.tsx`, `PairControllerDialog.tsx`.
- Node/version/CLI entry point: [package.json](../package.json); host bind: `server/index.ts`; key/data: `server/shared/constants.ts`, `server/modules/remote/crypto/master-key.ts`.
- Cách ghép và truyền dữ liệu dựa trên code RemoteCLI; cấu hình systemd, SSH forward và bố trí thư mục ở đây là hướng dẫn vận hành bổ sung.
- Luồng Controller → relay → Host WSL và hai provider đã được kiểm thử trong hệ thống hiện tại. Runbook này chưa được chạy từ đầu trên một server mới hoàn toàn; cần làm bước kiểm tra ở mục 6 khi thêm máy.
