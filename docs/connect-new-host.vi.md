# Thêm một Host Linux vào RemoteCLI

Hướng dẫn cho server Ubuntu/Debian có systemd. Mỗi Host cài **RemoteCLI backend và CLI cần dùng**, đăng nhập CLI bằng tài khoản của chính Host, rồi ghép vào Controller đang có. Điện thoại chỉ mở giao diện Controller bằng trình duyệt.

**User cài và chạy Host là tài khoản Linux thường (non-root), không bắt buộc có quyền sudo.** Dùng cùng tài khoản này để cài RemoteCLI, cài/đăng nhập Claude hoặc Codex và thao tác với project. Root thực hiện riêng các bước quản trị hệ thống được ghi rõ. `bcis` trong các ví dụ chỉ là tên user minh họa, không phải tài khoản bắt buộc; hãy thay bằng tên user Linux anh chọn trên Host mới.

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

- Một user Linux thường đã tồn tại, ví dụ `bcis`, có quyền đọc/sửa các project cần thao tác. Dùng cùng user để cài CLI, đăng nhập CLI và chạy RemoteCLI; không cần thêm user vào nhóm sudo.
- Node.js 24 và npm có trên PATH. RemoteCLI 1.0.10 khai báo Node >=22.5.0; hệ thống hiện tại đã chạy với Node 24. Kiểm tra bằng `node --version`, `npm --version`, `command -v node`.
- Git, curl, CA certificates. Nếu thiếu, chạy `apt update && apt install -y git curl ca-certificates` trong phiên **root**, không chạy bước cài gói hệ thống này bằng `bcis`.
- URL Controller, URL relay và **relay secret đang dùng trên Controller** do quản trị viên cấp qua kênh riêng. Relay secret không phải mật khẩu đăng nhập RemoteCLI, GitHub token hay master key.
- Cho phép server truy cập HTTPS/WSS ra relay và các dịch vụ của provider. Firewall inbound chỉ cần giữ SSH và các dịch vụ vốn có; không thêm rule mở 3001.

Nên SSH trực tiếp bằng user chạy Host. Nếu chỉ SSH được root, chạy `su - bcis` từ phiên root để cài/đăng nhập CLI trong home của `bcis`; khi cần quay về root, chạy `exit` một lần từ shell con đó. Shell chuyển user có thể chưa có môi trường user bus của systemd; dùng cách quản trị từ root ở mục 4a nếu gặp lỗi. Dấu nhắc đang ở `/root` chỉ cho biết thư mục hiện tại, không đủ để xác nhận `$HOME` hoặc user bus đúng. Trước khi cài, kiểm tra **trong shell bcis**:

```bash
id
printf 'HOME=%s\nXDG_RUNTIME_DIR=%s\n' "$HOME" "${XDG_RUNTIME_DIR:-}"
getent passwd "$(id -un)" | cut -d: -f1,3,6
ps -p 1 -o comm=
```

User và HOME phải tương ứng với tài khoản chạy Host; PID 1 phải là `systemd` cho cách dùng service dưới đây. Không cài vào `/root` rồi chạy service bằng user thường.

## 2. Cài và đăng nhập provider trên Host

**Thực hiện trên Host mới bằng user Linux thường dùng để cài và chạy Host. Không dùng root hoặc sudo cho các lệnh trong mục này.**

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

**Thực hiện trên Host mới bằng user Linux thường (non-root) dùng để cài và chạy RemoteCLI.** Dùng cùng tài khoản đã cài và đăng nhập provider ở mục 2. Các đường dẫn `$HOME` dưới đây tự trỏ tới thư mục home của tài khoản đó.

Cách này dùng gói npm **1.0.10**, cùng phiên bản backend với hệ thống đã kiểm thử. Các thay đổi giao diện của fork được triển khai trên Controller; tab Host từ điện thoại nhận frontend của Controller, không cần build frontend tùy chỉnh ở mọi Host.

```bash
mkdir -p "$HOME/.local/share/remotecli-host"
cd "$HOME/.local/share/remotecli-host"
npm init -y
npm install --save-exact @tunghuynh/remotecli@1.0.10
```

Không dùng `@latest` hoặc lệnh tự cập nhật trong quy trình này; nâng phiên bản sau khi kiểm thử tương thích Controller/Host.

## 4. Tạo cấu hình riêng và tự khởi động

Mở **hai cửa sổ terminal trên laptop/PC**, cùng kết nối SSH tới **Host mới** (server vừa cài ở mục 3, không phải VPS Controller). Giữ hai cửa sổ này mở trong suốt mục 4:

| Cửa sổ | Đăng nhập bằng | Dùng để làm gì? |
|---|---|---|
| **Terminal A** | User Linux đã cài RemoteCLI | Tạo file cấu hình và file service |
| **Terminal B** | `root` | Bật tự khởi động và kiểm tra service |

Trong các lệnh dưới đây, thay `linux-username` bằng tên user Linux đã dùng ở mục 3 và `IP_HOST_MOI` bằng IP/tên DNS của Host mới. User chạy RemoteCLI **không cần quyền sudo**.

### Bước 1 — Mở hai terminal

**Terminal A:** nếu đang ở đúng user từ mục 3 thì giữ nguyên cửa sổ đó. Nếu mở cửa sổ mới, kết nối bằng:

```bash
ssh linux-username@IP_HOST_MOI
```

Nếu server chỉ cho SSH bằng root, thay cách kết nối trên bằng hai lệnh sau: chạy dòng đầu trên laptop, đợi đăng nhập thành công rồi chạy dòng thứ hai trên Host:

```bash
ssh root@IP_HOST_MOI
su - linux-username
```

Trong Terminal A, chạy `id -un` để chắc chắn kết quả là user Linux đã chọn, **không phải `root`**. Giữ nguyên user này cho bước 2 và 3.

**Terminal B:** mở cửa sổ mới trên laptop rồi kết nối:

```bash
ssh root@IP_HOST_MOI
```

Trong Terminal B, `id -un` phải trả về `root`. Giữ nguyên phiên root này cho bước 4 và 5; không cần chuyển qua lại giữa các user.

### Bước 2 — Terminal A: tạo file môi trường

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

Nếu báo `EEXIST`, file đã có sẵn: giữ nguyên file cũ, không xóa để tạo lại key. PATH ghi lại cả thư mục Node hiện tại, nên dùng được khi Node được cài bằng nvm. Khi đổi/xóa phiên bản Node, cập nhật PATH trong file này rồi restart service.

### Bước 3 — Terminal A: tạo file service

Chạy toàn bộ khối sau để tạo `~/.config/systemd/user/remotecli-host.service` cho Host mới. Nếu đã có service tùy chỉnh, đối chiếu nội dung trước khi ghi đè:

```bash
cat > "$HOME/.config/systemd/user/remotecli-host.service" <<'UNIT'
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
UNIT
```

### Bước 4 — Terminal B: bật tự khởi động

Chuyển sang **Terminal B đang đăng nhập root**. Thay `linux-username` ở dòng đầu bằng user của Terminal A, rồi chạy lần lượt cả khối:

```bash
remotecli_host_user="linux-username"
loginctl enable-linger "$remotecli_host_user"
systemctl start "user@$(id -u "$remotecli_host_user").service"
systemctl --user --machine="$remotecli_host_user@.host" daemon-reload
systemctl --user --machine="$remotecli_host_user@.host" enable --now remotecli-host
```

Root chỉ bật service **cho user đã chọn**; RemoteCLI vẫn chạy bằng user Linux đó. `linger` giúp service chạy sau reboot và sau khi thoát SSH. Cách này dùng được cả khi Terminal A vào user bằng `su`, không cần chạy `systemctl --user` trong Terminal A.

### Bước 5 — Terminal B: kiểm tra

Vẫn trong **cùng Terminal B**, chạy:

```bash
systemctl --user --machine="$remotecli_host_user@.host" status remotecli-host --no-pager
ss -ltn | grep ':3001'
```

Thấy **`active (running)`** và **`127.0.0.1:3001`** là xong mục 4; chuyển sang mục 5 để mở trang Host và pair. Nếu port 3001 đã có ứng dụng khác, đổi `SERVER_PORT` trong file môi trường và port đích trong bước SSH bên dưới.

Service chạy trực tiếp trên Host để sử dụng đúng credentials và đường dẫn project. Không cần cài Docker cho cách cài Host này.

### 4a. Lỗi user bus khi chuyển từ root sang user khác

<details>
<summary>Chỉ mở phần này nếu gặp lỗi user bus hoặc service không khởi động</summary>

Nếu Terminal A báo `Failed to connect to user scope bus ... Operation not permitted`, chuyển sang Terminal B và làm bước 4–5 ở trên. Lỗi này nằm ở việc truy cập systemd user manager; chưa phải lỗi Node/RemoteCLI.

Trong Terminal B, giữ tùy chọn `--machine="$remotecli_host_user@.host"` để chọn đúng user manager trên Host; bỏ tùy chọn này sẽ chọn manager của root.

Nếu phiên bản/môi trường không hỗ trợ cách kết nối `.host`, sau khi đã start `user@...`, **vẫn trong phiên root**, chỉ định runtime/bus đúng cho tiến trình chạy bằng user đích:

```bash
remotecli_host_user=linux-username
remotecli_host_uid="$(id -u "$remotecli_host_user")"
remotecli_userctl() {
  runuser -u "$remotecli_host_user" -- env \
    XDG_RUNTIME_DIR="/run/user/$remotecli_host_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$remotecli_host_uid/bus" \
    systemctl --user "$@"
}
remotecli_userctl daemon-reload
remotecli_userctl enable --now remotecli-host
remotecli_userctl status remotecli-host --no-pager
```

Ở block hàm này, các dấu `\` nối dòng là có chủ đích. Không đặt các biến bus trên vào `/etc/environment` hoặc cấu hình toàn hệ thống. Không tự tạo/chmod/chown `/run/user`; thư mục này do systemd quản lý.

Nếu vẫn lỗi, thu các thông tin sau **trong phiên root** (không cần gửi nội dung `host.env` hay credentials). Các biến môi trường ở đây mô tả shell root; lệnh cuối kiểm tra HOME và file unit trong phiên đăng nhập linux-username:

```bash
id
printf 'HOME=%s\nXDG_RUNTIME_DIR=%s\nDBUS_SESSION_BUS_ADDRESS=%s\n' "$HOME" "${XDG_RUNTIME_DIR:-}" "${DBUS_SESSION_BUS_ADDRESS:-}"
ps -p 1 -o comm=
systemctl status "user@$(id -u linux-username).service" --no-pager
loginctl show-user linux-username -p Linger -p State -p RuntimePath
stat -c '%U %a %n' "/run/user/$(id -u linux-username)" "/run/user/$(id -u linux-username)/bus"
runuser -l linux-username -c 'printf "HOME=%s\n" "$HOME"; ls -l "$HOME/.config/systemd/user/remotecli-host.service"'
```

- `Unit remotecli-host.service not found` sau khi user bus đã kết nối: kiểm tra file unit trong home thật của `linux-username`; có thể các bước cài trước đã chạy dưới root. Đối chiếu cả `WorkingDirectory` và vị trí `host.env`, không sinh lại key hoặc chuyển credentials một cách tự động.
- `user@...` không start được: chạy `journalctl -u "user@$(id -u linux-username).service" -n 60 --no-pager` trong phiên root; cần sửa user manager trước. Máy tối giản có thể thiếu thành phần PAM/user D-Bus; xác nhận log và gói cài trước khi thêm gói.
- PID 1 không phải systemd (ví dụ container thường): cách service này chưa áp dụng; cần supervisor của container hoặc môi trường có systemd. Không thể chữa bằng cách đổi biến bus.

Cơ sở: [pam_systemd và runtime của user đăng nhập](https://www.freedesktop.org/software/systemd/man/latest/pam_systemd.html), [loginctl enable-linger](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html), [systemctl --machine=user@.host](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html).

</details>

## 5. Mở trang Host để onboarding và pair

### 5.1. Phân biệt các máy và địa chỉ

| Tên trong hướng dẫn | Là máy nào? | Vai trò ở bước này |
|---|---|---|
| Laptop/PC của anh | Máy anh đang ngồi thao tác, có trình duyệt; ví dụ máy Windows | Chạy lệnh SSH forward và mở cả hai tab trình duyệt |
| Host mới (`NEW_SERVER` hoặc `IP_HOST_MOI`) | Server vừa cài RemoteCLI + Claude/Codex, có user `bcis` | Chạy RemoteCLI tại `127.0.0.1:3001` **của server đó** |
| VPS Controller | VPS phục vụ giao diện Controller; ví dụ `https://domain.com` (thay bằng domain Controller của bạn) | Nhận pairing và hiển thị tab Host mới |

**`developer@NEW_SERVER` trong ví dụ cũ nghĩa là user SSH trên Host mới.** `developer` chỉ là tên ví dụ; máy anh đang dùng `bcis`, hoặc `root` để đăng nhập SSH. `NEW_SERVER` là IP/tên DNS của **Host mới**, không phải IP/domain của VPS Controller. Nếu anh đã SSH root vào Host mới để cài đặt, dùng lại đúng địa chỉ đích của kết nối SSH đó.

### 5.2. Trên laptop/PC: mở đường chuyển tiếp đến Host mới

Mở **một cửa sổ PowerShell/Terminal mới trên laptop/PC**, ngoài phiên SSH đang mở vào server. Không gõ lệnh dưới đây trong shell `root@server` hoặc `bcis@server`. Anh có thể giữ cửa sổ SSH cài đặt hiện tại để xem log.

Vì anh đang dùng SSH root vào Host mới, chạy trên laptop/PC (thay `IP_HOST_MOI` bằng IP/tên DNS thực tế):

```bash
ssh -o ExitOnForwardFailure=yes -N -L 127.0.0.1:13001:127.0.0.1:3001 root@IP_HOST_MOI
```

Nếu đã SSH trực tiếp được bằng `bcis`, thay `root@IP_HOST_MOI` bằng `bcis@IP_HOST_MOI`. Nếu SSH dùng port khác 22 hoặc key/SSH config riêng, dùng cùng tùy chọn `-p`, `-i`, `-F` hoặc alias như kết nối SSH Host mới đang hoạt động. Tài khoản SSH mở đường chuyển tiếp không thay đổi user `bcis` đang chạy RemoteCLI.

Ý nghĩa đường chuyển tiếp:

```text
Trình duyệt trên laptop/PC
  http://127.0.0.1:13001
          |
  SSH từ laptop/PC tới HOST MỚI
          |
  127.0.0.1:3001 trên HOST MỚI
          |
  RemoteCLI chạy bằng bcis
```

`127.0.0.1:13001` là cổng trên **laptop/PC**; `127.0.0.1:3001` phía sau là cổng trên **Host mới**. VPS Controller không tham gia đường SSH này. Không cần mở public port 3001 hay 13001 trên server.

Sau khi xác thực SSH thành công, terminal có thể đứng yên, không hiện shell mới vì dùng `-N`; cứ giữ cửa sổ đó mở. `ExitOnForwardFailure` báo lỗi nếu không mở được cổng chuyển tiếp, nhưng không bảo đảm RemoteCLI ở đích đã chạy. Nếu cổng 13001 của laptop đang bận, đổi riêng cổng này thành 13002 rồi dùng cùng cổng mới trong URL trình duyệt.

### 5.3. Trên trình duyệt của cùng laptop/PC: mở hai tab để pair

- **Tab A — Host mới:** mở [http://127.0.0.1:13001](http://127.0.0.1:13001). Anh đang xem RemoteCLI của Host mới qua SSH, không phải Controller. Nếu đã đổi cổng ở bước trước, đổi URL tương ứng.
- **Tab B — Controller:** mở URL Controller đang dùng, ví dụ `https://domain.com` — thay bằng domain Controller của bạn. Đây là giao diện do VPS Controller phục vụ.

Thực hiện theo thứ tự, trên hai tab của cùng trình duyệt:

1. **Tab A:** tạo tài khoản chủ RemoteCLI của Host, hoàn tất onboarding/Git name/email nếu được yêu cầu. Tài khoản này độc lập với tài khoản Controller; không bắt buộc cùng mật khẩu.
2. **Tab A:** mở **Settings → Remote work → Relay**. Nhập URL relay và đúng relay secret đang dùng trên Controller, bấm **Save relay**. Nhập lại mật khẩu chủ của **Host** nếu được yêu cầu.
3. **Tab A:** bật **Accept remote connections**, tạo pairing code trên Host. Giữ tab này mở.
4. **Tab B:** đăng nhập tài khoản Controller. Trong **Remote work**, xác nhận Controller dùng cùng relay. Chọn **Pair host**, nhập pairing code từ Tab A và tên phân biệt như `server-dev-02`.
5. **Tab B** hiển thị mã xác minh **SAS**. Quay lại **Tab A**, nhập mã SAS đó và xác nhận. Đây là bước riêng sau pairing code; chỉ nhập pairing code chưa hoàn tất ghép nối.
6. **Tab B:** đợi Host mới xuất hiện với trạng thái online, rồi chọn tab Host đó để thao tác. Sau khi pair thành công, có thể nhấn `Ctrl+C` trong terminal SSH forward trên laptop để đóng đường chuyển tiếp.

SSH forward chỉ phục vụ cấu hình ban đầu, không phải Cloudflare Tunnel. Sau khi pair, Host mới kết nối với Controller qua Worker relay; không cần giữ SSH forward. Từ điện thoại, mở URL **Controller** rồi chọn Host mới. Không mở `127.0.0.1:13001` trên điện thoại: địa chỉ đó lúc này trỏ về chính điện thoại, không phải laptop.

Nếu Tab A không mở được: kiểm tra terminal SSH còn kết nối, địa chỉ đích là Host mới, và RemoteCLI trên Host mới đang lắng nghe `127.0.0.1:3001` theo mục 4. Thông báo `administratively prohibited` từ SSH cần quản trị viên kiểm tra quyền TCP forwarding của SSH server; không giải quyết bằng cách mở public port 3001.

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

**Trong phiên SSH trực tiếp bằng user Linux đang chạy Host**, các lệnh vận hành không cần sudo:

```bash
systemctl --user restart remotecli-host
journalctl --user -u remotecli-host -n 100 --no-pager
loginctl show-user "$(id -un)" -p Linger
```

Nếu quản trị qua **phiên root**, restart bằng `systemctl --user --machine=bcis@.host restart remotecli-host` và kiểm tra bằng `systemctl --user --machine=bcis@.host status remotecli-host --no-pager`, như mục 4a.

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
