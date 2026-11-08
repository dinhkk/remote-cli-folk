import os
import sys
import math
import subprocess
import time
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, 'video/src')
import terminal_ui as tui
import terminal_doodle_scenes as tds
from anim_scenes import draw_chibi_overloaded_dev

FFMPEG = 'C:/Users/tungh/AppData/Local/Programs/Python/Python310/lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe'

WIDTH = 1080
HEIGHT = 1920
FPS = 30
TOTAL_DURATION = 67.0
TOTAL_FRAMES = int(TOTAL_DURATION * FPS)

# Monospace Terminal Fonts (Consolas)
FONT_HERO = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 36)
FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 28)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 24)
FONT_SUBTITLE = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 22)
FONT_REGULAR = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 22)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 20)
FONT_XS = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 16)

# Colors
BG_DARK = '#0f141c'
TERM_BG = '#090d16'
BORDER_DARK = '#1e293b'
TEXT_CYAN = '#38bdf8'
TEXT_GREEN = '#4ade80'
TEXT_YELLOW = '#facc15'
TEXT_RED = '#f87171'

# Authentic Real Screenshots
MOCKUP_1 = Image.open('video/assets/mockups/mockup_phone_1.png').convert('RGBA')
MOCKUP_2 = Image.open('video/assets/mockups/mockup_phone_2.png').convert('RGBA')

MOCKUP_SCALE = 1.35
M_W = int(520 * MOCKUP_SCALE) # 702
M_H = int(1080 * MOCKUP_SCALE) # 1458
M_X = (WIDTH - M_W) // 2 # 189
M_Y = 60

SCALED_M1 = MOCKUP_1.resize((M_W, M_H), Image.Resampling.LANCZOS)
SCALED_M2 = MOCKUP_2.resize((M_W, M_H), Image.Resampling.LANCZOS)

# Subtitle Segments with highlighted keywords
SUBTITLES = [
    # Scene 1
    (0.0, 4.2, "Có một nghịch lý: AI càng làm được nhiều việc...", "NGHỊCH LÝ"),
    (4.2, 8.8, "...thì ta lại càng bận hơn chứ chẳng được ngồi chơi!", "CÀNG BẬN HƠN"),
    (8.8, 11.5, "Thấy AI cày khỏe, bạn đốt token cho đỡ phí quota...", "ĐỐT TOKEN"),
    (11.5, 14.54, "Nhưng trong lúc nó chạy, vẫn phải ngồi canh HITL!", "HITL"),
    # Scene 2
    (14.54, 18.5, "Ngồi máy mãi đau lưng, bạn remote qua điện thoại...", "REMOTE ĐIỆN THOẠI"),
    (18.5, 22.8, "Chat chỉ đạo AI như nhắn tin với người yêu!", "NHƯ NHẮN TIN GHỆ"),
    (22.8, 27.43, "Thế là ngồi trà đá vỉa hè cũng mở ra làm việc!", "TRÀ ĐÁ VỈA HÈ"),
    # Scene 3
    (27.43, 31.5, "Thấy cái PC ở nhà bỏ không, lôi ra cày ý tưởng cũ...", "HỒI SINH PC"),
    (31.5, 35.8, "Thêm con laptop cũ, thêm một con VPS trên mây...", "LAPTOP + VPS"),
    (35.8, 39.69, "Gom hết vào RemoteCLI, chuyển máy chỉ bằng 1 cái tab!", "CHUYỂN MÁY 1 TAB"),
    # Scene 4 (Real Photo 1)
    (39.69, 43.5, "Từ 1 project, giờ bạn ôm cùng lúc 5-6 cái!", "5-6 PROJECTS"),
    (43.5, 47.68, "Hàng chục session nhảy liên tục từ sáng đến chiều...", "47 SESSIONS"),
    # Scene 5 (Real Photo 2)
    (47.68, 51.5, "Và rồi... đầu óc bạn bắt đầu phân mảnh!", "PHÂN MẢNH CONTEXT"),
    (51.5, 55.5, "Cả đàn AI thi nhau réo xin duyệt quyền...", "XIN DUYỆT QUYỀN"),
    (55.5, 58.74, "Toàn nhắm mắt bấm Recommend vì không kịp nghĩ!", "BẤM RECOMMEND"),
    # Scene 6
    (58.74, 62.5, "Hóa ra từ sáng đến đêm chỉ làm bài thi trắc nghiệm...", "BÀI THI TRẮC NGHIỆM"),
    (62.5, 66.5, "Bạn còn bận hơn cả lúc chưa có AI!", "BẬN HƠN CHƯA CÓ AI"),
]

def get_current_subtitle(t):
    for start, end, text, keyword in SUBTITLES:
        if start <= t < end:
            return text, keyword
    return "", ""

def draw_terminal_subtitle(draw, text, keyword="", y=1450):
    """
    Renders pure terminal-styled subtitle prompt box:
    > [KEYWORD] Subtitle text here...
    """
    box = (50, y, WIDTH - 50, y + 105)
    draw.rectangle(box, fill='#090d16', outline='#38bdf8', width=2)
    # Terminal accent header line
    draw.rectangle((50, y, 70, y + 105), fill='#1e293b')
    draw.text((55, y + 36), ">", fill='#38bdf8', font=FONT_BOLD)

    if keyword:
        kw_str = f"[{keyword}] "
        draw.text((85, y + 20), kw_str, fill='#facc15', font=FONT_BOLD)
        bbox = draw.textbbox((0, 0), kw_str, font=FONT_BOLD)
        kw_w = bbox[2] - bbox[0]
        draw.text((85 + kw_w, y + 20), text, fill='#ffffff', font=FONT_BOLD)
    else:
        draw.text((85, y + 36), text, fill='#ffffff', font=FONT_TITLE)

def render_frame(frame_idx):
    t = frame_idx / FPS

    # Canvas Base (Dark app background)
    im = Image.new('RGB', (WIDTH, HEIGHT), BG_DARK)
    draw = ImageDraw.Draw(im)

    token_str = '126K'

    if t < 14.54:
        # === SCENE 1: Nghịch Lý AI & HITL Trong Terminal ===
        cur_tab = 'Home-PC'
        unread_badge = 0

        tui.draw_mobile_header(draw, active_tab=cur_tab, url='vibexai.net')
        tui.draw_mobile_footer(draw, tokens=token_str, unread_count=unread_badge)

        # Terminal Window Box (Sharp Terminal Edges)
        code_box = (35, 230, WIDTH - 35, 1420)
        draw.rectangle(code_box, fill=TERM_BG, outline=BORDER_DARK, width=2)

        # Terminal Header Bar
        draw.rectangle((35, 230, WIDTH - 35, 290), fill='#161e2e')
        draw.text((60, 248), ">_ PowerShell Terminal (HITL Supervisor Active)", fill=TEXT_CYAN, font=FONT_BOLD)
        blink_col = '#22c55e' if math.sin(t * 8) > 0 else '#15803d'
        draw.rectangle((WIDTH - 75, 252, WIDTH - 55, 272), fill=blink_col)

        # Typing Green Code Lines (progressively appearing)
        code_lines = [
            ("$tokenBudget = 1000000; # Max quota burn", '#4ade80'),
            ("while ($true) {", '#4ade80'),
            ("    $task = Invoke-ClaudeAgent -Loop dynamic", '#4ade80'),
            ("    if ($task.NeedsApproval) {", '#facc15'),
            ("        Wait-For-Human-In-The-Loop -Timeout Infinite", '#f87171'),
            ("    }", '#facc15'),
            ("}", '#4ade80')
        ]
        visible_lines = min(len(code_lines), int(t * 1.5) + 2)
        for idx in range(visible_lines):
            cl, ccol = code_lines[idx]
            draw.text((60, 315 + idx * 40), cl, fill=ccol, font=FONT_BOLD)

        # Blinking cursor
        cur_y = 315 + (visible_lines - 1) * 40
        if math.sin(t * 10) > 0:
            draw.rectangle((580, cur_y + 4, 595, cur_y + 26), fill='#4ade80')

        # DOODLE ONLY: AI Robot & Stressed Dev
        tds.draw_dark_robot(draw, 320, 830, scale=1.35, t=t)
        tds.draw_dark_dev(draw, 780, 840, scale=1.3, pose='standing_stressed', t=t)

        # Dynamic Alerts (Sharp Terminal Style)
        if t >= 4.5:
            st_scale = min(1.0, (t - 4.5) / 0.3)
            st_w = int(680 * st_scale)
            banner_box = ((WIDTH - st_w) // 2, 1150, (WIDTH + st_w) // 2, 1230)
            draw.rectangle(banner_box, fill='#450a0a', outline='#ef4444', width=3)
            if st_scale >= 0.9:
                draw.text(((WIDTH - 640) // 2, 1172), "[!] ĐỐT TOKEN CHO ĐỠ PHÍ QUOTA! [!]", fill='#fca5a5', font=FONT_TITLE)

        if t >= 10.0:
            hitl_y = 1250 + int(math.sin(t * 14) * 3)
            draw.rectangle((60, hitl_y, WIDTH - 60, hitl_y + 80), fill='#7f1d1d', outline='#f87171', width=3)
            draw.text((100, hitl_y + 24), "[!] CHUẨN HITL: PHẢI CANH TỪNG TÝ! [!]", fill='#ffffff', font=FONT_TITLE)

    elif t < 27.43:
        # === SCENE 2: Remote Trà Đá Vỉa Hè ===
        t_scene = t - 14.54
        cur_tab = 'Home-PC'
        unread_badge = 2

        tui.draw_mobile_header(draw, active_tab=cur_tab, url='vibexai.net')
        tui.draw_mobile_footer(draw, tokens=token_str, unread_count=unread_badge)

        # Terminal Chat Background
        chat_box = (35, 230, WIDTH - 35, 1420)
        draw.rectangle(chat_box, fill=TERM_BG, outline=BORDER_DARK, width=2)

        # Terminal Subheader Bar
        draw.rectangle((35, 230, WIDTH - 35, 290), fill='#161e2e')
        draw.text((60, 248), ">_ Remote Session • QuanTraDa_ViaHe.session", fill=TEXT_CYAN, font=FONT_BOLD)
        draw.rectangle((WIDTH - 75, 252, WIDTH - 55, 272), fill='#22c55e')

        # Chat Bubbles formatted as Terminal Logs
        if t_scene >= 1.0:
            draw.rectangle((WIDTH - 660, 320, WIDTH - 60, 395), fill='#172554', outline='#3b82f6', width=2)
            draw.text((WIDTH - 640, 340), "[23:26] Dev: Ghé trà đá làm cốc đi anh em ơi!", fill='#93c5fd', font=FONT_SUBTITLE)

        if t_scene >= 3.5:
            draw.rectangle((60, 415, 800, 490), fill='#1e293b', outline='#475569', width=2)
            draw.text((80, 435), "[23:26] AI : Em đang refactor xong 3 module rồi ạ!", fill='#4ade80', font=FONT_SUBTITLE)

        if t_scene >= 6.0:
            draw.rectangle((WIDTH - 680, 510, WIDTH - 60, 585), fill='#172554', outline='#3b82f6', width=2)
            draw.text((WIDTH - 660, 530), "[23:27] Dev: Chat AI sướng như nhắn tin với ghệ!", fill=TEXT_CYAN, font=FONT_SUBTITLE)

        # DOODLE ONLY: Dev sitting on low plastic stool + Trà đá table
        tds.draw_dark_dev(draw, 380, 920, scale=1.4, pose='sitting_tra_da', t=t)
        tds.draw_dark_tra_da_table(draw, 780, 920, scale=1.35, t=t)

        # Terminal Alert Box
        if t_scene >= 8.5:
            punch_box = (50, 1260, WIDTH - 50, 1360)
            draw.rectangle(punch_box, fill='#450a0a', outline='#ef4444', width=3)
            draw.text((65, 1292), "[!] ĐANG YÊN ĐANG LÀNH TỰ NHIÊN GÁNH THÊM VIỆC! [!]", fill=TEXT_RED, font=FONT_TITLE)

    elif t < 39.69:
        # === SCENE 3: Hồi Sinh Máy Cũ & Chuyển Máy 1 Tab ===
        t_scene = t - 27.43
        if t_scene < 4.0:
            cur_tab = 'Home-PC'
        elif t_scene < 8.0:
            cur_tab = 'Laptop'
        else:
            cur_tab = 'PC'

        unread_badge = 3

        tui.draw_mobile_header(draw, active_tab=cur_tab, url='vibexai.net')
        tui.draw_mobile_footer(draw, tokens=token_str, unread_count=unread_badge)

        # Terminal Body
        term_box = (35, 230, WIDTH - 35, 1420)
        draw.rectangle(term_box, fill=TERM_BG, outline=BORDER_DARK, width=2)

        # Tab Switching Focus
        if cur_tab == 'Laptop':
            tab_box_lap = (348, 150, 489, 194)
            draw.rectangle(tab_box_lap, outline=TEXT_YELLOW, width=3)
        elif cur_tab == 'PC':
            tab_box_pc = (507, 150, 584, 194)
            draw.rectangle(tab_box_pc, outline=TEXT_YELLOW, width=3)

        # DOODLE ONLY: Multi-Device Ecosystem
        tds.draw_dark_ecosystem(draw, 540, 700, scale=1.25, t=t)

        # Terminal Highlight Box
        if t_scene >= 4.0:
            box = (60, 1180, WIDTH - 60, 1280)
            draw.rectangle(box, fill='#172554', outline=TEXT_CYAN, width=3)
            draw.text((100, 1210), ">> CHUYỂN MÁY CHỈ BẰNG 1 CÁI TAB! <<", fill=TEXT_CYAN, font=FONT_HERO)

    elif t < 47.68:
        # === SCENE 4: BÙNG NỔ 5-6 PROJECTS (REAL Screenshot 1) ===
        t_scene = t - 39.69

        # Drop shadow behind real image
        draw.rectangle((M_X - 6, M_Y - 6, M_X + M_W + 6, M_Y + M_H + 6), fill='#040711', outline='#1e293b', width=2)

        # Paste REAL Image 1 (completely untouched authentic user screenshot)
        im.paste(SCALED_M1, (M_X, M_Y), SCALED_M1)

        # UAV Card is at y = 705..765 on original 1080h image
        uav_y = int(M_Y + 705 * MOCKUP_SCALE)
        uav_h = int(60 * MOCKUP_SCALE)

        # Terminal Target Bracket on UAV
        pulse_col = '#ef4444' if math.sin(t * 12) > 0 else '#facc15'
        draw.rectangle((M_X + 12, uav_y, M_X + M_W - 12, uav_y + uav_h), outline=pulse_col, width=4)

        # Callout tag on UAV in Consolas Bold
        draw.text((M_X + 20, uav_y - 32), "===> [!] UAV: 47 SESSIONS! <===", fill=TEXT_YELLOW, font=FONT_BOLD)

        # Terminal Project Chips on sides
        alert_tags = [
            ("[OTA: 2 sess]", 15, 420, TEXT_CYAN),
            ("[OTA-ext: 4 sess]", WIDTH - 225, 420, TEXT_YELLOW),
            ("[sandbox: 2]", 15, 560, TEXT_GREEN),
            ("[HOT: 47 SESS]", WIDTH - 225, 560, TEXT_RED),
        ]
        for at_text, at_x, at_y, at_col in alert_tags:
            bob = int(math.sin(t_scene * 5 + at_x) * 4)
            bbox = draw.textbbox((0, 0), at_text, font=FONT_SUBTITLE)
            tw = bbox[2] - bbox[0] + 16
            draw.rectangle((at_x, at_y + bob, at_x + tw, at_y + bob + 38), fill='#090d16', outline=at_col, width=2)
            draw.text((at_x + 8, at_y + bob + 6), at_text, fill=at_col, font=FONT_SUBTITLE)

        # Laser scanner beam
        scan_y = int(M_Y + 280 + (t * 240) % 850)
        draw.line([(M_X + 10, scan_y), (M_X + M_W - 10, scan_y)], fill='#38bdf8', width=2)

    elif t < 58.74:
        # === SCENE 5: PHÂN MẢNH CONTEXT & 90 TIN NHẮN (REAL Screenshot 2) ===
        t_scene = t - 47.68

        # Drop shadow behind real image
        draw.rectangle((M_X - 6, M_Y - 6, M_X + M_W + 6, M_Y + M_H + 6), fill='#040711', outline='#1e293b', width=2)
        im.paste(SCALED_M2, (M_X, M_Y), SCALED_M2)

        # Target reticle on 90 Unread Messages Badge (x = 176..215, y = 894..914)
        bx = int(M_X + 195 * MOCKUP_SCALE)
        by = int(M_Y + 904 * MOCKUP_SCALE)

        ret_r = 32 + int(math.sin(t * 14) * 4)
        draw.ellipse((bx - ret_r, by - 22, bx + ret_r, by + 22), outline='#ef4444', width=3)
        rot_angle = t * 6
        dx = int(math.cos(rot_angle) * 45)
        dy = int(math.sin(rot_angle) * 25)
        draw.line([(bx - dx, by - dy), (bx + dx, by + dy)], fill='#ef4444', width=2)
        draw.line([(bx + dy, by - dx), (bx - dy, by + dx)], fill='#ef4444', width=2)

        draw.text((bx - 85, by - 65), "[!] 90 TIN NHẮN! [!]", fill=TEXT_RED, font=FONT_BOLD)

        # DOODLE ONLY: Chibi Overloaded Dev
        draw_chibi_overloaded_dev(draw, 140, 320, scale=1.1, t=t)

        # Panic Terminal Chips
        panic_tags = [
            ("[Xin duyệt quyền?]", WIDTH - 245, 320, TEXT_YELLOW),
            ("[Git conflict!]", 15, 520, '#c084fc'),
            ("[47 SESSIONS!]", WIDTH - 225, 520, TEXT_RED),
        ]
        for pt_text, px, py, pc in panic_tags:
            bob = int(math.sin(t_scene * 6 + px) * 4)
            bbox = draw.textbbox((0, 0), pt_text, font=FONT_SUBTITLE)
            tw = bbox[2] - bbox[0] + 16
            draw.rectangle((px, py + bob, px + tw, py + bob + 38), fill='#090d16', outline=pc, width=2)
            draw.text((px + 8, py + bob + 6), pt_text, fill=pc, font=FONT_SUBTITLE)

        # DOODLE ONLY: Anime Flurry Barrage Punching Recommend
        tds.draw_dark_flurry_recommend(draw, 540, 1340, scale=1.15, t=t)

    else:
        # === SCENE 6: Bài Thi Trắc Nghiệm & Cái Kết (ONLY RemoteCLI branding) ===
        t_scene = t - 58.74
        cur_tab = 'Home-PC'
        unread_badge = 90

        tui.draw_mobile_header(draw, active_tab=cur_tab, url='vibexai.net')
        tui.draw_mobile_footer(draw, tokens=token_str, unread_count=unread_badge)

        if t_scene < 4.2:
            # Native Terminal Exam Container
            tds.draw_dark_exam_terminal(draw, 540, 560, scale=1.1, t=t_scene)

            # Rubber Stamp Slam at t_scene >= 1.8s
            if t_scene >= 1.8:
                stamp_box = (WIDTH - 420, 510, WIDTH - 60, 580)
                draw.rectangle(stamp_box, fill='#450a0a', outline='#ef4444', width=3)
                draw.text((WIDTH - 400, 526), "[ APPROVED - HITL ]", fill='#ef4444', font=FONT_BOLD)

            # DOODLE ONLY: Slumped Dev on ground
            tds.draw_dark_slumped_dev(draw, 540, 1060, scale=1.25, t=t)

            # Terminal Alert Box
            stamp_box = (60, 1260, WIDTH - 60, 1360)
            draw.rectangle(stamp_box, fill='#450a0a', outline='#ef4444', width=3)
            draw.text((80, 1290), "[!] BẬN HƠN CẢ KHI CHƯA CÓ AI! [!]", fill='#fca5a5', font=FONT_HERO)
        else:
            # Pure Terminal Box Outro (Strictly RemoteCLI only, NO links, NO author)
            card_box = (60, 480, WIDTH - 60, 930)
            draw.rectangle(card_box, fill='#090d16', outline='#0066FF', width=3)

            # Top terminal bar
            draw.rectangle((60, 480, WIDTH - 60, 540), fill='#161e2e')
            draw.text((85, 495), ">_ RemoteCLI", fill=TEXT_CYAN, font=FONT_HERO)
            draw.rectangle((WIDTH - 100, 500, WIDTH - 80, 520), fill='#22c55e')

            draw.text((85, 600), "[!] BẬN HƠN CẢ KHI CHƯA CÓ AI!", fill='#f87171', font=FONT_HERO)
            draw.text((85, 690), "Giải phóng chiếc máy tính của bạn,", fill='#ffffff', font=FONT_TITLE)
            draw.text((85, 750), "nhưng đừng để AI quản lý lại bạn!", fill=TEXT_CYAN, font=FONT_TITLE)

            draw.line([(60, 830), (WIDTH - 60, 830)], fill=BORDER_DARK, width=2)
            draw.text((85, 860), "STATUS: REMOTE ZERO-LATENCY ACTIVE", fill=TEXT_GREEN, font=FONT_BOLD)

            # DOODLE ONLY: Sitting Dev enjoying trà đá peacefully
            tds.draw_dark_dev(draw, 380, 1140, scale=1.3, pose='sitting_tra_da', t=t)
            tds.draw_dark_tra_da_table(draw, 750, 1140, scale=1.25, t=t)

    # ========================================================
    # TERMINAL SUBTITLE PROMPT (Positioned dynamically)
    # ========================================================
    sub_text, sub_keyword = get_current_subtitle(t)
    if sub_text:
        sub_y = 1540 if (39.69 <= t < 58.74) else 1450
        draw_terminal_subtitle(draw, sub_text, keyword=sub_keyword, y=sub_y)

    return im

def main():
    out_video = 'video/output/remote-cli-motion-terminal.mp4'
    soundtrack = 'video/assets/audio/soundtrack_master.wav'

    print(f"Starting terminal motion master video rendering to {out_video}...")
    t_start = time.time()

    cmd = [
        FFMPEG, '-y',
        '-f', 'rawvideo',
        '-vcodec', 'rawvideo',
        '-s', f'{WIDTH}x{HEIGHT}',
        '-pix_fmt', 'rgb24',
        '-r', str(FPS),
        '-i', '-',
        '-i', soundtrack,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '19',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        out_video
    ]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    for frame_idx in range(TOTAL_FRAMES):
        frame_img = render_frame(frame_idx)
        proc.stdin.write(frame_img.tobytes())

        if (frame_idx + 1) % 150 == 0 or frame_idx == TOTAL_FRAMES - 1:
            elapsed = time.time() - t_start
            fps_speed = (frame_idx + 1) / elapsed
            percent = (frame_idx + 1) / TOTAL_FRAMES * 100
            print(f"Rendered {frame_idx + 1}/{TOTAL_FRAMES} frames ({percent:.1f}%) - Speed: {fps_speed:.1f} fps")

    proc.stdin.close()
    stderr = proc.stderr.read()
    proc.wait()

    total_time = time.time() - t_start
    if proc.returncode == 0:
        file_size = os.path.getsize(out_video) / (1024 * 1024)
        print(f"SUCCESS: Rendered {out_video} ({file_size:.2f} MB) in {total_time:.1f}s")
    else:
        print(f"ERROR rendering video. Return code: {proc.returncode}")
        print(stderr.decode('utf-8', errors='ignore'))

if __name__ == '__main__':
    main()
