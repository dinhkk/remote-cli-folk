# Hướng dẫn triển khai RemoteCLI Remote lên VPS CentOS (Docker) + relay Cloudflare

Tài liệu này đi kèm gói zip. Gồm 2 phần độc lập:

- **Phần A** – build và chạy remotecli (vai **Controller**) bằng Docker trên VPS CentOS.
- **Phần B** – deploy **relay** lên Cloudflare bằng `wrangler` (Cloudflare CLI).

Sơ đồ:

```
Điện thoại/Trình duyệt ──HTTPS──▶ [VPS: nginx ▶ container remotecli (Controller)]
                                              │ wss (mã hóa đầu-cuối)
                                              ▼
                                   [Cloudflare Worker relay]  ◀── wss ── [PC Windows: remotecli (Host)]
```

Relay chỉ chuyển byte đã mã hóa, không đọc được nội dung. PC Windows (Host) dùng bản cài sẵn của bạn, **không cần làm gì trong tài liệu này** ngoài bước nhập URL + secret relay (mục B.7).

> **Chưa kiểm chứng:** các lệnh dưới đây được soạn từ source, chưa được chạy thử trên CentOS thật hay Docker thật (máy phát triển là Windows, không có Docker). Mục 9 liệt kê chỗ có khả năng phát sinh lỗi đầu tiên.

---

# PHẦN A – Build & chạy remotecli bằng Docker trên CentOS

## A.1 Gói zip chứa gì

`remotecli-remote-vps.zip` = toàn bộ thư mục `claudecodeui` **trừ**: `node_modules`, `dist`, `dist-server*`, `.out`, `.claude`, `.agents`, mọi file `.env`. Các thư mục đó sẽ được tạo lại trên Linux khi build. Zip chứa sẵn:

| Đường dẫn | Dùng để |
|---|---|
| `deploy/vps/Dockerfile` | Build image (2 stage: build bằng `node:22-bookworm`, chạy bằng `node:22-bookworm-slim`) |
| `deploy/vps/docker-compose.yml` | Chạy container |
| `deploy/vps/vps.env.example` | Mẫu biến môi trường |
| `deploy/vps/remote-vps-deploy-guide.md` | File này |
| `relay/` | Mã nguồn Worker relay (Phần B) |
| `.dockerignore` | Loại file thừa khỏi build context |

## A.2 Chuẩn bị VPS CentOS

Khuyến nghị CentOS Stream 9 / Rocky / AlmaLinux 9. CentOS 7 đã hết hỗ trợ: Docker vẫn cài được nhưng bản compose plugin và bản Docker mới có thể không có.

```bash
# 1. Gỡ podman-docker nếu có (xung đột với docker-ce)
sudo dnf remove -y podman-docker docker docker-client docker-common 2>/dev/null || true

# 2. Cài Docker CE + compose plugin
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"        # đăng xuất/đăng nhập lại để có hiệu lực

docker version && docker compose version
```

Trên CentOS 7 thay `dnf` bằng `yum` và `dnf config-manager` bằng `yum-config-manager`.

Tài nguyên: bước build (vite + tsc + biên dịch module native) cần khoảng **2–3 GB RAM** trống và vài GB đĩa. VPS nhỏ thì thêm swap tạm:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

Firewall (chỉ mở 80/443; cổng 3001 **không** mở ra ngoài):

```bash
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

## A.3 Đưa gói lên VPS và giải nén

Trên máy Windows, gửi file zip (ví dụ bằng `scp`), rồi trên VPS:

```bash
sudo dnf -y install unzip
mkdir -p ~/remotecli && unzip -q remotecli-remote-vps.zip -d ~/remotecli
cd ~/remotecli/claudecodeui        # thư mục có package.json; mọi lệnh dưới đây chạy tại đây
ls package.json deploy/vps relay
```

## A.4 Cấu hình `.env`

```bash
cp deploy/vps/vps.env.example deploy/vps/.env
chmod 600 deploy/vps/.env

# điền 3 giá trị bắt buộc:
echo "REMOTECLI_SETUP_TOKEN=$(openssl rand -hex 16)"
echo "REMOTECLI_MASTER_KEY=$(openssl rand -base64 32)"
# rồi mở deploy/vps/.env và dán vào; TRUST_PROXY xem bảng dưới
vi deploy/vps/.env
```

- **`REMOTECLI_SETUP_TOKEN`**: remotecli là đơn người dùng, ai đăng ký trước là chủ. Có token thì phải nhập token mới đăng ký được (tương thích ngược: `CLOUDCLI_SETUP_TOKEN`). Ghi lại giá trị này.
- **`REMOTECLI_MASTER_KEY`**: khóa niêm phong bí mật pairing trong database (tương thích ngược: `CLOUDCLI_REMOTE_MASTER_KEY`). **Lưu một bản vào password manager.** Mất khóa = phải pair lại mọi thiết bị. Đừng sao lưu khóa cùng chỗ với volume dữ liệu.
- **`TRUST_PROXY`**: số reverse proxy đứng trước container.

| Kiến trúc | `TRUST_PROXY` |
|---|---|
| nginx / Caddy / `cloudflared` trên VPS, DNS không qua Cloudflare proxy | `1` |
| Bản ghi DNS bật Cloudflare proxy (đám mây cam) → nginx → container | `2` |

Đặt thấp hơn thực tế thì mọi client có cùng một IP và một kẻ đoán sai mật khẩu có thể khóa chính bạn. Đặt `true` thì client giả được IP, nên đừng dùng.

## A.5 Build và chạy

```bash
docker compose -f deploy/vps/docker-compose.yml build        # lần đầu 5–15 phút
docker compose -f deploy/vps/docker-compose.yml up -d
docker compose -f deploy/vps/docker-compose.yml ps           # STATUS: healthy sau ~40 giây
docker compose -f deploy/vps/docker-compose.yml logs -f --tail=100
curl -s http://127.0.0.1:3001/health                         # phải trả JSON, HTTP 200
```

Hành vi cố định của cấu hình này:

- Cổng được publish **chỉ trên `127.0.0.1:3001`** của VPS. Không đổi thành `3001:3001`: Docker publish thẳng qua iptables, bỏ qua firewalld, sẽ lộ cổng ra Internet không có HTTPS.
- Dữ liệu (database, khóa nếu không dùng biến môi trường, file upload) nằm ở volume Docker tên `remotecli-data` (`/home/node/.remotecli` trong container; tương thích thêm `cloudcli-data` / `/home/node/.cloudcli`). Dùng named volume để khỏi gặp lỗi quyền/SELinux của bind mount. Nếu bắt buộc bind mount, thêm hậu tố `:Z` và `chown 1000:1000` thư mục đó.
- Container chạy bằng user `node` (uid 1000), không phải root.
- Không đặt `NODE_ENV=production`: bản đã test trên Windows chạy không có biến này, nên giữ nguyên để khỏi đổi hành vi chưa kiểm chứng.

## A.6 HTTPS reverse proxy (bắt buộc)

Tab Remote chạy trong iframe sandbox, clipboard và cookie bảo mật đều cần HTTPS. Cần một tên miền trỏ về IP VPS.

### Cách 1: nginx + Let's Encrypt

```bash
sudo dnf -y install nginx epel-release
sudo dnf -y install certbot python3-certbot-nginx
sudo setsebool -P httpd_can_network_connect 1      # SELinux: cho nginx kết nối tới 127.0.0.1:3001 (quên bước này = 502)
```

`/etc/nginx/conf.d/remotecli.conf` (thay `remotecli.example.com`):

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 80;
    server_name remotecli.example.com;

    client_max_body_size 64m;          # upload 25 MB + dư; mặc định 1 MB của nginx sẽ chặn upload

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;       # WebSocket: /ws, /shell, /r/...
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;                          # SSE và terminal cần stream, không đệm
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        # KHÔNG thêm add_header / proxy_hide_header: ứng dụng tự gửi CSP, nosniff, frame-ancestors...
    }
}
```

```bash
sudo nginx -t && sudo systemctl enable --now nginx
sudo certbot --nginx -d remotecli.example.com        # cấp chứng chỉ + tự chuyển 80 → 443
```

### Cách 2: Cloudflare Tunnel (VPS đã có `cloudflared`)

Trỏ hostname của tunnel tới `http://127.0.0.1:3001`; nhớ bật WebSocket (mặc định có). `TRUST_PROXY=1`. **Không** đặt Cloudflare Access trước Controller: iframe sandbox có origin `null`, không gửi cookie Access nên tab sẽ hỏng.

## A.7 Đăng ký tài khoản đầu tiên

Mở `https://remotecli.example.com`, đăng ký **ngay** với `REMOTECLI_SETUP_TOKEN` (hoặc `CLOUDCLI_SETUP_TOKEN`). Xong thì token không còn tác dụng với ai đã có tài khoản; vẫn nên giữ bí mật hoặc xóa khỏi `.env` rồi `docker compose ... up -d`.

## A.8 Vận hành

```bash
C="docker compose -f deploy/vps/docker-compose.yml"
$C logs -f --tail=200            # xem log
$C restart                       # khởi động lại
$C down                          # dừng (VOLUME GIỮ NGUYÊN)
$C down -v                       # dừng VÀ XÓA dữ liệu (mất tài khoản + pairing) – cẩn thận

# Cập nhật phiên bản mới: giải nén bản zip mới đè lên (giữ nguyên deploy/vps/.env), rồi
$C up -d --build

# Sao lưu dữ liệu (không kèm khóa master nếu bạn dùng biến môi trường - đúng ý định):
docker run --rm -v remotecli_remotecli-data:/d -v "$PWD":/b busybox tar czf /b/remotecli-data.tgz -C /d .
```

Tên volume thực tế có tiền tố thư mục compose; kiểm tra bằng `docker volume ls`.

Công tắc khẩn: đặt `REMOTECLI_REMOTE_DISABLED=1` trong `.env` rồi `up -d` → app chạy như trước khi có Remote (không mở `/r`, `/api/remote`, không mở link nào). Không cần revert code.

## A.9 Lưu ý khi chuyển từ Windows sang Linux

| # | Điểm cần biết | Xử lý / ghi chú |
|---|---|---|
| 1 | **`node_modules` là của Windows** (`node-pty`, `better-sqlite3`, `bcrypt` là module native). Không chạy được trên Linux. | Zip đã bỏ `node_modules`; `npm ci` trong Docker build sẽ biên dịch lại. Stage build dùng ảnh đầy đủ (có `python3`, `make`, `g++`). |
| 2 | **`dist/` và `dist-server/` bị loại khỏi zip.** | Được build lại trong container (`npm run build`). |
| 3 | **Kết thúc dòng (CRLF/LF).** Thư mục làm việc trên Windows lẫn cả hai kiểu. | Zip được dựng từ Git (đã chuẩn hóa LF) nên không còn CRLF. Nếu bạn tự sửa file shell/Dockerfile trên Windows, lưu kiểu LF. |
| 4 | **Phân biệt hoa/thường trong tên file** (Windows không phân biệt, Linux có). Lỗi `import './Foo'` khi file là `foo.ts` chỉ lộ ra khi build trên Linux. | Nếu `npm run build` trong Docker báo `Cannot find module`, đó là nguyên nhân; sửa tên import. |
| 5 | **Thư mục dữ liệu** `C:\Users\<bạn>\.remotecli` (hoặc `.cloudcli`) → `/home/node/.remotecli` trong container (volume `remotecli-data`). | Đặt `HOME=/home/node` trong Dockerfile. Database không mang sang từ Windows: VPS bắt đầu sạch, tài khoản đăng ký mới. |
| 6 | **Terminal**: trên Windows là ConPTY (PowerShell/cmd); trong container là `bash` thật qua `node-pty`. Terminal của tab Remote trên **Controller** chạy trong container của VPS, **không phải** trên máy chủ CentOS. | Terminal của một Host (PC Windows của bạn) vẫn chạy trên PC đó. `node-pty` trên Linux cần cờ thực thi cho `spawn-helper`; script `postinstall` (`scripts/fix-node-pty.js`) lo việc này. |
| 7 | **Quyền file**: khóa master dạng file tạo mode `0600`, thư mục dữ liệu thuộc user `node` (uid 1000). | Dùng named volume; nếu bind mount thì `chown 1000:1000` và `:Z`. |
| 8 | **SELinux (CentOS bật mặc định)**: nginx cần `httpd_can_network_connect`; bind mount cần nhãn `:Z`. | Đã nêu ở A.6 và A.5. |
| 9 | **Firewalld + Docker**: cổng publish của Docker bỏ qua firewalld. | Publish chỉ trên `127.0.0.1` (compose đã làm). |
| 10 | **Biến môi trường** `HOST=127.0.0.1` (khuyến nghị trong tài liệu cho chạy trực tiếp) → trong container phải là `0.0.0.0`. | An toàn vì cổng publish chỉ ở loopback của VPS. Server sẽ ghi cảnh báo nếu `HOST` không phải loopback mà thiếu `REMOTECLI_SETUP_TOKEN` (đã có). |
| 11 | **Bộ test**: các test của Remote chỉ từng chạy trên Windows. 26 test lỗi nền (symlink EPERM, đường dẫn Windows, biến môi trường) là đặc thù Windows/máy dev; trên Linux kết quả có thể khác. | Không ảnh hưởng chạy thật. Tùy chọn kiểm: `docker build --target build -t remotecli-build -f deploy/vps/Dockerfile .` rồi `docker run --rm remotecli-build npm run test:e2e-remote` (chưa thử). |
| 12 | **Đồng bộ giờ**: HTTPS/Let's Encrypt cần giờ đúng. | `sudo timedatectl set-ntp true` (chrony). |

---

# PHẦN B – Deploy relay lên Cloudflare bằng wrangler

Thư mục dùng: `relay/` trong gói zip (tự đủ, không import gì từ phần còn lại). Relay chạy trên Cloudflare, không chạy trên VPS; VPS chỉ là nơi bạn gõ lệnh deploy. Thao tác từ `~/remotecli/claudecodeui/relay`.

Wrangler đã ghim ở **4.157.0** trong `relay/package.json`; dùng bản này qua `npx` thay vì bản cài sẵn trên máy để đúng phiên bản đã test.

## B.1 Xác thực với Cloudflare (VPS không có trình duyệt)

`wrangler login` cần mở trình duyệt nên khó trên VPS. Dùng **API token**:

1. Dashboard Cloudflare → *My Profile* → *API Tokens* → *Create Token* → template **"Edit Cloudflare Workers"**. Token này chỉ để deploy, dùng riêng, đừng dán vào chat hay repo.
2. Trên VPS nhập vào shell mà không lưu history:

```bash
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=<Account ID, có trên trang Workers>   # cần nếu token thấy nhiều account
```

Nếu `npx wrangler whoami` đã báo đăng nhập sẵn thì bỏ qua bước này.

## B.2 Chọn một trong hai cách chạy wrangler

**Cách 1 – Node 22 có sẵn trên VPS:**

```bash
node -v                                # cần >= 22 (hoặc >= 20)
cd ~/remotecli/claudecodeui/relay
npm ci --ignore-scripts                # đúng phiên bản theo lockfile
alias WR='npx wrangler'
```

**Cách 2 – VPS CentOS không có Node mới: chạy wrangler trong Docker:**

```bash
cd ~/remotecli/claudecodeui/relay
WR() { docker run --rm -i -u "$(id -u):$(id -g)" -e HOME=/tmp \
        -e CLOUDFLARE_API_TOKEN -e CLOUDFLARE_ACCOUNT_ID \
        -v "$PWD":/work -w /work node:22-bookworm \
        sh -c 'test -d node_modules || npm ci --ignore-scripts >/dev/null; exec npx wrangler "$@"' wrangler "$@"; }
```

(Phần còn lại giống nhau; gọi `WR deploy ...` thay cho `npx wrangler deploy ...`. Cách 2 chưa được thử.)

## B.3 Deploy với tên worker ngẫu nhiên

`wrangler.jsonc` có tên mẫu `remotecli-remote-relay-dev` – **không deploy tên này**. Truyền tên ngẫu nhiên bằng `--name`:

```bash
NAME=ccr-$(openssl rand -hex 10)
echo "$NAME"                          # ghi lại
npx wrangler deploy --name "$NAME"    # (hoặc: WR deploy --name "$NAME")
```

Kết quả in URL dạng `https://<NAME>.<subdomain>.workers.dev`. Lần đầu tài khoản chưa có subdomain `workers.dev` thì wrangler sẽ hỏi tạo hoặc bạn tạo ở dashboard. Relay trả **503** cho tới khi có secret (bình thường).

Cấu hình có sẵn trong `wrangler.jsonc`: Durable Object `Room` kiểu SQLite (chạy được trên gói Free), `observability` tắt (relay không log), không có route/domain riêng.

## B.4 Tạo và lưu `RELAY_SECRET`

Tối thiểu 32 ký tự (lệnh dưới ra 43). Ngắn hơn thì relay từ chối phục vụ (503).

```bash
RELAY_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
# (nếu VPS không có node:  RELAY_SECRET=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'))
printf %s "$RELAY_SECRET" | npx wrangler secret put RELAY_SECRET --name "$NAME"
echo "$RELAY_SECRET"                  # lưu vào password manager NGAY; không ghi vào file trong repo
```

## B.5 Kiểm tra relay

```bash
URL=https://$NAME.<subdomain>.workers.dev
curl -s -o /dev/null -w "%{http_code}\n" "$URL/healthz"      # 200 = secret đã có và đủ dài; 503 = chưa có/quá ngắn
node scripts/smoke.mjs "$URL" "$RELAY_SECRET"                # in các dòng PASS; FAIL thì dừng và xem lỗi
```

(Smoke dùng gói `ws` nên cần `relay/node_modules`: Cách 1 đã có sau `npm ci`; Cách 2 có sau lần chạy `WR` đầu tiên. Với Cách 2 chạy smoke bằng `docker run --rm -u "$(id -u):$(id -g)" -v "$PWD":/work -w /work node:22-bookworm node scripts/smoke.mjs "$URL" "$RELAY_SECRET"`.)

Smoke tạo một room tạm, nối Host và Controller giả, gửi một frame mỗi chiều rồi hủy room.

## B.6 Hạn chế cần biết (quyết định của bạn)

- Trên `*.workers.dev` **không** đặt được rate-limit của Cloudflare (nó thuộc về zone). Hạn mức Free 100.000 request/ngày thuộc về bất kỳ ai biết URL; hết hạn mức thì relay trả lỗi 1027 tới 00:00 UTC (chỉ mất khả dụng, không lộ dữ liệu). Tên ngẫu nhiên chỉ là che giấu.
- Muốn rate-limit: dùng tên miền riêng trên một zone Cloudflare – sửa `wrangler.jsonc` thành `"workers_dev": false` và thêm `routes` cho domain, rồi tạo rule rate-limiting trong WAF của zone.
- Đổi `RELAY_SECRET` hoặc URL sau này sẽ **thu hồi mọi pairing** (phải pair lại).
- Gỡ relay: `npx wrangler delete --name "$NAME"` (xóa cả Durable Object).

## B.7 Nối Host và Controller

1. Trên **cả hai** remotecli (Controller trên VPS và Host trên PC Windows): *Settings → Remote work* → nhập **cùng một** relay URL (`wss://<NAME>.<subdomain>.workers.dev` hoặc dạng `https://`) và **cùng một** secret.
2. **Host (PC):** bật **Accept**. Nếu bạn sẽ duyệt thẻ Allow/Deny từ điện thoại, đặt trước khi chạy remotecli trên PC: `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS=300000` (và `OPENCODE_TOOL_APPROVAL_TIMEOUT_MS=300000`) – áp dụng cho cả tiến trình.
3. **Host:** bấm *Pair a Controller* (hỏi mật khẩu tài khoản) → hiện mã 8 ký tự, hiệu lực 5 phút.
4. **Controller (VPS):** *Pair with a Host* → nhập mã và tên thiết bị.
5. Controller hiện mã SAS 6 chữ số. **Gõ mã đó vào Host.** Phải khớp; nhập sai 3 lần → hủy và khóa pairing trên Host 15 phút.
6. Tab của Host xuất hiện trên Controller. Host phải để **Accept bật** và đang chạy.
7. **Đặt tên gọi (alias) cho Host** nếu tên máy khó nhìn (ví dụ Host chạy trong Docker nên tên máy là một chuỗi ngẫu nhiên): trên Controller vào *Settings → Remote work → Paired Hosts → Rename*, gõ tên (tối đa 40 ký tự) rồi *Save name*. Tab sẽ hiện alias thay cho tên máy; rê chuột vào tab để xem tên gốc. Để trống rồi lưu thì quay lại dùng tên máy. Alias chỉ lưu trên Controller này, không gửi cho Host hay relay.

Điều cần nhớ: Controller đã ghép cặp có **toàn quyền** với Host (có shell, đọc được mọi file dưới thư mục home của Host kể cả `auth.db`, khóa master, `~/.ssh`). Chỉ ghép thiết bị của chính bạn; tắt Accept khi không dùng.

---

# 9. Chỗ dễ lỗi đầu tiên & cách xử lý

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `npm ci` lỗi ở `node-gyp` / `better-sqlite3` / `node-pty` | Thiếu công cụ biên dịch hoặc hết RAM | Stage build đã là ảnh đầy đủ; thêm swap (A.2). Xem log `docker compose build --progress=plain`. |
| `npm ci` lỗi `Missing: @rollup/rollup-linux-x64-gnu` hoặc tương tự | Lockfile tạo trên Windows thiếu binary tùy chọn của Linux (lỗi đã biết của npm) | Trong Dockerfile đổi `RUN npm ci` thành `RUN npm install --no-audit --no-fund` rồi build lại. |
| `npm ci` treo / lỗi tải ở `@vscode/ripgrep` | Tải binary từ GitHub bị giới hạn tốc độ | Build lại sau vài phút, hoặc `docker build --build-arg GITHUB_TOKEN=... ` (thêm `ARG GITHUB_TOKEN` + `ENV GITHUB_TOKEN=$GITHUB_TOKEN` vào stage build; token chỉ đọc, đừng commit). |
| `npm run build` báo `Cannot find module './Xyz'` | Sai hoa/thường tên file (mục A.9 #4) | Sửa tên import cho khớp tên file. |
| Container `unhealthy` / thoát ngay | Thiếu hoặc sai `.env`, hoặc master key sai định dạng | `docker compose ... logs`. Master key phải là base64 của đúng 32 byte (`openssl rand -base64 32`). `MASTER_KEY_MISMATCH` nghĩa là có dữ liệu đã niêm phong với khóa khác: khôi phục đúng khóa hoặc pair lại. |
| nginx trả **502** | SELinux chặn kết nối tới 3001 | `sudo setsebool -P httpd_can_network_connect 1`; kiểm `curl http://127.0.0.1:3001/health` trên VPS. |
| Upload lớn lỗi **413** từ nginx | `client_max_body_size` mặc định 1 MB | Có `64m` trong cấu hình ở A.6. |
| Terminal/stream đứng, SSE không chạy | nginx đệm hoặc không cho WebSocket | `proxy_buffering off`, header `Upgrade/Connection` như A.6. |
| Đăng nhập sai vài lần là bị khóa cả bạn | `TRUST_PROXY` đặt thấp hơn số proxy thật | Chỉnh theo bảng A.4; log sẽ cảnh báo khi thấy `X-Forwarded-For` mà chưa đặt. |
| `/healthz` của relay trả 503 | Chưa đặt `RELAY_SECRET` hoặc < 32 ký tự | Làm lại B.4. |
| Tab Remote không hiện / không pair được | URL hoặc secret khác nhau giữa hai máy; Host chưa bật Accept | Nhập lại cùng giá trị ở cả hai máy (B.7); kiểm `/healthz`. |
| `wrangler deploy` báo chưa xác thực | Chưa đặt `CLOUDFLARE_API_TOKEN` trong shell hiện tại | Làm lại B.1 trong cùng phiên shell. |

## Những gì chưa được kiểm chứng

- Docker build và chạy trên CentOS thật; `npm ci` trên Linux với lockfile này.
- Cách chạy wrangler trong Docker (B.2 cách 2) và lệnh `wrangler secret put` qua stdin trên Linux.
- Thử trên điện thoại thật, đo độ trễ thật qua Cloudflare, chạy soak 30 phút (checklist ngay bên dưới).

---

# 10. Checklist thử trên điện thoại

Làm trên iOS Safari và Android Chrome, với Controller phục vụ qua HTTPS và một Host thật đã pair.

- [ ] Đăng nhập Controller qua HTTPS; có biểu tượng ổ khóa.
- [ ] Mở tab Host; danh sách project của Host tải được.
- [ ] Gửi một tin nhắn chat và thấy câu trả lời stream về.
- [ ] Duyệt và từ chối một thẻ yêu cầu dùng tool (Allow/Deny).
- [ ] Trả lời một thẻ AskUserQuestion.
- [ ] Xử lý một thẻ plan (ExitPlanMode).
- [ ] Gõ trong terminal; dán (paste) hoạt động.
- [ ] Upload một file vài MB và tải một file về.
- [ ] Đưa tab xuống nền hoặc đổi mạng (Wi-Fi sang 4G): tab tự nối lại và các thẻ đang chờ vẫn còn.
- [ ] Thu hồi pairing từ Host: tab hiện trạng thái đã thu hồi.
- [ ] Password manager: vẫn gợi ý đăng nhập Controller và không đề nghị lưu gì bên trong tab sandbox.
- [ ] Soak 30 phút với terminal + chat (không tự động hóa, bạn tự làm).
- [ ] Đo độ trễ thật (tùy chọn, cần Node trong repo, chạy trên máy phát triển): `E2E_RELAY_URL=wss://... E2E_RELAY_SECRET=... npm run measure:latency`.

Thu hồi/đăng xuất:
- **Thu hồi một pairing:** trên Host, mục *Remote work* → xóa/thu hồi thiết bị.
- **Đăng xuất mọi nơi (cũng kết thúc mọi tab Remote):** `POST /api/auth/logout-all` với `{"password": "..."}` khi đã đăng nhập.
