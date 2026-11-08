import os
import sys
import math
import subprocess
import time
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, 'video/src')
import ascii_anim_engine as aae

FFMPEG = 'C:/Users/tungh/AppData/Local/Programs/Python/Python310/lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe'

WIDTH = 1080
HEIGHT = 1920
FPS = 30
TOTAL_DURATION = 67.0
TOTAL_FRAMES = int(TOTAL_DURATION * FPS)

# Fonts (Consolas Monospace)
FONT_ASCII_HERO = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 32)
FONT_ASCII = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 26)
FONT_ASCII_SM = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 20)
FONT_ASCII_XS = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 16)

FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 34)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 26)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)

# Colors
BG_DARK = '#090d16'
TEXT_WHITE = '#f8fafc'
TEXT_GREEN = '#4ade80'
TEXT_CYAN = '#38bdf8'
TEXT_YELLOW = '#facc15'
TEXT_RED = '#f87171'
TEXT_PURPLE = '#c084fc'
TEXT_MUTED = '#94a3b8'

# Real Mockups (Untouched original images provided by user)
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
    # Scene 4
    (39.69, 43.5, "Từ 1 project, giờ bạn ôm cùng lúc 5-6 cái!", "5-6 PROJECTS"),
    (43.5, 47.68, "Hàng chục session nhảy liên tục từ sáng đến chiều...", "47 SESSIONS"),
    # Scene 5
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

def draw_ascii_lines(draw, lines, x, y, font=FONT_ASCII, color=TEXT_WHITE, line_height=32):
    for i, line in enumerate(lines):
        draw.text((x, y + i * line_height), line, fill=color, font=font)

def render_frame(frame_idx):
    t = frame_idx / FPS

    im = Image.new('RGB', (WIDTH, HEIGHT), BG_DARK)
    draw = ImageDraw.Draw(im)

    # Top Terminal Header (Scenes 1, 2, 3, 6)
    if t < 39.69 or t >= 58.74:
        top_bar = [
            "+======================================================+",
            "| >_ RemoteCLI Terminal • Host: [Home-PC] • Ping: 12ms |",
            "+======================================================+",
        ]
        draw_ascii_lines(draw, top_bar, 60, 40, font=FONT_ASCII, color=TEXT_CYAN, line_height=30)

    if t < 14.54:
        # === SCENE 1: Nghịch Lý AI & HITL ===
        pws_box = [
            ".------------------------------------------------------.",
            "| >_ Windows PowerShell (HITL Supervisor Active)       |",
            "'------------------------------------------------------'",
        ]
        draw_ascii_lines(draw, pws_box, 60, 130, font=FONT_ASCII, color=TEXT_CYAN, line_height=28)

        # Code lines typing progressively
        all_code_lines = [
            "$tokenBudget = 1000000; # Max quota burn",
            "while ($true) {",
            "    $agent = Invoke-ClaudeAgent -Loop Dynamic",
            "    if ($agent.NeedsApproval) {",
            "        Wait-For-Human-In-The-Loop -Timeout Infinite # Canh AI!",
            "    }",
            "}"
        ]
        vis_lines = min(len(all_code_lines), int(t * 1.5) + 2)
        code_to_draw = all_code_lines[:vis_lines]
        draw_ascii_lines(draw, code_to_draw, 80, 225, font=FONT_ASCII_SM, color=TEXT_GREEN, line_height=30)

        # Blinking cursor on latest code line
        if math.sin(t * 10) > 0 and vis_lines <= len(all_code_lines):
            cur_line_y = 225 + (vis_lines - 1) * 30
            cur_line_len = len(code_to_draw[-1])
            draw.rectangle((80 + cur_line_len * 12 + 4, cur_line_y + 2, 80 + cur_line_len * 12 + 16, cur_line_y + 22), fill=TEXT_GREEN)

        # Fully Animated ASCII Robot (radar, scanning eyes, waveform mouth, token bar, typing frenzy)
        robot_lines = aae.get_animated_robot(t)
        draw_ascii_lines(draw, robot_lines, 40, 470, font=FONT_ASCII, color=TEXT_GREEN, line_height=34)

        # Fully Animated Stressed Dev (EKG pulse, BPM, wild hair, sliding sweat, knock knees)
        dev_lines = aae.get_animated_stressed_dev(t)
        draw_ascii_lines(draw, dev_lines, 540, 470, font=FONT_ASCII, color=TEXT_RED, line_height=34)

        # Warning Banners popping up with narration
        if t >= 4.5:
            b1 = [
                "+======================================================+",
                "| [!] ĐỐT TOKEN NGÀY ĐÊM CHO ĐỠ PHÍ QUOTA!             |",
                "+======================================================+",
            ]
            draw_ascii_lines(draw, b1, 60, 1060, font=FONT_ASCII, color=TEXT_YELLOW, line_height=38)

        if t >= 10.0:
            b2 = [
                "+======================================================+",
                "| [!] CHUẨN HITL: PHẢI NGỒI CANH TỪNG LI TỪNG TÝ!      |",
                "+======================================================+",
            ]
            draw_ascii_lines(draw, b2, 60, 1180, font=FONT_ASCII, color=TEXT_RED, line_height=38)

    elif t < 27.43:
        # === SCENE 2: Remote Trà Đá Vỉa Hè ===
        t_scene = t - 14.54

        # Terminal Chat Session Box
        chat_lines = [
            "+------------------------------------------------------+",
            "| [23:26] Dev:    Ghé trà đá làm cốc đi anh em ơi!     |",
        ]
        if t_scene >= 3.5:
            chat_lines.append("| [23:26] Claude: Dạ em refactor xong 3 module rồi ạ!  |")
        if t_scene >= 6.0:
            chat_lines.append("| [23:27] Dev:    Chat AI sướng như nhắn tin với ghệ!  |")
        chat_lines.append("+------------------------------------------------------+")
        draw_ascii_lines(draw, chat_lines, 60, 130, font=FONT_ASCII, color=TEXT_CYAN, line_height=30)

        # Fully Animated Trà Đá Dev (4-frame foot tap, thumb typing, heart emissions)
        dev_trada = aae.get_animated_tra_da_dev(t)
        draw_ascii_lines(draw, dev_trada, 40, 480, font=FONT_ASCII, color=TEXT_CYAN, line_height=34)

        # Fully Animated Trà Đá Table (rising vapor smoke, bobbing ice cubes, sunflower seeds)
        table_trada = aae.get_animated_tra_da_table(t)
        draw_ascii_lines(draw, table_trada, 500, 480, font=FONT_ASCII, color=TEXT_YELLOW, line_height=34)

        # Punchline Banner
        if t_scene >= 8.5:
            punch_ascii = [
                "+======================================================+",
                "| [!] ĐANG YÊN ĐANG LÀNH TỰ NHIÊN GÁNH THÊM VIỆC!      |",
                "+======================================================+",
            ]
            draw_ascii_lines(draw, punch_ascii, 60, 1060, font=FONT_ASCII, color=TEXT_RED, line_height=38)

    elif t < 39.69:
        # === SCENE 3: Hồi Sinh Máy Cũ & Chuyển Máy 1 Tab ===
        t_scene = t - 27.43

        # Active tab switching
        if t_scene < 4.0:
            active_tab_str = "[HOME-PC]"
        elif t_scene < 8.0:
            active_tab_str = "[LAPTOP]"
        else:
            active_tab_str = "[CLOUD-VPS]"

        tab_switcher = [
            "+------------------------------------------------------+",
            f"| TABS: [Local]  ==> {active_tab_str} <==  [Cloud-VPS]  [PC-Lab]  |",
            "+------------------------------------------------------+",
        ]
        draw_ascii_lines(draw, tab_switcher, 60, 130, font=FONT_ASCII, color=TEXT_YELLOW, line_height=32)

        # Animated Multi-Device Cluster (oscilloscope, compile bar, LED blinkers, packet streams)
        ecosystem_lines = aae.get_animated_ecosystem(t)
        draw_ascii_lines(draw, ecosystem_lines, 60, 360, font=FONT_ASCII, color=TEXT_CYAN, line_height=34)

        if t_scene >= 4.0:
            banner_3 = [
                "+======================================================+",
                "| * ZERO-LATENCY MULTI-DEVICE TERMINAL MANAGER *       |",
                "+======================================================+",
            ]
            draw_ascii_lines(draw, banner_3, 60, 1060, font=FONT_ASCII, color=TEXT_GREEN, line_height=38)

    elif t < 47.68:
        # === SCENE 4: BÙNG NỔ 5-6 PROJECTS (REAL Screenshot 1) ===
        t_scene = t - 39.69

        # Drop shadow behind real image
        draw.rounded_rectangle((M_X - 8, M_Y - 8, M_X + M_W + 8, M_Y + M_H + 8), radius=28, fill='#040711', outline='#1e293b', width=3)

        # Paste REAL Image 1 (completely untouched original user screenshot)
        im.paste(SCALED_M1, (M_X, M_Y), SCALED_M1)

        # UAV Card is at y = 705..765 on original 1080h image
        uav_y = int(M_Y + 705 * MOCKUP_SCALE)
        uav_h = int(60 * MOCKUP_SCALE)

        # Animated Red/Yellow Target Bracket on UAV
        pulse_col = '#ef4444' if math.sin(t * 12) > 0 else '#facc15'
        draw.rounded_rectangle((M_X + 12, uav_y, M_X + M_W - 12, uav_y + uav_h), radius=10, outline=pulse_col, width=5)

        # Callout tag pointing directly to UAV
        draw.text((M_X + 20, uav_y - 34), "===> [!] UAV: 47 SESSIONS! <===", fill=TEXT_YELLOW, font=FONT_ASCII_SM)

        # Animated running dev on Left carrying [OTA]
        run_step = int(t * 8) % 2
        leg_l = "/ \\" if run_step == 0 else "| |"
        dev_run_left = [
            "  .---.",
            " (o_o;) [OTA]",
            " /| |\\",
            f"  {leg_l}  *run*",
        ]
        draw_ascii_lines(draw, dev_run_left, 10, 420, font=FONT_ASCII_XS, color=TEXT_CYAN, line_height=20)

        # Animated running dev on Right carrying [UAV]
        dev_run_right = [
            "  .---.",
            " (>_<;) [UAV]",
            " /| |\\",
            f"  {leg_l} *hot!*",
        ]
        draw_ascii_lines(draw, dev_run_right, WIDTH - 165, 420, font=FONT_ASCII_XS, color=TEXT_RED, line_height=20)

        # Animated laser scanner beam scanning up and down the session list
        scan_y = int(M_Y + 280 + (t_scene * 240) % 850)
        draw.line([(M_X + 10, scan_y), (M_X + M_W - 10, scan_y)], fill='#38bdf8', width=2)
        draw.text((M_X + 15, scan_y - 18), ">> SCANNING SESSIONS >>", fill=TEXT_CYAN, font=FONT_ASCII_XS)

        if t_scene >= 3.0:
            tot_tag = [
                "+-------------------------------------+",
                "| [!] TỔNG CỘNG: 57 SESSIONS ĐANG CHẠY|",
                "+-------------------------------------+",
            ]
            draw_ascii_lines(draw, tot_tag, (WIDTH - 440) // 2, 1450, font=FONT_ASCII_SM, color=TEXT_RED, line_height=24)

    elif t < 58.74:
        # === SCENE 5: PHÂN MẢNH CONTEXT & 90 TIN NHẮN (REAL Screenshot 2) ===
        t_scene = t - 47.68

        # Drop shadow behind real image
        draw.rounded_rectangle((M_X - 8, M_Y - 8, M_X + M_W + 8, M_Y + M_H + 8), radius=28, fill='#040711', outline='#1e293b', width=3)

        # Paste REAL Image 2 (completely untouched original user screenshot)
        im.paste(SCALED_M2, (M_X, M_Y), SCALED_M2)

        # Rotating crosshair reticle on 90 Unread Messages Badge (x = 176..215, y = 894..914)
        bx = int(M_X + 195 * MOCKUP_SCALE)
        by = int(M_Y + 904 * MOCKUP_SCALE)
        ret_r = 32 + int(math.sin(t * 14) * 4)
        draw.ellipse((bx - ret_r, by - 22, bx + ret_r, by + 22), outline='#ef4444', width=4)

        # Rotating tick marks
        rot_angle = t * 6
        dx = int(math.cos(rot_angle) * 45)
        dy = int(math.sin(rot_angle) * 25)
        draw.line([(bx - dx, by - dy), (bx + dx, by + dy)], fill='#ef4444', width=3)
        draw.line([(bx + dy, by - dx), (bx - dy, by + dx)], fill='#ef4444', width=3)

        draw.text((bx - 70, by - 70), "[ 90 TIN NHẮN! ]", fill=TEXT_RED, font=FONT_ASCII_SM)

        # Animated Chibi Panic Dev (spiral eyes spin, expanding ear steam)
        chibi_lines = aae.get_animated_chibi_overload(t)
        draw_ascii_lines(draw, chibi_lines, 10, 200, font=FONT_ASCII_XS, color=TEXT_YELLOW, line_height=20)

        # Floating Panic Tags on Right
        tags_r = [
            "+-----------+",
            "| [!] HITL? |",
            "| XIN QUYỀN?|",
            "+-----------+",
            "| CONFLICT! |",
            "+-----------+",
        ]
        draw_ascii_lines(draw, tags_r, WIDTH - 165, 200, font=FONT_ASCII_XS, color=TEXT_RED, line_height=20)

        # Animated Anime Flurry Barrage (6-frame multi-fist flurry, bouncing recommend button)
        fists = aae.get_animated_flurry_barrage(t)
        draw_ascii_lines(draw, fists, (WIDTH - 380) // 2, 1330, font=FONT_ASCII_SM, color=TEXT_CYAN, line_height=24)

    else:
        # === SCENE 6: Bài Thi Trắc Nghiệm HITL & Cái Kết ===
        t_scene = t - 58.74

        if t_scene < 4.2:
            # Interactive Exam Paper with animated pencil circling option C
            pencil_step = int(t * 8) % 4
            if pencil_step == 0:
                c_tag = "  || (C) Nhắm mắt BẤM RECOMMEND cho nhanh! (99%) ||  "
                pencil_pos = "           \\====> (pencil circling)"
            elif pencil_step == 1:
                c_tag = "  ||[(C)]Nhắm mắt BẤM RECOMMEND cho nhanh! (99%) ||  "
                pencil_pos = "       \\====> (circling...)"
            elif pencil_step == 2:
                c_tag = "  || ((C)) Nhắm mắt BẤM RECOMMEND cho nhanh! (99%)|| "
                pencil_pos = "   \\====> (circled!)"
            else:
                c_tag = "  ||**[C]**Nhắm mắt BẤM RECOMMEND cho nhanh! (99%)|| "
                pencil_pos = "              \\====> *CHECKED!*"

            exam_ascii = [
                "+======================================================+",
                "| [?] BÀI THI TRẮC NGHIỆM HITL (MÃ ĐỀ: 2026)           |",
                "+======================================================+",
                "| Câu 1: AI vừa xin quyền chạy script 2,000 dòng.      |",
                "| Bạn sẽ làm gì để đúng chuẩn Human-In-The-Loop?       |",
                "|                                                      |",
                "|   [A] Đọc kỹ từng dòng code (Mất 15 phút suy nghĩ)   |",
                "|   [B] Từ chối và tự tay viết lại từ đầu              |",
                "|  .================================================.  |",
                c_tag,
                "|  '================================================'  |",
                pencil_pos,
                "+======================================================+",
            ]
            draw_ascii_lines(draw, exam_ascii, 60, 130, font=FONT_ASCII, color=TEXT_WHITE, line_height=32)

            # Red Rubber Stamp slams down with impact lines at t_scene >= 2.0s
            if t_scene >= 2.0:
                stamp_ascii = [
                    "          \\ \\      |      / /",
                    "   .----------------------------------------------.",
                    "   |            APPROVED - HITL 10/10             |  *SLAM!*",
                    "   '----------------------------------------------'",
                    "          / /      |      \\ \\",
                ]
                draw_ascii_lines(draw, stamp_ascii, 60, 580, font=FONT_ASCII, color=TEXT_RED, line_height=34)

            # Animated Soul Ghost floating smoothly upward with undulating tail
            ghost_lines = aae.get_animated_soul_ghost(t)
            ghost_drift = int(math.sin(t_scene * 3) * 15)
            draw_ascii_lines(draw, ghost_lines, 60 + ghost_drift, 760, font=FONT_ASCII, color=TEXT_CYAN, line_height=30)

            # Slumped Dev on floor
            slump_lines = [
                "           _                         _",
                "          [=]     _.(x_x)._         [=]  (Kiệt sức...)",
                "         ===============================",
            ]
            draw_ascii_lines(draw, slump_lines, 60, 930, font=FONT_ASCII, color=TEXT_CYAN, line_height=32)

            banner_end = [
                "+======================================================+",
                "| [!] TỪ SÁNG ĐẾN ĐÊM CHỈ ĐỂ LÀM BÀI TRẮC NGHIỆM!      |",
                "+======================================================+",
            ]
            draw_ascii_lines(draw, banner_end, 60, 1080, font=FONT_ASCII, color=TEXT_YELLOW, line_height=38)

        else:
            # Outro Summary Card
            outro_ascii = [
                "+======================================================+",
                "|                BẬN HƠN CẢ KHI CHƯA CÓ AI!            |",
                "|                                                      |",
                "| RemoteCLI: Giải phóng chiếc máy tính của bạn,        |",
                "| nhưng đừng để AI quản lý lại bạn!                    |",
                "+======================================================+",
            ]
            draw_ascii_lines(draw, outro_ascii, 60, 240, font=FONT_ASCII, color=TEXT_YELLOW, line_height=36)

            # Sitting Dev enjoying trà đá peacefully with foot tap
            dev_outro = aae.get_animated_tra_da_dev(t)
            draw_ascii_lines(draw, dev_outro, 40, 680, font=FONT_ASCII, color=TEXT_CYAN, line_height=34)

            table_outro = aae.get_animated_tra_da_table(t)
            draw_ascii_lines(draw, table_outro, 500, 680, font=FONT_ASCII, color=TEXT_YELLOW, line_height=34)

            cta_ascii = [
                "+======================================================+",
                "| >> GitHub: github.com/tunghuynh/remote-cli <<        |",
                "+======================================================+",
            ]
            draw_ascii_lines(draw, cta_ascii, 60, 1180, font=FONT_ASCII, color=TEXT_GREEN, line_height=38)

    # ========================================================
    # DYNAMIC SUBTITLE CARD (Floating above bottom edge)
    # ========================================================
    sub_text, sub_keyword = get_current_subtitle(t)
    if sub_text:
        sub_top = 1540 if (39.69 <= t < 58.74) else 1440
        sub_box = (60, sub_top, WIDTH - 60, sub_top + 130)
        draw.rounded_rectangle(sub_box, radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        if sub_keyword:
            kw_w = len(sub_keyword) * 18 + 24
            draw.rounded_rectangle((85, sub_top + 15, 85 + kw_w, sub_top + 48), radius=8, fill='#1e293b', outline=TEXT_YELLOW, width=2)
            draw.text((95, sub_top + 20), sub_keyword, fill=TEXT_YELLOW, font=FONT_SM)
            draw.text((85, sub_top + 62), sub_text, fill='#ffffff', font=FONT_TITLE)
        else:
            draw.text((85, sub_top + 42), sub_text, fill='#ffffff', font=FONT_TITLE)

    return im

def main():
    out_video = 'video/output/remote-cli-ascii-terminal.mp4'
    soundtrack = 'video/assets/audio/soundtrack_master.wav'

    print(f"Starting ASCII Terminal Animated Video rendering to {out_video}...")
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
